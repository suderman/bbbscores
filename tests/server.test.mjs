import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScoreStore } from '../store.mjs';
import { createPublicServer, isAllowedOrigin, DEFAULT_ORIGINS, createRateLimiter, clientAddress } from '../server.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bbbscores-http-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ScoreStore(directory);
  await store.initialize();
  const server = createPublicServer(store, { rateLimit: 1000, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (board, body = { initials: 'API', score: 123 }, headers = {}) => fetch(`${url}/${board}/high-scores`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { url, post, store };
}

test('exact wire shapes for both boards, independent data, health, aggregate cache and route boundaries', async t => {
  const { url, post } = await fixture(t);
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await health.json(), { ok: true });
  for (const board of ['game1', 'game2']) {
    const get = await fetch(`${url}/${board}/high-scores`);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await get.json(), { scores: [] });
    const result = await post(board);
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.deepEqual(Object.keys(data).sort(), ['accepted', 'scores']);
    assert.equal(data.accepted, true);
    assert.equal(data.scores[0].score, 123);
    assert.deepEqual(Object.keys(data.scores[0]).sort(), ['createdAt', 'initials', 'score']);
  }
  const aggregate = await fetch(`${url}/scores.json`, { headers: { Origin: 'https://boomboombaby.ca' } });
  assert.equal(aggregate.status, 200);
  assert.equal(aggregate.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(aggregate.headers.get('access-control-allow-origin'), 'https://boomboombaby.ca');
  assert.deepEqual(Object.keys(await aggregate.json()).sort(), ['boards', 'updatedAt']);
  assert.equal(await (await fetch(`${url}/scores.json`, { method: 'HEAD' })).text(), '');
  for (const route of ['/api/high-scores', '/game3/high-scores', '/admin', '/state.json', '/admin.sock', '/']) {
    assert.equal((await fetch(url + route)).status, 404);
  }
  for (const [route, method, allow] of [['/game1/high-scores', 'DELETE', 'GET, POST'], ['/scores.json', 'POST', 'GET, HEAD']]) {
    const response = await fetch(url + route, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), allow);
  }
});

test('HTTP validation, body byte bound, error shape, and nonqualifying HTTP 200', async t => {
  const { post } = await fixture(t);
  for (const body of ['not json', '[]', 'null', '1', '{}', ' '.repeat(10_001),
    { initials: 'bad', score: 123 }, { initials: 'AAA', score: '123' }, { initials: 'AAA', score: 1e9 }]) {
    const response = await post('game1', body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  // Each non-ASCII character is multiple bytes, not one byte of the request limit.
  assert.equal((await post('game1', JSON.stringify({ padding: 'é'.repeat(6000) }))).status, 400);
  for (let i = 1; i <= 10; i++) assert.equal((await post('game1', { initials: 'AAA', score: i })).status, 200);
  const result = await post('game1', { initials: 'LOW', score: 1 });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).accepted, false);
});

test('CORS exact origins and HTTPS itch subdomains reject suffix, port, credentials and null tricks', async t => {
  for (const origin of [
    'https://game1.boomboombaby.ca', 'https://game2.boomboombaby.ca',
    'https://boomboombaby.ca', 'https://html-classic.itch.zone', 'https://a.b.itch.zone',
  ]) assert.equal(isAllowedOrigin(origin, DEFAULT_ORIGINS), true, origin);
  const rejected = [
    'null', 'https://itch.zone', 'https://evilitch.zone', 'https://html.itch.zone.evil.test',
    'http://html.itch.zone', 'https://html.itch.zone:8080', 'https://boomboombaby.ca.evil.test',
    'https://user@html.itch.zone', 'https://html.itch.zone/', 'file://html.itch.zone',
  ];
  for (const origin of rejected) assert.equal(isAllowedOrigin(origin, DEFAULT_ORIGINS), false, origin);
  const { url, post, store } = await fixture(t);
  for (const origin of DEFAULT_ORIGINS.slice(0, 3).concat('https://html-classic.itch.zone')) {
    const options = await fetch(`${url}/game1/high-scores`, {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), origin);
    assert.equal(options.headers.get('access-control-allow-methods'), 'GET, POST');
    assert.equal(options.headers.get('access-control-allow-headers'), 'Content-Type');
    const result = await post('game1', undefined, { Origin: origin });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('access-control-allow-origin'), origin);
    assert.equal(result.headers.get('vary'), 'Origin');
  }
  const before = await store.snapshot();
  for (const origin of rejected) {
    const result = await post('game1', undefined, { Origin: origin });
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  assert.deepEqual(await store.snapshot(), before);
  assert.equal((await fetch(`${url}/game1/high-scores`, { method: 'OPTIONS', headers: { Origin: 'null' } })).status, 405);
  const read = await fetch(`${url}/game1/high-scores`, { headers: { Origin: 'https://other.test' } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('access-control-allow-origin'), null);
  assert.equal((await post('game2')).status, 200); // CLI/non-browser callers need no Origin.
  const custom = await fixture(t, { allowedOrigins: ['http://localhost:5173'] });
  assert.equal((await custom.post('game1', undefined, { Origin: 'http://localhost:5173' })).status, 200);
  assert.equal((await custom.post('game1', undefined, { Origin: 'https://game1.boomboombaby.ca' })).status, 403);
});

test('rate limiter has exact expiry, bounded keys and no eviction bypass (fake clock)', () => {
  let time = 1000;
  const check = createRateLimiter({ limit: 2, windowMs: 2000, maxKeys: 2, now: () => time });
  assert.equal(check('one'), 0);
  assert.equal(check('one'), 0);
  assert.equal(check('one'), 2);
  assert.equal(check('two'), 0);
  assert.equal(check('three'), 2);
  time = 2999;
  assert.equal(check('one'), 1);
  time = 3000;
  assert.equal(check('three'), 0);
  assert.equal(check('one'), 0);
});

test('submission quotas span boards, count invalid attempts, preserve CORS and trust only configured loopback IP header', async t => {
  const { post, url } = await fixture(t, { rateLimit: 2, clientIpHeader: 'x-real-ip' });
  const headers = { 'X-Real-IP': '192.0.2.1', Origin: 'https://game1.boomboombaby.ca' };
  assert.equal((await post('game1', 'bad json', headers)).status, 400);
  assert.equal((await post('game2', undefined, headers)).status, 200);
  const limited = await post('game1', undefined, headers);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal(limited.headers.get('access-control-allow-origin'), headers.Origin);
  assert.equal((await post('game1', undefined, { 'X-Real-IP': '192.0.2.2' })).status, 200);
  assert.equal((await fetch(`${url}/game1/high-scores`, { headers })).status, 200);
  const request = (remoteAddress, header) => ({ socket: { remoteAddress }, headers: { 'x-real-ip': header } });
  assert.equal(clientAddress(request('198.51.100.1', '192.0.2.1'), 'x-real-ip'), '198.51.100.1');
  assert.equal(clientAddress(request('127.0.0.1', '192.0.2.1'), ''), '127.0.0.1');
  assert.equal(clientAddress(request('::1', '192.0.2.1, 192.0.2.2'), 'x-real-ip'), '::1');
  assert.equal(clientAddress(request('::ffff:127.0.0.1', '2001:db8::1'), 'x-real-ip'), '2001:db8::1');
  const untrusted = await fixture(t, { rateLimit: 1 });
  assert.equal((await untrusted.post('game1', undefined, { 'X-Real-IP': '192.0.2.1' })).status, 200);
  assert.equal((await untrusted.post('game1', undefined, { 'X-Real-IP': '192.0.2.2' })).status, 429);
});

test('concurrent HTTP submissions persist; corrupted state returns 500 and health 503 without loss', async t => {
  const { post, store, url } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => post('game2', { initials: 'AAA', score: i + 1 })));
  assert.ok(responses.every(response => response.status === 200));
  assert.deepEqual((await store.list('game2')).map(s => s.score), [20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
  await writeFile(store.stateFile, 'corrupt fixture');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  assert.equal((await fetch(`${url}/health`)).status, 503);
  assert.equal((await post('game2')).status, 500);
  assert.equal(errors.length, 2);
});
