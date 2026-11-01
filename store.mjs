import { open, readFile, rename, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const BOARDS = ['game1', 'game2'];
export class ValidationError extends Error {}

function validateBoard(board) {
  if (!BOARDS.includes(board)) throw new ValidationError('Unknown board');
}

export function validateSubmission(initials, score) {
  if (typeof initials !== 'string' || !/^[A-Z]{3}$/.test(initials)) {
    throw new ValidationError('Initials must be exactly three uppercase letters');
  }
  if (!Number.isInteger(score) || score < 1 || score > 999_999_999) {
    throw new ValidationError('Score must be an integer from 1 to 999999999');
  }
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateEntries(scores) {
  if (!Array.isArray(scores)) throw new ValidationError('Scores must be an array');
  return scores.map(entry => {
    validateSubmission(entry?.initials, entry?.score);
    if (!validDate(entry.createdAt)) throw new ValidationError('Invalid createdAt');
    return { initials: entry.initials, score: entry.score, createdAt: entry.createdAt };
  });
}

function compare(a, b) {
  return b.score - a.score || a.createdAt.localeCompare(b.createdAt);
}

function aggregate(data) {
  return { updatedAt: data.updatedAt, boards: data.boards };
}

// Sync before rename, then sync the directory so a completed write survives a reboot.
export async function atomicJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await rm(temporary, { force: true });
  }
}

export class ScoreStore {
  #queue = Promise.resolve();

  constructor(directory) {
    this.directory = directory;
    this.stateFile = path.join(directory, 'state.json');
    this.aggregateFile = path.join(directory, 'scores.json');
  }

  exclusive(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  async initialize() {
    return this.exclusive(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        await readFile(this.stateFile);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // A missing canonical file must not erase an existing public snapshot.
        try {
          await readFile(this.aggregateFile);
          throw new Error('state.json is missing but scores.json exists; restore state.json from backup');
        } catch (snapshotError) {
          if (snapshotError.code !== 'ENOENT') throw snapshotError;
        }
        await atomicJson(this.stateFile, {
          version: 1, updatedAt: new Date().toISOString(),
          boards: { game1: [], game2: [] }, imported: [],
        });
      }
      await this.read();
    });
  }

  async read() {
    const source = await readFile(this.stateFile, 'utf8');
    let data;
    try {
      data = JSON.parse(source);
      if (data?.version !== 1 || !validDate(data.updatedAt)
          || !Array.isArray(data.imported) || data.imported.some(board => !BOARDS.includes(board))
          || new Set(data.imported).size !== data.imported.length) throw new Error();
      for (const board of BOARDS) {
        const scores = validateEntries(data.boards?.[board]);
        if (scores.length > 10 || scores.some((entry, i) => i && compare(scores[i - 1], entry) > 0)) {
          throw new Error();
        }
      }
    } catch {
      throw new Error(`Invalid score state: ${this.stateFile}`);
    }
    // Repair a crash between the canonical commit and publication, without changing updatedAt.
    const expected = JSON.stringify(aggregate(data), null, 2) + '\n';
    let existing;
    try { existing = await readFile(this.aggregateFile, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing !== expected) await atomicJson(this.aggregateFile, aggregate(data));
    return data;
  }

  async commit(data) {
    data.updatedAt = new Date().toISOString();
    await atomicJson(this.stateFile, data);
    await atomicJson(this.aggregateFile, aggregate(data));
  }

  snapshot() {
    return this.exclusive(async () => aggregate(await this.read()));
  }

  list(board) {
    validateBoard(board);
    return this.exclusive(async () => (await this.read()).boards[board]);
  }

  submit(board, initials, score) {
    validateBoard(board);
    validateSubmission(initials, score);
    return this.exclusive(async () => {
      const data = await this.read();
      const scores = data.boards[board];
      if (scores.length === 10 && score <= scores[9].score) return { accepted: false, scores };
      data.boards[board] = [...scores, { initials, score, createdAt: new Date().toISOString() }]
        .sort(compare).slice(0, 10);
      await this.commit(data);
      return { accepted: true, scores: data.boards[board] };
    });
  }

  remove(board, entry) {
    validateBoard(board);
    validateSubmission(entry?.initials, entry?.score);
    if (!validDate(entry.createdAt)) throw new ValidationError('Invalid createdAt');
    return this.exclusive(async () => {
      const data = await this.read();
      const scores = data.boards[board];
      const index = scores.findIndex(score => score.initials === entry.initials
        && score.score === entry.score && score.createdAt === entry.createdAt);
      if (index === -1) return { removed: false, scores };
      scores.splice(index, 1);
      await this.commit(data);
      return { removed: true, scores };
    });
  }

  import(board, source) {
    validateBoard(board);
    // Game2 deliberately retired its mixed-route scores when Story mode became the board.
    validateEntries(source?.scores);
    const scores = validateEntries(board === 'game1' ? source.scores
      : (source.storyScores === undefined ? [] : source.storyScores));
    return this.exclusive(async () => {
      const data = await this.read();
      if (data.imported.includes(board)) throw new ValidationError('Board has already been imported');
      if (data.boards[board].length) throw new ValidationError('Import requires an empty board');
      data.boards[board] = scores.sort(compare).slice(0, 10);
      data.imported.push(board);
      await this.commit(data);
      return { scores: data.boards[board] };
    });
  }
}
