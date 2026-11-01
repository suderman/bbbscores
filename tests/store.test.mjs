import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScoreStore, ValidationError, atomicJson } from '../store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bbbscores-store-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ScoreStore(directory);
  await store.initialize();
  return { directory, store };
}

async function json(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read fixture JSON: ${file}`, { cause: error }); }
}

const entry = (score, initials = 'AAA', createdAt = '2026-10-01T00:00:00.000Z') => ({ initials, score, createdAt });

test('initializes both boards, validates exact types and bounds, and preserves wire records', async t => {
  const { store } = await fixture(t);
  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.boards, { game1: [], game2: [] });
  assert.ok(Number.isFinite(Date.parse(snapshot.updatedAt)));
  for (const [initials, score] of [
    ['AB', 1], ['abcd', 1], ['abc', 1], ['A!A', 1], [null, 1], [123, 1],
    ['AAA', 0], ['AAA', -1], ['AAA', 1.5], ['AAA', Infinity], ['AAA', NaN],
    ['AAA', 1_000_000_000], ['AAA', '100'], ['AAA', null],
  ]) {
    assert.throws(() => store.submit('game1', initials, score), ValidationError);
  }
  assert.throws(() => store.list('unknown'), ValidationError);
  for (const board of ['game1', 'game2']) {
    const first = await store.submit(board, 'MIN', 1);
    assert.equal(first.accepted, true);
    assert.deepEqual(Object.keys(first.scores[0]).sort(), ['createdAt', 'initials', 'score']);
    assert.equal((await store.submit(board, 'MAX', 999_999_999)).scores[0].score, 999_999_999);
  }
});

test('concurrent writes across boards keep top ten, incumbent ties, and matching aggregate', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 40 }, (_, i) => store.submit(i % 2 ? 'game1' : 'game2', 'AAA', i + 1)));
  assert.deepEqual((await store.list('game1')).map(s => s.score), [40, 38, 36, 34, 32, 30, 28, 26, 24, 22]);
  assert.deepEqual((await store.list('game2')).map(s => s.score), [39, 37, 35, 33, 31, 29, 27, 25, 23, 21]);
  const before = await readFile(store.aggregateFile, 'utf8');
  assert.equal((await store.submit('game1', 'LOW', 22)).accepted, false);
  assert.equal(await readFile(store.aggregateFile, 'utf8'), before);
  const tied = await store.submit('game1', 'TIE', 40);
  assert.equal(tied.scores[0].initials, 'AAA');
  assert.equal(tied.scores[1].initials, 'TIE');
  assert.deepEqual(await json(store.aggregateFile), await store.snapshot());
  const restarted = new ScoreStore(store.directory);
  await restarted.initialize();
  assert.deepEqual(await restarted.snapshot(), await store.snapshot());
  assert.deepEqual((await readdir(store.directory)).sort(), ['scores.json', 'state.json']);
});

test('imports each active board once, sorts ties by timestamp, and never imports game2 legacy scores', async t => {
  const { store } = await fixture(t);
  const imported = await store.import('game1', {
    scores: [entry(50, 'NEW', '2026-10-02T00:00:00.000Z'), entry(50, 'OLD'), entry(1)],
  });
  assert.deepEqual(imported.scores.map(s => s.initials), ['OLD', 'NEW', 'AAA']);
  await store.import('game2', { scores: [entry(999)], storyScores: [entry(20, 'STY')] });
  assert.equal((await store.list('game2'))[0].initials, 'STY');
  await assert.rejects(store.import('game1', { scores: [] }), /already been imported/);
  for (const row of imported.scores) await store.remove('game1', row);
  const restarted = new ScoreStore(store.directory);
  await restarted.initialize();
  await assert.rejects(restarted.import('game1', { scores: [entry(1)] }), /already been imported/);
  assert.deepEqual(await json(store.aggregateFile), await restarted.snapshot());
});

test('old game2 files import an empty Story board; bad or nonempty imports leave state alone', async t => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.import('game2', { scores: [entry(999)] }), { scores: [] });
  await store.submit('game1', 'NEW', 3);
  const before = await readFile(store.stateFile, 'utf8');
  await assert.rejects(store.import('game1', { scores: [] }), /empty board/);
  for (const source of [{}, { scores: 'bad' }, { scores: [entry(-1)] }, { scores: [entry(1, 'AAA', 'never')] }]) {
    assert.throws(() => store.import('game1', source), ValidationError);
  }
  assert.equal(await readFile(store.stateFile, 'utf8'), before);
});

test('malformed Story scores are rejected rather than consuming the one-time import', async t => {
  const { store } = await fixture(t);
  for (const storyScores of [null, 'bad', {}, [{ initials: 'BAD', score: -1, createdAt: 'never' }]]) {
    await assert.rejects(async () => store.import('game2', { scores: [], storyScores }), ValidationError);
  }
  assert.deepEqual((await json(store.stateFile)).imported, []);
  assert.equal((await store.import('game2', { scores: [], storyScores: [entry(1)] })).scores.length, 1);
});

test('import caps at ten, validates the full source, and removal matches the full record', async t => {
  const { store } = await fixture(t);
  const source = { scores: Array.from({ length: 12 }, (_, i) => entry(i + 1)) };
  const result = await store.import('game1', source);
  assert.deepEqual(result.scores.map(s => s.score), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  assert.equal((await store.remove('game1', entry(12, 'BBB'))).removed, false);
  assert.equal((await store.remove('game1', entry(12))).removed, true);
  assert.equal((await store.remove('game1', entry(12))).removed, false);
  assert.equal((await json(store.aggregateFile)).boards.game1.length, 9);
  const restarted = new ScoreStore(store.directory);
  await restarted.initialize();
  assert.deepEqual(await restarted.list('game1'), await store.list('game1'));
});

test('corrupt and missing canonical state fail closed without replacing data; queue recovers', async t => {
  const { store } = await fixture(t);
  const original = await readFile(store.stateFile, 'utf8');
  const snapshot = await readFile(store.aggregateFile, 'utf8');
  const valid = await json(store.stateFile);
  const variants = [
    'not json', '{}', JSON.stringify({ ...valid, imported: ['unknown'] }),
    JSON.stringify({ ...valid, boards: { game1: [entry(-1)], game2: [] } }),
    JSON.stringify({ ...valid, boards: { game1: [entry(1), entry(2)], game2: [] } }),
  ];
  for (const source of variants) {
    await writeFile(store.stateFile, source);
    await assert.rejects(store.snapshot(), /Invalid score state/);
    await assert.rejects(store.submit('game1', 'NEW', 10), /Invalid score state/);
    await assert.rejects(new ScoreStore(store.directory).initialize(), /Invalid score state/);
    assert.equal(await readFile(store.stateFile, 'utf8'), source);
    assert.equal(await readFile(store.aggregateFile, 'utf8'), snapshot);
  }
  await rm(store.stateFile);
  await assert.rejects(new ScoreStore(store.directory).initialize(), /restore state.json/);
  await writeFile(store.stateFile, original);
  assert.equal((await store.submit('game1', 'NEW', 10)).accepted, true);
});

test('stale or missing aggregate is repaired, including a failed publication after canonical commit', async t => {
  const { store } = await fixture(t);
  await store.submit('game2', 'YES', 123);
  const snapshot = await store.snapshot();
  await writeFile(store.aggregateFile, '{"stale":true}');
  await new ScoreStore(store.directory).initialize();
  assert.deepEqual(await json(store.aggregateFile), snapshot);
  await rm(store.aggregateFile);
  assert.deepEqual(await store.snapshot(), snapshot);
  const data = await json(store.stateFile);
  data.boards.game1 = [entry(500)];
  // Real filesystem failure at publication, not a fake fs implementation.
  await rm(store.aggregateFile);
  await mkdir(store.aggregateFile);
  await assert.rejects(store.commit(data), { code: 'EISDIR' });
  assert.deepEqual((await json(store.stateFile)).boards.game1, [entry(500)]);
  await rm(store.aggregateFile, { recursive: true });
  const restarted = new ScoreStore(store.directory);
  await restarted.initialize();
  assert.deepEqual((await restarted.snapshot()).boards.game1, [entry(500)]);
  assert.equal((await readdir(store.directory)).some(name => name.endsWith('.tmp')), false);
});

test('atomic publication never exposes partial JSON to concurrent readers', async t => {
  const { store } = await fixture(t);
  const writes = Promise.all(Array.from({ length: 30 }, (_, i) => store.submit('game1', 'AAA', i + 1)));
  for (let i = 0; i < 50; i++) {
    const data = await json(store.aggregateFile);
    assert.ok(data.boards.game1.length <= 10);
  }
  await writes;
  await assert.rejects(atomicJson(path.join(store.directory, 'missing', 'data.json'), {}), { code: 'ENOENT' });
  assert.equal((await store.list('game1'))[0].score, 30);
});
