import crypto from 'node:crypto';
import { getMoscowDateKey, getNextMoscowMidnightIso } from './time.js';

const RECORD_SCHEMA_VERSION = 2;
const MATCHES_PER_DAY = 2;

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

function signToken(dateKey, slot, matchId, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${dateKey}:${slot}:${matchId}`)
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

export function chooseDailyMatches(
  recentMatches,
  count = MATCHES_PER_DAY,
  excludedMatchIds = [],
  randomInt = crypto.randomInt
) {
  if (!Array.isArray(recentMatches) || recentMatches.length === 0) {
    throw new Error('У игрока нет доступных недавних матчей.');
  }

  const unique = [...new Map(recentMatches.map((match) => [String(match.match_id), match])).values()]
    .filter((match) => match.match_id)
    .slice(0, 20);
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

// Обратная совместимость с тестами и внешними импортами первой версии.
export function chooseDailyMatch(recentMatches, previousMatchId = null, randomInt = crypto.randomInt) {
  return chooseDailyMatches(recentMatches, 1, previousMatchId ? [previousMatchId] : [], randomInt)[0];
}

export class GameService {
  constructor({ client, store, playerAccountId, appSecret }) {
    this.client = client;
    this.store = store;
    this.playerAccountId = playerAccountId;
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

    const expectedToken = signToken(record.dateKey, dailyGame.slot, dailyGame.matchId, this.appSecret);
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
      links: {
        openDota: `https://www.opendota.com/matches/${dailyGame.matchId}`,
        stratz: `https://stratz.com/matches/${dailyGame.matchId}`,
        player: `https://stratz.com/players/${this.playerAccountId}`
      }
    };
  }

  async #getOrCreateRecord(now) {
    const dateKey = getMoscowDateKey(now);
    const existing = await this.store.get(dateKey);
    if (
      existing?.schemaVersion === RECORD_SCHEMA_VERSION &&
      Array.isArray(existing.games) &&
      existing.games.length === MATCHES_PER_DAY
    ) {
      return existing;
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
    const [recentMatches, profile, constants] = await Promise.all([
      this.client.getRecentMatches(this.playerAccountId),
      this.client.getPlayer(this.playerAccountId),
      this.client.getConstants()
    ]);

    const previous = await this.store.getPrevious(dateKey);
    const availableCount = new Set(
      recentMatches.filter((match) => match?.match_id).slice(0, 20).map((match) => String(match.match_id))
    ).size;
    const candidateCount = Math.min(6, availableCount);
    const candidates = chooseDailyMatches(
      recentMatches,
      candidateCount,
      previousMatchIds(previous)
    );

    const games = [];
    let firstTarget = null;
    let lastMatchError = null;
    for (const selected of candidates) {
      try {
        const match = await this.client.getMatch(selected.match_id);
        const target = this.#findTarget(match, selected);
        const dailyGame = this.#buildDailyGame(selected, match, constants, games.length + 1);
        games.push(dailyGame);
        firstTarget ||= target;
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
      player: {
        accountId: this.playerAccountId,
        name:
          profile?.profile?.personaname ||
          firstTarget?.personaname ||
          `Игрок ${this.playerAccountId}`,
        avatar: profile?.profile?.avatarfull || profile?.profile?.avatarmedium || null
      },
      games
    };

    await this.store.set(dateKey, record);
    return record;
  }

  #findTarget(match, selected) {
    return (
      match.players?.find(
        (player) => Number(player.account_id) === Number(this.playerAccountId)
      ) ||
      match.players?.find(
        (player) => Number(player.player_slot) === Number(selected.player_slot)
      )
    );
  }

  #buildDailyGame(selected, match, constants, slot) {
    if (!Array.isArray(match.players) || match.players.length < 2) {
      throw new Error('OpenDota не вернул состав выбранного матча.');
    }

    const target = this.#findTarget(match, selected);
    if (!target) {
      throw new Error('Выбранный игрок не найден в составе матча.');
    }

    const targetRadiant = isRadiantSlot(target.player_slot);
    const radiantWon = match.radiant_win === true || match.radiant_win === 1;
    const targetWon = targetRadiant === radiantWon;
    const team = [];
    const opponents = [];

    for (const player of match.players) {
      const isTarget = player === target || Number(player.player_slot) === Number(target.player_slot);
      const sanitized = sanitizePlayer(player, constants, this.client, isTarget);
      if (isRadiantSlot(player.player_slot) === targetRadiant) team.push(sanitized);
      else opponents.push(sanitized);
    }

    return {
      slot,
      matchId: String(match.match_id || selected.match_id),
      targetWon,
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
    return {
      dateKey: record.dateKey,
      nextResetAt: getNextMoscowMidnightIso(now),
      player: record.player,
      games: record.games.map((game) => ({
        slot: game.slot,
        gameToken: signToken(record.dateKey, game.slot, game.matchId, this.appSecret),
        match: game.match
      }))
    };
  }
}

export { MATCHES_PER_DAY, RECORD_SCHEMA_VERSION };
