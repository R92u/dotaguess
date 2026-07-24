import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDailyMatch } from '../src/gameService.js';
import { getMoscowDateKey, getNextMoscowMidnightIso } from '../src/time.js';

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

test('daily match selection excludes previous match when possible', () => {
  const matches = [{ match_id: 10 }, { match_id: 20 }, { match_id: 30 }];
  const selected = chooseDailyMatch(matches, 10, () => 0);
  assert.equal(selected.match_id, 20);
});

test('daily match selection keeps only first 20 unique matches', () => {
  const matches = Array.from({ length: 30 }, (_, index) => ({ match_id: index + 1 }));
  const selected = chooseDailyMatch(matches, null, (length) => {
    assert.equal(length, 20);
    return 19;
  });
  assert.equal(selected.match_id, 20);
});

test('public game payload does not expose match result or match id', async () => {
  const records = new Map();
  const store = {
    async get(key) { return records.get(key) || null; },
    async getPrevious() { return null; },
    async set(key, value) { records.set(key, value); }
  };
  const client = {
    async getRecentMatches() {
      return [{ match_id: 777, player_slot: 2, duration: 2400, game_mode: 22 }];
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
        items: {}
      };
    },
    async getMatch() {
      return {
        match_id: 777,
        duration: 2400,
        game_mode: 22,
        radiant_win: true,
        players: [
          { account_id: null, player_slot: 2, hero_id: 1, kills: 5, deaths: 2, assists: 8 },
          { account_id: 9, player_slot: 128, hero_id: 2, kills: 2, deaths: 5, assists: 3 }
        ]
      };
    },
    imageUrl(value) { return value ? `https://cdn.example${value}` : null; }
  };

  const { GameService } = await import('../src/gameService.js');
  const service = new GameService({ client, store, playerAccountId: 123, appSecret: 'secret' });
  const result = await service.getPublicGame(new Date('2026-07-24T10:00:00Z'));
  const serialized = JSON.stringify(result);

  assert.equal(result.match.team[0].isTarget, true);
  assert.equal('matchId' in result, false);
  assert.equal(serialized.includes('targetWon'), false);
  assert.equal(serialized.includes('radiant_win'), false);
});
