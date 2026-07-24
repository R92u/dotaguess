import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { createStore } from './src/createStore.js';
import { OpenDotaClient } from './src/openDota.js';
import { GameService } from './src/gameService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const APP_VERSION = '2.5.1';
const store = await createStore({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const client = new OpenDotaClient({ apiKey: config.openDotaApiKey });
const gameService = new GameService({
  client,
  store,
  playerAccountIds: config.playerAccountIds,
  matchPoolSize: config.matchPoolSize,
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
const leaderboardStreams = new Set();

function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(req, limit = 120, windowMs = 60_000) {
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

function isAuthorizedAdmin(req) {
  const authorization = String(req.headers.authorization || '');
  const suppliedSecret = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : String(req.headers['x-admin-secret'] || '').trim();
  if (!config.adminApiSecret) return false;
  const expected = Buffer.from(config.adminApiSecret);
  const supplied = Buffer.from(suppliedSecret);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function requireAdmin(req, res) {
  if (isAuthorizedAdmin(req)) return true;
  sendJson(res, 403, { error: 'Неверный пароль администратора.' });
  return false;
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

function writeSse(res, event, body) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

async function broadcastLeaderboard() {
  if (!leaderboardStreams.size) return;
  const snapshot = await gameService.getLeaderboardSnapshot();
  for (const res of leaderboardStreams) {
    try {
      writeSse(res, 'leaderboard', snapshot);
    } catch {
      leaderboardStreams.delete(res);
    }
  }
}

function broadcastGameReset(payload) {
  for (const res of leaderboardStreams) {
    try {
      writeSse(res, 'game-reset', payload);
    } catch {
      leaderboardStreams.delete(res);
    }
  }
}

async function readJsonBody(req, maxBytes = 32_768) {
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
  let requested = pathname === '/' ? '/index.html' : pathname;
  if (requested.endsWith('/')) requested += 'index.html';
  const decoded = decodeURIComponent(requested);
  const relative = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.resolve(publicDir, `.${relative}`);
  if (!filePath.startsWith(publicDir + path.sep)) return false;

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const cache = ['.html', '.css', '.js'].includes(ext)
      ? 'no-store, max-age=0'
      : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': cache
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
    return true;
  } catch {
    return false;
  }
}

const heartbeat = setInterval(() => {
  for (const res of leaderboardStreams) {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      leaderboardStreams.delete(res);
    }
  }
}, 25_000);
heartbeat.unref();

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);

  if (!rateLimit(req)) {
    sendJson(res, 429, { error: 'Слишком много запросов. Попробуйте через минуту.' });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        playerAccountIds: config.playerAccountIds,
        matchPoolSize: config.matchPoolSize,
        version: APP_VERSION,
        storage: config.databaseUrl ? 'postgres' : 'json'
      });
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
      await broadcastLeaderboard().catch((error) => console.error('Leaderboard broadcast:', error));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      sendJson(res, 200, await gameService.getLeaderboardSnapshot());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/state') {
      if (!requireAdmin(req, res)) return;
      sendJson(res, 200, await gameService.getAdminState());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/day/reset') {
      if (!requireAdmin(req, res)) return;
      const body = await readJsonBody(req);
      const result = await gameService.resetToday(body);
      sendJson(res, 200, {
        ok: true,
        reset: result.reset,
        state: await gameService.getAdminState()
      });
      broadcastGameReset({
        dateKey: result.game.dateKey,
        gameRevision: result.game.gameRevision,
        resetAt: result.reset.resetAt
      });
      await broadcastLeaderboard().catch((error) => console.error('Leaderboard broadcast:', error));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/leaderboard/entry') {
      if (!requireAdmin(req, res)) return;
      const body = await readJsonBody(req);
      const entry = await gameService.upsertLeaderboardEntry(body);
      sendJson(res, 200, { ok: true, entry });
      await broadcastLeaderboard().catch((error) => console.error('Leaderboard broadcast:', error));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/leaderboard/entry/delete') {
      if (!requireAdmin(req, res)) return;
      const body = await readJsonBody(req);
      const result = await gameService.deleteLeaderboardEntry(body.participantId);
      sendJson(res, 200, { ok: true, ...result });
      await broadcastLeaderboard().catch((error) => console.error('Leaderboard broadcast:', error));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/leaderboard/clear') {
      if (!requireAdmin(req, res)) return;
      const result = await gameService.clearLeaderboard();
      sendJson(res, 200, { ok: true, entries: [], ...result });
      await broadcastLeaderboard().catch((error) => console.error('Leaderboard broadcast:', error));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/leaderboard/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders?.();
      leaderboardStreams.add(res);
      writeSse(res, 'leaderboard', await gameService.getLeaderboardSnapshot());
      req.on('close', () => leaderboardStreams.delete(res));
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
    if (!res.headersSent) {
      sendJson(res, status, {
        error:
          status >= 500
            ? 'Не удалось выполнить запрос. Попробуйте ещё раз позже.'
            : error.message
      });
    } else {
      res.end();
    }
  }
});

server.listen(config.port, () => {
  console.log(`Dota Match Guess: http://localhost:${config.port}`);
  console.log(`Storage: ${config.databaseUrl ? 'PostgreSQL' : config.dataDir}`);
  if (config.nodeEnv === 'production' && config.appSecret.includes('development-only')) {
    console.warn('WARNING: set a strong APP_SECRET before public deployment.');
  }
  if (config.nodeEnv === 'production' && !config.adminApiSecret) {
    console.warn('WARNING: ADMIN_API_SECRET is not set. Administrative API is disabled.');
  }
  if (process.env.RENDER && !config.databaseUrl && !process.env.DATA_DIR) {
    console.warn('WARNING: Render filesystem is ephemeral. Set DATABASE_URL or attach a persistent disk.');
  }
});
