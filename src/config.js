import path from 'node:path';

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePlayerAccountIds() {
  const fallback = [1524768829, 1675188627, 367813952, 390845935];
  const raw = process.env.PLAYER_ACCOUNT_IDS?.trim() || process.env.PLAYER_ACCOUNT_ID?.trim();
  if (!raw) return fallback;

  const ids = [...new Set(
    raw
      .split(/[\s,;]+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value > 0)
  )];
  return ids.length ? ids : fallback;
}

const playerAccountIds = parsePlayerAccountIds();

export const config = Object.freeze({
  port: parsePositiveInt(process.env.PORT, 3000),
  playerAccountIds,
  playerAccountId: playerAccountIds[0],
  matchPoolSize: parsePositiveInt(process.env.MATCH_POOL_SIZE, 100),
  openDotaApiKey: process.env.OPENDOTA_API_KEY?.trim() || '',
  appSecret:
    process.env.APP_SECRET?.trim() ||
    'development-only-secret-change-this-before-public-deployment',
  adminSecret:
    process.env.ADMIN_SECRET?.trim() ||
    'DgFCvKqN8ozA_eD6x7HtPb57G_eC2axQFLa7lnitLTc',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
  nodeEnv: process.env.NODE_ENV || 'development'
});
