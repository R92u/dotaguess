import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDailyMatches, GameService } from '../src/gameService.js';
import { normalizeItemsById } from '../src/openDota.js';
import { getMoscowDateKey, getNextMoscowMidnightIso } from '../src/time.js';

function createMemoryStore(initialGames = []) {
  const games = new Map(initialGames);
  const guesses = new Map();
  const leaderboard = new Map();
  return {
    async get(key) { return games.get(key) || null; },
    async getPrevious(dateKey) {
      const keys = [...games.keys()].filter((key) => key < dateKey).sort();
      return keys.length ? games.get(keys.at(-1)) : null;
    },
    async set(key, value) { games.set(key, value); },
    async recordGuess(payload) {
      const key = `${payload.dateKey}:${payload.slot}:${payload.participantId}`;
      if (guesses.has(key)) return { ...guesses.get(key), alreadySubmitted: true };
      const result = {
        correct: payload.correct,
        guess: payload.guess,
        actual: payload.actual,
        alreadySubmitted: false
      };
      guesses.set(key, result);
      const entry = leaderboard.get(payload.participantId) || {
        name: payload.nickname,
        wins: 0,
        attempts: 0
      };
      entry.name = payload.nickname;
      entry.attempts += 1;
      if (payload.correct) entry.wins += 1;
      leaderboard.set(payload.participantId, entry);
      return result;
    },
    async getLeaderboard() {
      return [...leaderboard.values()]
        .sort((a, b) => b.wins - a.wins || b.attempts - a.attempts)
        .map((entry, index) => ({ rank: index + 1, ...entry }));
    }
  };
}

function createClient() {
  const playersFor = (matchId) => [
    {
      account_id: 123,
      player_slot: 2,
      hero_id: 1,
      kills: matchId === 777 ? 5 : 10,
      deaths: 2,
      assists: 8,
      item_0: 1,
      backpack_0: 2,
      item_neutral: 3
    },
    { account_id: 9, player_slot: 128, hero_id: 2, kills: 2, deaths: 5, assists: 3 }
  ];
  return {
    async getRecentMatches() {
      return [
        { match_id: 777, player_slot: 2, duration: 2400, game_mode: 22 },
        { match_id: 888, player_slot: 2, duration: 1800, game_mode: 23 },
        { match_id: 999, player_slot: 2, duration: 2200, game_mode: 22 }
      ];
    },
    async getPlayer() {
      return { profile: { personaname: 'Test Player', avatarfull: null } };
    },
    async getConstants() {
      return {
        heroes: {
          1: { localized_name: 'Anti-Mage', img: '/hero.png' },
          2: { localized_name: 'Axe', img: '/axe.png' }
        },
        items: {
          1: { dname: 'Blink Dagger', img: '/blink.png' },
          2: { dname: 'Boots', img: '/boots.png' },
          3: { dname: 'Neutral', img: '/neutral.png' }
        }
      };
    },
    async getMatch(matchId) {
      return {
        match_id: matchId,
        duration: matchId === 777 ? 2400 : 1800,
        game_mode: matchId === 777 ? 22 : 23,
        radiant_win: matchId === 777,
        players: playersFor(matchId)
      };
    },
    imageUrl(value) { return value ? `https://cdn.example${value}` : null; }
  };
}

test('Moscow date switches at 21:00 UTC', () => {
  assert.equal(getMoscowDateKey(new Date('2026-07-23T20:59:59Z')), '2026-07-23');
  assert.equal(getMoscowDateKey(new Date('2026-07-23T21:00:00Z')), '2026-07-24');
});

test('next Moscow midnight is returned in UTC', () => {
  assert.equal(
    getNextMoscowMidnightIso(new Date('2026-07-24T10:00:00Z')),
    '2026-07-24T21:00:00.000Z'
  );
});

test('two daily matches are unique and exclude yesterday when possible', () => {
  const matches = [{ match_id: 10 }, { match_id: 20 }, { match_id: 30 }, { match_id: 40 }];
  const selected = chooseDailyMatches(matches, 2, [10, 20], () => 0);
  assert.deepEqual(selected.map((match) => match.match_id), [30, 40]);
});

test('daily selection only uses the first 20 unique matches', () => {
  const matches = Array.from({ length: 30 }, (_, index) => ({ match_id: index + 1 }));
  const selected = chooseDailyMatches(matches, 2, [], (length) => length - 1);
  assert.deepEqual(selected.map((match) => match.match_id), [20, 19]);
});

test('OpenDota item constants are reindexed by numeric id', () => {
  const normalized = normalizeItemsById({
    blink: { id: 1, dname: 'Blink Dagger', img: '/blink.png' },
    boots: { id: 29, dname: 'Boots of Speed', img: '/boots.png' }
  });
  assert.equal(normalized['1'].dname, 'Blink Dagger');
  assert.equal(normalized['29'].img, '/boots.png');
});

test('public payload contains two games but no match ids or results', async () => {
  const service = new GameService({
    client: createClient(),
    store: createMemoryStore(),
    playerAccountId: 123,
    appSecret: 'secret'
  });
  const result = await service.getPublicGame(new Date('2026-07-24T10:00:00Z'));
  const serialized = JSON.stringify(result);

  assert.equal(result.schemaVersion, 3);
  assert.equal(result.games.length, 2);
  assert.equal(result.games[0].match.team[0].isTarget, true);
  assert.equal(result.games[0].match.team[0].items[0].image, 'https://cdn.example/blink.png');
  assert.equal(serialized.includes('matchId'), false);
  assert.equal(serialized.includes('targetWon'), false);
  assert.equal(serialized.includes('radiant_win'), false);
});


test('cached flat two-match record is migrated without choosing new matches', async () => {
  const dateKey = '2026-07-24';
  const player = {
    accountId: 123,
    isTarget: true,
    name: 'Old player',
    hero: { id: 1, name: 'Anti-Mage', image: null, icon: null },
    level: 20,
    kills: 5,
    deaths: 2,
    assists: 8,
    netWorth: 20000,
    lastHits: 200,
    denies: 5,
    gpm: 500,
    xpm: 600,
    heroDamage: 20000,
    towerDamage: 2000,
    heroHealing: 0,
    rank: 'Властелин 5',
    lane: 'лёгкая линия',
    items: [],
    backpack: [],
    neutral: null
  };
  const opponent = {
    ...player,
    accountId: 9,
    isTarget: false,
    name: 'Opponent',
    hero: { id: 2, name: 'Axe', image: null, icon: null }
  };
  const staleRecord = {
    schemaVersion: 2,
    dateKey,
    player: { accountId: 123, name: 'Old cache', avatar: null },
    games: [1, 2].map((slot) => ({
      slot,
      matchId: String(slot === 1 ? 111 : 222),
      targetWon: slot === 1,
      gameMode: 'Turbo',
      duration: 1800,
      patch: '7.39',
      team: [player],
      opponents: [opponent]
    }))
  };
  const store = createMemoryStore([[dateKey, staleRecord]]);
  const client = {
    async getRecentMatches() { throw new Error('migration must not fetch new matches'); },
    async getPlayer() { throw new Error('migration must not fetch profile'); },
    async getConstants() { throw new Error('migration must not fetch constants'); }
  };
  const service = new GameService({ client, store, playerAccountId: 123, appSecret: 'secret' });

  const result = await service.getPublicGame(new Date('2026-07-24T10:00:00Z'));

  assert.equal(result.schemaVersion, 3);
  assert.equal(result.games.length, 2);
  assert.equal(result.games[0].match.gameMode, 'Turbo');
  assert.equal(result.games[0].match.team[0].hero.name, 'Anti-Mage');
});

test('repeated answer for the same participant and match is counted once', async () => {
  const store = createMemoryStore();
  const service = new GameService({
    client: createClient(),
    store,
    playerAccountId: 123,
    appSecret: 'secret'
  });
  const now = new Date('2026-07-24T10:00:00Z');
  const publicGame = await service.getPublicGame(now);
  const dailyGame = publicGame.games[0];
  const payload = {
    dateKey: publicGame.dateKey,
    slot: dailyGame.slot,
    token: dailyGame.gameToken,
    guess: 'win',
    participantId: 'participant_123456789',
    nickname: 'Эдуард'
  };

  const first = await service.submitGuess(payload, now);
  const second = await service.submitGuess({ ...payload, guess: 'loss' }, now);
  const leaderboard = await service.getLeaderboard();

  assert.equal(first.alreadySubmitted, false);
  assert.equal(second.alreadySubmitted, true);
  assert.equal(second.correct, first.correct);
  assert.equal(leaderboard[0].attempts, 1);
  assert.equal(leaderboard[0].wins, first.correct ? 1 : 0);
});
