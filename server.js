import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { JsonStore } from './src/storage.js';
import { OpenDotaClient } from './src/openDota.js';
import { GameService } from './src/gameService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const store = new JsonStore(config.dataDir);
await store.init();
const client = new OpenDotaClient({ apiKey: config.openDotaApiKey });
const gameService = new GameService({
  client,
  store,
  playerAccountId: config.playerAccountId,
  appSecret: config.appSecret
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const rateBuckets = new Map();
function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(req, limit = 90, windowMs = 60_000) {
  const key = clientIp(req);
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' https://cdn.cloudflare.steamstatic.com https://avatars.steamstatic.com https://avatars.akamai.steamstatic.com data:; connect-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

async function readJsonBody(req, maxBytes = 16_384) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Слишком большой запрос.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Некорректный JSON.');
    error.status = 400;
    throw error;
  }
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requested);
  const relative = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.resolve(publicDir, `.${relative}`);
  if (!filePath.startsWith(publicDir + path.sep)) return false;

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': cache
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);

  if (!rateLimit(req)) {
    sendJson(res, 429, { error: 'Слишком много запросов. Попробуйте через минуту.' });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, playerAccountId: config.playerAccountId });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/game') {
      const game = await gameService.getPublicGame();
      sendJson(res, 200, game);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/game/guess') {
      const body = await readJsonBody(req);
      const result = await gameService.submitGuess(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const served = await serveStatic(req, res, url.pathname);
      if (served) return;
    }

    sendJson(res, 404, { error: 'Страница не найдена.' });
  } catch (error) {
    const status = Number(error?.status) || 502;
    console.error(`[${new Date().toISOString()}]`, error);
    sendJson(res, status, {
      error:
        status >= 500
          ? 'Не удалось получить данные матча. Попробуйте обновить страницу позже.'
          : error.message
    });
  }
});

server.listen(config.port, () => {
  console.log(`Dota Match Guess: http://localhost:${config.port}`);
  if (config.nodeEnv === 'production' && config.appSecret.includes('development-only')) {
    console.warn('WARNING: set a strong APP_SECRET before public deployment.');
  }
});
