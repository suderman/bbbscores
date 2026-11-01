import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { ValidationError } from './store.mjs';

export const DEFAULT_ORIGINS = [
  'https://game1.boomboombaby.ca', 'https://game2.boomboombaby.ca',
  'https://boomboombaby.ca', 'https://*.itch.zone',
];

export function isAllowedOrigin(origin, allowedOrigins) {
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin !== origin) return false;
  return allowedOrigins.some(entry => {
    const [scheme, suffix] = entry.split('://*.');
    return suffix === undefined ? entry === origin
      : url.protocol === `${scheme}:` && url.port === '' && url.hostname.endsWith(`.${suffix}`);
  });
}

export function clientAddress(request, clientIpHeader) {
  const peer = request.socket.remoteAddress;
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const forwarded = clientIpHeader && request.headers[clientIpHeader];
  // Trust only a single IP supplied by a local reverse proxy, never an X-Forwarded-For chain.
  if (loopback && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return peer;
}

export function createRateLimiter({ limit = 10, windowMs = 60_000, maxKeys = 10_000, now = Date.now } = {}) {
  const clients = new Map();
  return key => {
    const time = now();
    for (const [ip, entry] of clients) if (entry.until <= time) clients.delete(ip);
    let entry = clients.get(key);
    if (!entry) {
      // Refuse new keys rather than evict live counters and let callers reset their quota.
      if (clients.size >= maxKeys) return Math.max(1, Math.ceil(windowMs / 1000));
      entry = { count: 0, until: time + windowMs };
      clients.set(key, entry);
    }
    if (entry.count >= limit) return Math.max(1, Math.ceil((entry.until - time) / 1000));
    entry.count++;
    return 0;
  };
}

export async function readJson(request, maxBytes = 10_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) {
      request.resume();
      throw new ValidationError('Request body is too large');
    }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ValidationError('Request body must be valid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError('Request body must be an object');
  }
  return data;
}

export function sendJson(response, status, data, cache = 'no-store') {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

function httpServer(handler) {
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 },
    (request, response) => {
      handler(request, response).catch(error => {
        if (error instanceof ValidationError) sendJson(response, 400, { error: error.message });
        else {
          console.error('Score service:', error);
          sendJson(response, 500, { error: 'High-score service unavailable' });
        }
      }).finally(() => request.resume());
    });
}

export function createPublicServer(store, {
  allowedOrigins = DEFAULT_ORIGINS, clientIpHeader = '', rateLimit = 10, rateWindowMs = 60_000,
} = {}) {
  const checkRate = createRateLimiter({ limit: rateLimit, windowMs: rateWindowMs });
  return httpServer(async (request, response) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { throw new ValidationError('Invalid URL'); }
    response.setHeader('Vary', 'Origin');
    const origin = request.headers.origin;
    const allowed = origin && isAllowedOrigin(origin, allowedOrigins);
    if (allowed) response.setHeader('Access-Control-Allow-Origin', origin);

    const match = /^\/(game1|game2)\/high-scores$/.exec(pathname);
    const readOnly = pathname === '/scores.json' || pathname === '/health';
    if (!match && !readOnly) return sendJson(response, 404, { error: 'Not found' });

    if (request.method === 'OPTIONS' && allowed) {
      response.setHeader('Access-Control-Allow-Methods', match ? 'GET, POST' : 'GET, HEAD');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Max-Age', '86400');
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (readOnly) {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        return sendJson(response, 405, { error: 'Method not allowed' });
      }
      if (pathname === '/health') {
        try {
          await store.snapshot();
          return sendJson(response, 200, { ok: true });
        } catch (error) {
          console.error('Score health:', error);
          return sendJson(response, 503, { ok: false });
        }
      }
      return sendJson(response, 200, await store.snapshot(), 'public, max-age=60');
    }
    const board = match[1];
    if (request.method === 'GET') return sendJson(response, 200, { scores: await store.list(board) });
    if (request.method === 'POST') {
      if (origin && !allowed) return sendJson(response, 403, { error: 'Cross-origin submission refused' });
      const retry = checkRate(clientAddress(request, clientIpHeader));
      if (retry) {
        response.setHeader('Retry-After', String(retry));
        return sendJson(response, 429, { error: 'Too many submissions' });
      }
      const body = await readJson(request);
      return sendJson(response, 200, await store.submit(board, body.initials, body.score));
    }
    response.setHeader('Allow', 'GET, POST');
    sendJson(response, 405, { error: 'Method not allowed' });
  });
}

export function createAdminServer(store) {
  return httpServer(async (request, response) => {
    if (request.url !== '/' || request.method !== 'POST') return sendJson(response, 404, { error: 'Not found' });
    const body = await readJson(request, 1_000_000);
    let result;
    switch (body.action) {
      case 'list': result = { scores: await store.list(body.board) }; break;
      case 'remove': result = await store.remove(body.board, body.entry); break;
      case 'import': result = await store.import(body.board, body.source); break;
      default: throw new ValidationError('Unknown admin action');
    }
    sendJson(response, 200, result);
  });
}
