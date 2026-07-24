import path from 'node:path';

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = Object.freeze({
  port: parsePositiveInt(process.env.PORT, 3000),
  playerAccountId: parsePositiveInt(process.env.PLAYER_ACCOUNT_ID, 1524768829),
  openDotaApiKey: process.env.OPENDOTA_API_KEY?.trim() || '',
  appSecret:
    process.env.APP_SECRET?.trim() ||
    'development-only-secret-change-this-before-public-deployment',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
  nodeEnv: process.env.NODE_ENV || 'development'
});
