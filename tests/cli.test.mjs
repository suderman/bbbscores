import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startService, adminRequest } from '../cli.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const createdAt = '2026-10-01T00:00:00.000Z';
const entry = { initials: 'IMP', score: 321, createdAt };

async function directory() {
  return mkdtemp(path.join(tmpdir(), 'bbbscores-cli-fixture-'));
}

async function command(root, ...args) {
  const { stdout } = await execute(process.execPath, [cli, ...args], {
    env: { ...process.env, STATE_DIRECTORY: root },
  });
  try { return JSON.parse(stdout); }
  catch (error) { throw new Error('Invalid fixture CLI output', { cause: error }); }
}

test('actual admin CLI lists, imports and removes while the single writer is running', async t => {
  const root = await directory();
  const service = await startService(root, { port: 0 });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const socket = path.join(root, 'admin.sock');
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(root, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.deepEqual(await command(root, 'list', 'game1'), { scores: [] });
  const source = path.join(root, 'import-fixture.json');
  await writeFile(source, JSON.stringify({ scores: [entry], storyScores: [{ ...entry, score: 50 }] }));
  assert.deepEqual(await command(root, 'import', 'game1', source), { scores: [entry] });
  assert.equal((await command(root, 'import', 'game2', source)).scores[0].score, 50);
  assert.deepEqual(await command(root, 'list', 'game1'), { scores: [entry] });
  await assert.rejects(command(root, 'import', 'game1', source), /already been imported/);
  assert.equal((await command(root, 'remove', 'game1', 'IMP', '321', createdAt)).removed, true);
  assert.equal((await command(root, 'remove', 'game1', 'IMP', '321', createdAt)).removed, false);
  const base = `http://127.0.0.1:${service.server.address().port}`;
  assert.deepEqual((await (await fetch(`${base}/scores.json`)).json()).boards.game1, []);
  await assert.rejects(adminRequest(socket, { action: 'delete-all', board: 'game1' }), /Unknown admin action/);
  await assert.rejects(command(root, 'list', 'unknown'), /Usage/);
  await writeFile(source, 'not JSON');
  await assert.rejects(command(root, 'import', 'game1', source), /must be valid JSON/);
  await assert.rejects(startService(root, { port: 0 }), /Another bbbscores process/);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('public submissions and admin changes share one queue; repeat removal cannot delete a different score', async t => {
  const root = await directory();
  const service = await startService(root, { port: 0, rateLimit: 100 });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const socket = path.join(root, 'admin.sock');
  await adminRequest(socket, { action: 'import', board: 'game1', source: { scores: [entry] } });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const [removed, ...responses] = await Promise.all([
    adminRequest(socket, { action: 'remove', board: 'game1', entry }),
    ...Array.from({ length: 10 }, (_, i) => fetch(`${base}/game1/high-scores`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initials: 'NEW', score: i + 1 }),
    })),
  ]);
  assert.equal(removed.removed, true);
  assert.ok(responses.every(response => response.status === 200));
  const data = await command(root, 'list', 'game1');
  assert.deepEqual(data.scores.map(s => s.score), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal((await adminRequest(socket, { action: 'remove', board: 'game1', entry })).removed, false);
});

test('fixture child processes survive abrupt restart, reclaim only stale sockets, and stop gracefully', async t => {
  const root = await directory();
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  async function launch() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      process.title = 'bbbscores-restart-fixture';
      const { run } = await import(${JSON.stringify(new URL('../cli.mjs', import.meta.url).href)});
      const service = await run(['serve']);
      process.send(service.server.address());
      process.disconnect();
    `], {
      env: { ...process.env, STATE_DIRECTORY: root, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    const [address] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code, signal]) => { throw new Error(`Fixture exited before readiness: ${code}/${signal}`); }),
    ]);
    return { child, base: `http://127.0.0.1:${address.port}` };
  }
  const first = await launch();
  const response = await fetch(`${first.base}/game2/high-scores`, {
    method: 'POST', body: JSON.stringify({ initials: 'OLD', score: 777 }),
  });
  assert.equal(response.status, 200);
  const persisted = await response.json();
  const killed = once(first.child, 'exit');
  first.child.kill('SIGKILL');
  await killed;
  assert.equal((await stat(path.join(root, 'admin.sock'))).isSocket(), true);
  const second = await launch();
  assert.deepEqual(await (await fetch(`${second.base}/game2/high-scores`)).json(), { scores: persisted.scores });
  const stopped = once(second.child, 'exit');
  second.child.kill('SIGTERM');
  assert.deepEqual(await stopped, [0, null]);
  await assert.rejects(stat(path.join(root, 'admin.sock')), { code: 'ENOENT' });
  await writeFile(path.join(root, 'admin.sock'), 'not a socket fixture');
  await assert.rejects(startService(root, { port: 0 }), /Not a socket/);
});

test('startup failures release the admin socket and bad configuration exits nonzero', async t => {
  const root = await directory();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'state.json'), 'corrupt fixture');
  await assert.rejects(startService(root, { port: 0 }), /Invalid score state/);
  await assert.rejects(stat(path.join(root, 'admin.sock')), { code: 'ENOENT' });
  for (const env of [{ PORT: 'NaN' }, { RATE_LIMIT: '0' }, { RATE_WINDOW_MS: '-1' }, { CLIENT_IP_HEADER: 'bad header' }]) {
    await assert.rejects(execute(process.execPath, [cli, 'serve'], { env: { ...process.env, STATE_DIRECTORY: root, ...env } }));
  }
  await assert.rejects(command(root, 'list', 'game1'), /ENOENT/);
});
