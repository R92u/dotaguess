import crypto from 'node:crypto';
import { getMoscowDateKey, getNextMoscowMidnightIso } from './time.js';

const RECORD_SCHEMA_VERSION = 5;
const MATCHES_PER_DAY = 2;
const DEFAULT_MATCH_POOL_SIZE = 100;

const GAME_MODE_NAMES = {
  1: 'All Pick',
  2: "Captain's Mode",
  3: 'Random Draft',
  4: 'Single Draft',
  5: 'All Random',
  12: 'Least Played',
  16: "Captain's Draft",
  18: 'Ability Draft',
  20: 'All Random Deathmatch',
  22: 'Ranked All Pick',
  23: 'Turbo'
};

const LANE_NAMES = {
  1: 'лёгкая линия',
  2: 'центр',
  3: 'сложная линия',
  4: 'лес'
};

const RANK_NAMES = {
  1: 'Рекрут',
  2: 'Страж',
  3: 'Рыцарь',
  4: 'Герой',
  5: 'Легенда',
  6: 'Властелин',
  7: 'Божество',
  8: 'Титан'
};

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rankLabel(rankTier) {
  const rank = asNumber(rankTier);
  if (!rank) return 'Ранг скрыт';
  const medal = Math.floor(rank / 10);
  const stars = rank % 10;
  if (medal === 8) return stars ? `Титан · ${stars}` : 'Титан';
  return `${RANK_NAMES[medal] || 'Ранг'}${stars ? ` ${stars}` : ''}`;
}

function itemFromId(id, constants, client) {
  const numericId = asNumber(id);
  if (!numericId) return null;
  const item = constants.items[String(numericId)];
  return {
    id: numericId,
    name: item?.dname || item?.name || `Предмет ${numericId}`,
    image: client.imageUrl(item?.img) || null
  };
}

function heroFromId(id, constants, client) {
  const hero = constants.heroes[String(id)];
  const fallbackName = hero?.name?.replace('npc_dota_hero_', '').replaceAll('_', ' ');
  return {
    id: asNumber(id),
    name: hero?.localized_name || fallbackName || `Герой ${id}`,
    image: client.imageUrl(hero?.img) || null,
    icon: client.imageUrl(hero?.icon) || null
  };
}

function sanitizePlayer(player, constants, client, isTarget) {
  const items = [0, 1, 2, 3, 4, 5]
    .map((slot) => itemFromId(player[`item_${slot}`], constants, client))
    .filter(Boolean);
  const backpack = [0, 1, 2]
    .map((slot) => itemFromId(player[`backpack_${slot}`], constants, client))
    .filter(Boolean);
  const neutral = itemFromId(player.item_neutral ?? player.neutral_item, constants, client);

  return {
    accountId: player.account_id || null,
    isTarget: Boolean(isTarget),
    name: player.personaname || (player.account_id ? `Игрок ${player.account_id}` : 'Анонимный игрок'),
    hero: heroFromId(player.hero_id, constants, client),
    level: asNumber(player.level),
    kills: asNumber(player.kills),
    deaths: asNumber(player.deaths),
    assists: asNumber(player.assists),
    netWorth: asNumber(player.net_worth ?? player.total_gold ?? player.gold),
    lastHits: asNumber(player.last_hits),
    denies: asNumber(player.denies),
    gpm: asNumber(player.gold_per_min),
    xpm: asNumber(player.xp_per_min),
    heroDamage: asNumber(player.hero_damage),
    towerDamage: asNumber(player.tower_damage),
    heroHealing: asNumber(player.hero_healing),
    rank: rankLabel(player.rank_tier),
    lane: LANE_NAMES[player.lane_role] || 'роль не определена',
    items,
    backpack,
    neutral
  };
}

function isRadiantSlot(playerSlot) {
  return asNumber(playerSlot) < 128;
}

function signToken(dateKey, slot, matchId, targetAccountId, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${dateKey}:${slot}:${matchId}:${targetAccountId}`)
    .digest('base64url');
}

function previousMatchIds(record) {
  if (Array.isArray(record?.games)) return record.games.map((game) => String(game.matchId));
  return record?.matchId ? [String(record.matchId)] : [];
}

function sanitizeNickname(value) {
  const nickname = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (nickname.length < 2 || nickname.length > 24) {
    const error = new Error('Имя для лидерборда должно содержать от 2 до 24 символов.');
    error.status = 400;
    throw error;
  }
  return nickname;
}

function sanitizeParticipantId(value) {
  const participantId = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(participantId)) {
    const error = new Error('Некорректный идентификатор участника.');
    error.status = 400;
    throw error;
  }
  return participantId;
}

function isValidPlayer(player) {
  return Boolean(
    player &&
    typeof player === 'object' &&
    player.hero &&
    typeof player.hero === 'object' &&
    typeof player.hero.name === 'string' &&
    Array.isArray(player.items) &&
    Array.isArray(player.backpack)
  );
}

function isValidTargetPlayer(player) {
  return Boolean(
    player &&
    typeof player === 'object' &&
    Number.isFinite(Number(player.accountId)) &&
    typeof player.name === 'string'
  );
}

function isValidDailyGame(game) {
  const match = game?.match;
  return Boolean(
    game &&
    Number.isInteger(Number(game.slot)) &&
    String(game.matchId || '').length > 0 &&
    typeof game.targetWon === 'boolean' &&
    isValidTargetPlayer(game.player) &&
    match &&
    typeof match === 'object' &&
    typeof match.gameMode === 'string' &&
    Number.isFinite(Number(match.duration)) &&
    Array.isArray(match.team) &&
    match.team.length > 0 &&
    match.team.every(isValidPlayer) &&
    Array.isArray(match.opponents) &&
    match.opponents.length > 0 &&
    match.opponents.every(isValidPlayer)
  );
}

function isValidRecord(record) {
  return Boolean(
    record?.schemaVersion === RECORD_SCHEMA_VERSION &&
    Array.isArray(record.games) &&
    record.games.length === MATCHES_PER_DAY &&
    record.games.every(isValidDailyGame)
  );
}

export function combinePlayerMatchPools(
  matchLists,
  poolSize = DEFAULT_MATCH_POOL_SIZE,
  beforeStartTime = Number.POSITIVE_INFINITY
) {
  const combined = [];
  const cutoff = Number(beforeStartTime);
  for (const entry of matchLists || []) {
    const accountId = Number(entry?.accountId);
    if (!accountId || !Array.isArray(entry?.matches)) continue;
    for (const match of entry.matches) {
      if (!match?.match_id) continue;
      const startTime = asNumber(match.start_time, -1);
      // Пул дня фиксируется на 00:00 МСК: матчи, начавшиеся после
      // полуночи текущего дня, не могут сдвинуть выбор для других посетителей.
      if (Number.isFinite(cutoff) && (startTime < 0 || startTime >= cutoff)) continue;
      combined.push({ ...match, targetAccountId: accountId });
    }
  }

  combined.sort((a, b) =>
    asNumber(b.start_time) - asNumber(a.start_time) ||
    asNumber(b.match_id) - asNumber(a.match_id)
  );

  const unique = [];
  const seen = new Set();
  for (const match of combined) {
    const key = String(match.match_id);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(match);
    if (unique.length >= poolSize) break;
  }
  return unique;
}

export function chooseDailyMatches(
  recentMatches,
  count = MATCHES_PER_DAY,
  excludedMatchIds = [],
  randomInt = crypto.randomInt,
  poolSize = DEFAULT_MATCH_POOL_SIZE
) {
  if (!Array.isArray(recentMatches) || recentMatches.length === 0) {
    throw new Error('У выбранных игроков нет доступных матчей.');
  }

  const unique = [...new Map(recentMatches.map((match) => [String(match.match_id), match])).values()]
    .filter((match) => match.match_id)
    .slice(0, poolSize);
  if (unique.length < count) {
    throw new Error(`Для игры требуется не менее ${count} доступных матчей.`);
  }

  const excluded = new Set(excludedMatchIds.map(String));
  const preferred = unique.filter((match) => !excluded.has(String(match.match_id)));
  const pool = preferred.length >= count ? [...preferred] : [...unique];
  const selected = [];

  while (selected.length < count && pool.length) {
    const index = randomInt(pool.length);
    selected.push(pool.splice(index, 1)[0]);
  }

  return selected;
}

export function chooseDailyMatch(recentMatches, previousMatchId = null, randomInt = crypto.randomInt) {
  return chooseDailyMatches(recentMatches, 1, previousMatchId ? [previousMatchId] : [], randomInt)[0];
}

function dailyCandidateScore(match, dateKey, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${dateKey}:${match.match_id}:${match.targetAccountId || 0}`)
    .digest('hex');
}

export function orderDailyCandidates(
  recentMatches,
  dateKey,
  secret,
  excludedMatchIds = [],
  poolSize = DEFAULT_MATCH_POOL_SIZE
) {
  if (!Array.isArray(recentMatches) || recentMatches.length === 0) {
    throw new Error('У выбранных игроков нет доступных матчей до начала текущего дня.');
  }

  const unique = [...new Map(recentMatches.map((match) => [String(match.match_id), match])).values()]
    .filter((match) => match?.match_id)
    .slice(0, poolSize);
  if (unique.length < MATCHES_PER_DAY) {
    throw new Error(`Для игры требуется не менее ${MATCHES_PER_DAY} доступных матчей.`);
  }

  const excluded = new Set(excludedMatchIds.map(String));
  const sortByDailyScore = (a, b) =>
    dailyCandidateScore(a, dateKey, secret).localeCompare(dailyCandidateScore(b, dateKey, secret)) ||
    String(a.match_id).localeCompare(String(b.match_id));

  const preferred = unique
    .filter((match) => !excluded.has(String(match.match_id)))
    .sort(sortByDailyScore);
  const fallback = unique
    .filter((match) => excluded.has(String(match.match_id)))
    .sort(sortByDailyScore);

  return [...preferred, ...fallback];
}

function getMoscowDayStartUnix(dateKey) {
  return Math.floor(Date.parse(`${dateKey}T00:00:00+03:00`) / 1000);
}

export class GameService {
  constructor({ client, store, playerAccountIds, playerAccountId, matchPoolSize, appSecret }) {
    this.client = client;
    this.store = store;
    this.playerAccountIds = [...new Set(
      (playerAccountIds?.length ? playerAccountIds : [playerAccountId])
        .map(Number)
        .filter((value) => Number.isFinite(value) && value > 0)
    )];
    this.matchPoolSize = Math.max(2, Number(matchPoolSize) || DEFAULT_MATCH_POOL_SIZE);
    this.appSecret = appSecret;
    this.pendingByDate = new Map();
  }

  async getPublicGame(now = new Date()) {
    const record = await this.#getOrCreateRecord(now);
    return this.#publicRecord(record, now);
  }

  async getLeaderboard(limit = 50) {
    return this.store.getLeaderboard(limit);
  }

  async getLeaderboardSnapshot(limit = 50) {
    return this.store.getLeaderboardSnapshot(limit);
  }

  async clearLeaderboard() {
    return this.store.clearLeaderboard();
  }

  async submitGuess({ dateKey, slot, token, guess, participantId, nickname }, now = new Date()) {
    const currentDateKey = getMoscowDateKey(now);
    if (dateKey !== currentDateKey) {
      const error = new Error('Матчи дня уже сменились. Обновите страницу.');
      error.status = 409;
      throw error;
    }

    if (!['win', 'loss'].includes(guess)) {
      const error = new Error('Допустимые варианты ответа: win или loss.');
      error.status = 400;
      throw error;
    }

    const numericSlot = asNumber(slot);
    const safeParticipantId = sanitizeParticipantId(participantId);
    const safeNickname = sanitizeNickname(nickname);
    const record = await this.#getOrCreateRecord(now);
    const dailyGame = record.games.find((game) => game.slot === numericSlot);
    if (!dailyGame) {
      const error = new Error('Такого матча дня нет.');
      error.status = 404;
      throw error;
    }

    const expectedToken = signToken(
      record.dateKey,
      dailyGame.slot,
      dailyGame.matchId,
      dailyGame.player.accountId,
      this.appSecret
    );
    const supplied = Buffer.from(String(token || ''));
    const expected = Buffer.from(expectedToken);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      const error = new Error('Недействительный идентификатор игры.');
      error.status = 403;
      throw error;
    }

    const actual = dailyGame.targetWon ? 'win' : 'loss';
    const submittedCorrect = guess === actual;
    const recorded = await this.store.recordGuess({
      participantId: safeParticipantId,
      nickname: safeNickname,
      dateKey: record.dateKey,
      slot: dailyGame.slot,
      correct: submittedCorrect,
      guess,
      actual,
      matchId: dailyGame.matchId
    });

    return {
      correct: Boolean(recorded.correct),
      actual: recorded.actual,
      alreadySubmitted: Boolean(recorded.alreadySubmitted),
      matchId: dailyGame.matchId,
      player: dailyGame.player,
      links: {
        openDota: `https://www.opendota.com/matches/${dailyGame.matchId}`,
        stratz: `https://stratz.com/matches/${dailyGame.matchId}`,
        player: `https://stratz.com/players/${dailyGame.player.accountId}`
      }
    };
  }

  async #getOrCreateRecord(now) {
    const dateKey = getMoscowDateKey(now);
    const existing = await this.store.get(dateKey);
    if (isValidRecord(existing)) return existing;

    if (existing) {
      console.warn(`Данные матчей за ${dateKey} относятся к старой версии и будут пересозданы.`);
    }

    if (!this.pendingByDate.has(dateKey)) {
      this.pendingByDate.set(
        dateKey,
        this.#createRecord(dateKey).finally(() => this.pendingByDate.delete(dateKey))
      );
    }
    return this.pendingByDate.get(dateKey);
  }

  async #createRecord(dateKey) {
    if (!this.playerAccountIds.length) {
      throw new Error('Не указаны Dota account ID игроков.');
    }

    const [constants, profileResults, matchResults] = await Promise.all([
      this.client.getConstants(),
      Promise.allSettled(this.playerAccountIds.map((accountId) => this.client.getPlayer(accountId))),
      Promise.allSettled(
        this.playerAccountIds.map((accountId) =>
          this.client.getPlayerMatches(accountId, this.matchPoolSize)
        )
      )
    ]);

    const profiles = new Map();
    const matchLists = [];
    this.playerAccountIds.forEach((accountId, index) => {
      const profileResult = profileResults[index];
      const matchResult = matchResults[index];
      if (profileResult?.status === 'fulfilled') profiles.set(accountId, profileResult.value);
      else console.warn(`Профиль ${accountId} недоступен: ${profileResult?.reason?.message || 'ошибка'}`);

      if (matchResult?.status === 'fulfilled' && Array.isArray(matchResult.value)) {
        matchLists.push({ accountId, matches: matchResult.value });
      } else {
        console.warn(`Матчи ${accountId} недоступны: ${matchResult?.reason?.message || 'ошибка'}`);
      }
    });

    const dayStartUnix = getMoscowDayStartUnix(dateKey);
    const combinedPool = combinePlayerMatchPools(
      matchLists,
      this.matchPoolSize,
      dayStartUnix
    );
    const previous = await this.store.getPrevious(dateKey);
    const candidateCount = Math.min(12, combinedPool.length);
    const candidates = orderDailyCandidates(
      combinedPool,
      dateKey,
      this.appSecret,
      previousMatchIds(previous),
      this.matchPoolSize
    ).slice(0, candidateCount);

    const games = [];
    let lastMatchError = null;
    for (const selected of candidates) {
      try {
        const match = await this.client.getMatch(selected.match_id);
        const profile = profiles.get(Number(selected.targetAccountId));
        const dailyGame = this.#buildDailyGame(
          selected,
          match,
          constants,
          profile,
          games.length + 1
        );
        games.push(dailyGame);
        if (games.length === MATCHES_PER_DAY) break;
      } catch (error) {
        lastMatchError = error;
        console.warn(`Матч ${selected.match_id} пропущен: ${error.message}`);
      }
    }
    if (games.length < MATCHES_PER_DAY) {
      throw lastMatchError || new Error('Не удалось подготовить два матча дня.');
    }

    const record = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      dateKey,
      createdAt: new Date().toISOString(),
      poolSize: combinedPool.length,
      trackedPlayerIds: this.playerAccountIds,
      selectionPolicy: 'moscow-day-cutoff-deterministic-v1',
      games
    };

    await this.store.set(dateKey, record);
    return record;
  }

  #findTarget(match, selected) {
    const targetAccountId = Number(selected.targetAccountId);
    return (
      match.players?.find((player) => Number(player.account_id) === targetAccountId) ||
      match.players?.find((player) => Number(player.player_slot) === Number(selected.player_slot))
    );
  }

  #buildDailyGame(selected, match, constants, profile, slot) {
    if (!Array.isArray(match.players) || match.players.length < 2) {
      throw new Error('OpenDota не вернул состав выбранного матча.');
    }

    const target = this.#findTarget(match, selected);
    if (!target) throw new Error('Выбранный игрок не найден в составе матча.');

    const targetAccountId = Number(selected.targetAccountId || target.account_id);
    const targetRadiant = isRadiantSlot(target.player_slot);
    const radiantWon = match.radiant_win === true || match.radiant_win === 1;
    const targetWon = targetRadiant === radiantWon;
    const team = [];
    const opponents = [];

    for (const player of match.players) {
      const isTarget = Number(player.account_id) === targetAccountId || player === target;
      const sanitized = sanitizePlayer(player, constants, this.client, isTarget);
      if (isRadiantSlot(player.player_slot) === targetRadiant) team.push(sanitized);
      else opponents.push(sanitized);
    }

    return {
      slot,
      matchId: String(match.match_id || selected.match_id),
      targetWon,
      player: {
        accountId: targetAccountId,
        name:
          profile?.profile?.personaname ||
          target?.personaname ||
          `Игрок ${targetAccountId}`,
        avatar: profile?.profile?.avatarfull || profile?.profile?.avatarmedium || null
      },
      match: {
        duration: asNumber(match.duration || selected.duration),
        gameMode: GAME_MODE_NAMES[match.game_mode || selected.game_mode] || 'Dota 2',
        patch: match.patch ? String(match.patch) : null,
        team,
        opponents
      }
    };
  }

  #publicRecord(record, now) {
    if (!isValidRecord(record)) {
      throw new Error('Сохранённые данные матчей имеют некорректный формат.');
    }

    return {
      schemaVersion: RECORD_SCHEMA_VERSION,
      dateKey: record.dateKey,
      nextResetAt: getNextMoscowMidnightIso(now),
      matchPoolSize: record.poolSize || this.matchPoolSize,
      trackedPlayerIds: record.trackedPlayerIds || this.playerAccountIds,
      games: record.games.map((game) => ({
        slot: game.slot,
        gameToken: signToken(
          record.dateKey,
          game.slot,
          game.matchId,
          game.player.accountId,
          this.appSecret
        ),
        player: game.player,
        match: game.match
      }))
    };
  }
}

export { DEFAULT_MATCH_POOL_SIZE, MATCHES_PER_DAY, RECORD_SCHEMA_VERSION };
