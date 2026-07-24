import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseDailyMatches,
  combinePlayerMatchPools,
  orderDailyCandidates,
  GameService
} from '../src/gameService.js';
import { normalizeItemsById } from '../src/openDota.js';
import { getMoscowDateKey, getNextMoscowMidnightIso } from '../src/time.js';

function createMemoryStore(initialGames = []) {
  const games = new Map(initialGames);
  const guesses = new Map();
  const leaderboard = new Map();
  const dailySettings = new Map();
  return {
    async get(key) { return games.get(key) || null; },
    async getPrevious(dateKey) {
      const keys = [...games.keys()].filter((key) => key < dateKey).sort();
      return keys.length ? games.get(keys.at(-1)) : null;
    },
    async set(key, value) { games.set(key, value); },
    async getDailySettings(key) { return dailySettings.get(key) || null; },
    async resetDailyGame({ dateKey, matchCount, playerAccountIds }) {
      const previous = dailySettings.get(dateKey) || { resetNonce: 0 };
      const resetNonce = previous.resetNonce + 1;
      const revision = `test-${resetNonce}`;
      dailySettings.set(dateKey, {
        matchCount, playerAccountIds, resetNonce, revision, updatedAt: new Date().toISOString()
      });
      games.delete(dateKey);
      for (const [key, guess] of [...guesses.entries()]) {
        if (guess.dateKey !== dateKey) continue;
        guesses.delete(key);
        const entry = leaderboard.get(guess.participantId);
        if (entry) {
          entry.attempts = Math.max(0, entry.attempts - 1);
          if (guess.correct) entry.wins = Math.max(0, entry.wins - 1);
        }
      }
      return { dateKey, matchCount, playerAccountIds, resetNonce, revision, resetAt: new Date().toISOString() };
    },
    async recordGuess(payload) {
      const key = `${payload.dateKey}:${payload.slot}:${payload.participantId}`;
      if (guesses.has(key)) return { ...guesses.get(key), alreadySubmitted: true };
      const result = {
        ...payload,
        correct: payload.correct,
        guess: payload.guess,
        actual: payload.actual,
        alreadySubmitted: false
      };
      guesses.set(key, result);
      const entry = leaderboard.get(payload.participantId) || {
        participantId: payload.participantId,
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
    },
    async getAdminLeaderboard() { return this.getLeaderboard(); },
    async getLeaderboardSnapshot() {
      return { entries: await this.getLeaderboard(), resetAt: null };
    },
    async clearLeaderboard() {
      const clearedParticipants = leaderboard.size;
      const clearedGuesses = guesses.size;
      leaderboard.clear();
      guesses.clear();
      return { clearedParticipants, clearedGuesses, resetAt: new Date().toISOString() };
    },
    async upsertLeaderboardEntry(payload) {
      const participantId = payload.participantId || 'admin_participant_123';
      leaderboard.set(participantId, { participantId, ...payload });
      return { participantId, ...payload };
    },
    async deleteLeaderboardEntry(participantId) {
      return { deleted: leaderboard.delete(participantId), clearedGuesses: 0 };
    }
  };
}

function createClient() {
  const playersFor = (matchId, accountId) => [
    {
      account_id: accountId,
      personaname: `Player ${accountId}`,
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
    async getPlayerMatches(accountId) {
      return accountId === 123
        ? [
            { match_id: 777, player_slot: 2, duration: 2400, game_mode: 22, start_time: 300 },
            { match_id: 888, player_slot: 2, duration: 1800, game_mode: 23, start_time: 200 }
          ]
        : [
            { match_id: 999, player_slot: 2, duration: 2200, game_mode: 22, start_time: 250 },
            { match_id: 1111, player_slot: 2, duration: 2100, game_mode: 22, start_time: 150 }
          ];
    },
    async getPlayer(accountId) {
      return { profile: { personaname: `Profile ${accountId}`, avatarfull: null } };
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
      const accountId = [777, 888].includes(Number(matchId)) ? 123 : 456;
      return {
        match_id: matchId,
        duration: 2400,
        game_mode: 22,
        radiant_win: true,
        players: playersFor(Number(matchId), accountId)
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

test('combined pool takes 100 newest unique matches from all players', () => {
  const first = Array.from({ length: 80 }, (_, index) => ({
    match_id: index + 1,
    start_time: 1000 - index
  }));
  const second = Array.from({ length: 80 }, (_, index) => ({
    match_id: index + 61,
    start_time: 950 - index
  }));
  const pool = combinePlayerMatchPools([
    { accountId: 123, matches: first },
    { accountId: 456, matches: second }
  ], 100);
  assert.equal(pool.length, 100);
  assert.equal(new Set(pool.map((match) => match.match_id)).size, 100);
  assert.ok(pool.every((match) => [123, 456].includes(match.targetAccountId)));
});

test('pool is frozen at Moscow midnight and ignores matches started during the day', () => {
  const midnightMoscowUnix = Math.floor(Date.parse('2026-07-24T00:00:00+03:00') / 1000);
  const pool = combinePlayerMatchPools([
    {
      accountId: 123,
      matches: [
        { match_id: 1, start_time: midnightMoscowUnix - 1 },
        { match_id: 2, start_time: midnightMoscowUnix },
        { match_id: 3, start_time: midnightMoscowUnix + 500 }
      ]
    }
  ], 100, midnightMoscowUnix);
  assert.deepEqual(pool.map((match) => match.match_id), [1]);
});

test('daily candidate order is deterministic for every visitor and server instance', () => {
  const matches = [
    { match_id: 10, targetAccountId: 123 },
    { match_id: 20, targetAccountId: 456 },
    { match_id: 30, targetAccountId: 123 },
    { match_id: 40, targetAccountId: 456 }
  ];
  const first = orderDailyCandidates(matches, '2026-07-24', 'same-secret');
  const second = orderDailyCandidates([...matches].reverse(), '2026-07-24', 'same-secret');
  assert.deepEqual(
    first.map((match) => match.match_id),
    second.map((match) => match.match_id)
  );
});

test('two daily matches are unique and exclude yesterday when possible', () => {
  const matches = [{ match_id: 10 }, { match_id: 20 }, { match_id: 30 }, { match_id: 40 }];
  const selected = chooseDailyMatches(matches, 2, [10, 20], () => 0, 100);
  assert.deepEqual(selected.map((match) => match.match_id), [30, 40]);
});

test('daily selection can use the first 100 matches', () => {
  const matches = Array.from({ length: 130 }, (_, index) => ({ match_id: index + 1 }));
  const selected = chooseDailyMatches(matches, 2, [], (length) => length - 1, 100);
  assert.deepEqual(selected.map((match) => match.match_id), [100, 99]);
});

test('OpenDota item constants are reindexed by numeric id', () => {
  const normalized = normalizeItemsById({
    blink: { id: 1, dname: 'Blink Dagger', img: '/blink.png' },
    boots: { id: 29, dname: 'Boots of Speed', img: '/boots.png' }
  });
  assert.equal(normalized['1'].dname, 'Blink Dagger');
  assert.equal(normalized['29'].img, '/boots.png');
});

test('public payload contains two games from configured players without results or match ids', async () => {
  const service = new GameService({
    client: createClient(),
    store: createMemoryStore(),
    playerAccountIds: [123, 456],
    matchPoolSize: 100,
    appSecret: 'secret'
  });
  const result = await service.getPublicGame(new Date('2026-07-24T10:00:00Z'));
  const serialized = JSON.stringify(result);

  assert.equal(result.schemaVersion, 6);
  assert.equal(result.games.length, 2);
  assert.ok([123, 456].includes(result.games[0].player.accountId));
  assert.equal(result.games[0].match.team[0].isTarget, true);
  assert.equal(result.games[0].match.team[0].items[0].image, 'https://cdn.example/blink.png');
  assert.equal(serialized.includes('matchId'), false);
  assert.equal(serialized.includes('targetWon'), false);
  assert.equal(serialized.includes('radiant_win'), false);
});

test('repeated answer is counted once and admin clear resets leaderboard and guesses', async () => {
  const store = createMemoryStore();
  const service = new GameService({
    client: createClient(),
    store,
    playerAccountIds: [123, 456],
    matchPoolSize: 100,
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
  assert.equal(second.alreadySubmitted, true);
  assert.equal((await service.getLeaderboard())[0].attempts, 1);

  const cleared = await service.clearLeaderboard();
  assert.equal(cleared.clearedParticipants, 1);
  assert.equal(cleared.clearedGuesses, 1);
  assert.deepEqual(await service.getLeaderboard(), []);

  const third = await service.submitGuess(payload, now);
  assert.equal(third.alreadySubmitted, false);
  assert.equal(first.correct, third.correct);
});


test('admin can switch today to three matches from one selected player', async () => {
  const store = createMemoryStore();
  const client = createClient();
  client.getPlayerMatches = async (accountId) => Array.from({ length: 8 }, (_, index) => ({
    match_id: accountId * 100 + index + 1,
    player_slot: 2,
    duration: 1800,
    game_mode: 22,
    start_time: 300 - index
  }));
  client.getMatch = async (matchId) => ({
    match_id: matchId,
    duration: 1800,
    game_mode: 22,
    radiant_win: true,
    players: [
      { account_id: 123, personaname: 'Player 123', player_slot: 2, hero_id: 1, item_0: 1 },
      { account_id: 9, player_slot: 128, hero_id: 2 }
    ]
  });

  const service = new GameService({
    client,
    store,
    playerAccountIds: [123, 456],
    matchPoolSize: 100,
    appSecret: 'secret'
  });
  const now = new Date('2026-07-24T10:00:00Z');
  const result = await service.resetToday({ matchCount: 3, playerAccountIds: [123] }, now);
  assert.equal(result.game.games.length, 3);
  assert.deepEqual(result.game.trackedPlayerIds, [123]);
  assert.ok(result.game.games.every((game) => game.player.accountId === 123));
});
