const BASE_URL = 'https://api.opendota.com/api';
const CDN_ORIGIN = 'https://cdn.cloudflare.steamstatic.com';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeItemsById(rawItems) {
  const byId = {};
  for (const [key, value] of Object.entries(rawItems || {})) {
    if (!value || typeof value !== 'object') continue;
    const id = Number(value.id ?? (/^\d+$/.test(key) ? key : 0));
    if (!Number.isFinite(id) || id <= 0) continue;
    byId[String(id)] = { ...value, key };
  }
  return byId;
}

export class OpenDotaClient {
  constructor({ apiKey = '', timeoutMs = 12_000 } = {}) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.constantsCache = null;
    this.constantsExpiresAt = 0;
  }

  async getPlayer(accountId) {
    return this.#get(`/players/${accountId}`);
  }

  async getRecentMatches(accountId) {
    return this.#get(`/players/${accountId}/recentMatches`);
  }

  async getMatch(matchId) {
    return this.#get(`/matches/${matchId}`);
  }

  async getConstants() {
    if (this.constantsCache && Date.now() < this.constantsExpiresAt) {
      return this.constantsCache;
    }

    const [heroes, rawItems] = await Promise.all([
      this.#get('/constants/heroes'),
      this.#get('/constants/items')
    ]);

    this.constantsCache = { heroes, items: normalizeItemsById(rawItems) };
    this.constantsExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    return this.constantsCache;
  }

  imageUrl(path) {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    return `${CDN_ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  async #get(endpoint) {
    const url = new URL(`${BASE_URL}${endpoint}`);
    if (this.apiKey) url.searchParams.set('api_key', this.apiKey);

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          headers: {
            accept: 'application/json',
            'user-agent': 'dota-match-guess/2.0'
          },
          signal: controller.signal
        });

        if (response.ok) return await response.json();

        const body = await response.text().catch(() => '');
        const error = new Error(
          `OpenDota returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`
        );
        error.status = response.status;
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (error?.status && error.status < 500 && error.status !== 429) throw error;
      } finally {
        clearTimeout(timer);
      }

      await sleep(350 * 2 ** attempt);
    }

    throw lastError || new Error('OpenDota request failed');
  }
}
