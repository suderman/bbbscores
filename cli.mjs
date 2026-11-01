#!/usr/bin/env node
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { ScoreStore, BOARDS } from './store.mjs';
import { createPublicServer, createAdminServer, DEFAULT_ORIGINS } from './server.mjs';

const usage = `Usage:
  bbbscores serve
  bbbscores list <game1|game2>
  bbbscores remove <game1|game2> <ABC> <score> <createdAt>
  bbbscores import <game1|game2> <file.json>
Set STATE_DIRECTORY for both server and admin commands (default: ./data).`;

function integer(value, fallback, name, minimum, maximum) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

async function clearStaleSocket(socketPath) {
  let info;
  try { info = await lstat(socketPath); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isSocket()) throw new Error(`Not a socket: ${socketPath}`);
  await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`Another bbbscores process is using ${socketPath}`));
    });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
  await rm(socketPath);
}

export async function startService(directory, options = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const socketPath = path.join(directory, 'admin.sock');
  const store = new ScoreStore(directory);
  const admin = createAdminServer(store);
  const server = createPublicServer(store, options);
  await clearStaleSocket(socketPath);
  // Bind before opening state; an already-running writer makes startup fail.
  admin.listen(socketPath);
  await once(admin, 'listening');
  try {
    await chmod(socketPath, 0o600);
    await store.initialize();
    server.listen(options.port ?? 3000, options.host ?? '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    await new Promise(resolve => admin.close(resolve));
    throw error;
  }
  const close = async () => {
    await Promise.all([server, admin].map(instance => new Promise((resolve, reject) => {
      instance.close(error => error ? reject(error) : resolve());
    })));
  };
  return { server, admin, store, close };
}

export function adminRequest(socketPath, body) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let source = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { source += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        let data;
        try { data = JSON.parse(source); }
        catch { reject(new Error('Invalid admin response')); return; }
        if (res.statusCode !== 200) reject(new Error(data.error ?? `Admin request failed (${res.statusCode})`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Admin request timed out')));
    req.end(JSON.stringify(body));
  });
}

export async function run(args = process.argv.slice(2), env = process.env) {
  const [action, board, ...rest] = args;
  const directory = path.resolve(env.STATE_DIRECTORY ?? 'data');
  if (action === 'serve' && args.length === 1) {
    const clientIpHeader = (env.CLIENT_IP_HEADER ?? '').toLowerCase();
    if (clientIpHeader && !/^[a-z0-9-]+$/.test(clientIpHeader)) throw new Error('Invalid CLIENT_IP_HEADER');
    const service = await startService(directory, {
      host: env.HOST ?? '127.0.0.1',
      port: integer(env.PORT, 3000, 'PORT', 0, 65535),
      allowedOrigins: env.ALLOWED_ORIGINS === undefined ? DEFAULT_ORIGINS
        : env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean),
      clientIpHeader,
      rateLimit: integer(env.RATE_LIMIT, 10, 'RATE_LIMIT', 1, 1_000_000),
      rateWindowMs: integer(env.RATE_WINDOW_MS, 60_000, 'RATE_WINDOW_MS', 1, 86_400_000),
    });
    console.log(`bbbscores listening on ${JSON.stringify(service.server.address())}; state: ${directory}`);
    const stop = async () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      await service.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return service;
  }
  if (!BOARDS.includes(board)) throw new Error(usage);
  let body;
  if (action === 'list' && rest.length === 0) body = { action, board };
  else if (action === 'remove' && rest.length === 3) {
    body = { action, board, entry: { initials: rest[0], score: Number(rest[1]), createdAt: rest[2] } };
  } else if (action === 'import' && rest.length === 1) {
    const source = await readFile(rest[0], 'utf8');
    try { body = { action, board, source: JSON.parse(source) }; }
    catch { throw new Error('Import file must be valid JSON'); }
  } else throw new Error(usage);
  const result = await adminRequest(path.join(directory, 'admin.sock'), body);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
