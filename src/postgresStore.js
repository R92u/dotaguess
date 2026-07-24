import { emptyState, leaderboardEntries, normalizeState } from './storage.js';

export class PostgresStore {
  constructor(databaseUrl) {
    this.databaseUrl = databaseUrl;
    this.pool = null;
  }

  async init() {
    if (this.pool) return;
    const { Pool } = await import('pg');
    this.pool = new Pool({
      connectionString: this.databaseUrl,
      ssl: this.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000
    });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS dota_guess_state (
        id SMALLINT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      `INSERT INTO dota_guess_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(emptyState())]
    );
  }

  async read() {
    await this.init();
    const result = await this.pool.query('SELECT data FROM dota_guess_state WHERE id = 1');
    return normalizeState(result.rows[0]?.data);
  }

  async get(dateKey) {
    const data = await this.read();
    return data.games[dateKey] || null;
  }

  async getPrevious(dateKey) {
    const data = await this.read();
    const keys = Object.keys(data.games).filter((key) => key < dateKey).sort();
    return keys.length ? data.games[keys.at(-1)] : null;
  }

  async set(dateKey, game) {
    return this.#mutate((data) => {
      data.games[dateKey] = game;
      const keys = Object.keys(data.games).sort();
      for (const oldKey of keys.slice(0, Math.max(0, keys.length - 60))) {
        delete data.games[oldKey];
      }
    });
  }

  async recordGuess({ participantId, nickname, dateKey, slot, correct, guess, actual, matchId }) {
    return this.#mutate((data) => {
      const guessKey = `${dateKey}:${slot}:${participantId}`;
      const existing = data.guesses[guessKey];
      if (existing) {
        return {
          alreadySubmitted: true,
          correct: Boolean(existing.correct),
          guess: existing.guess,
          actual: existing.actual
        };
      }

      const now = new Date().toISOString();
      const participant = data.leaderboard[participantId] || {
        participantId,
        name: nickname,
        wins: 0,
        attempts: 0,
        createdAt: now
      };
      participant.name = nickname;
      participant.attempts = (Number(participant.attempts) || 0) + 1;
      if (correct) participant.wins = (Number(participant.wins) || 0) + 1;
      participant.updatedAt = now;
      data.leaderboard[participantId] = participant;

      data.guesses[guessKey] = {
        participantId,
        nickname,
        dateKey,
        slot,
        matchId,
        guess,
        actual,
        correct: Boolean(correct),
        createdAt: now
      };

      return { alreadySubmitted: false, correct: Boolean(correct), guess, actual };
    });
  }

  async getLeaderboard(limit = 50) {
    const data = await this.read();
    return leaderboardEntries(data, limit);
  }

  async #mutate(mutator) {
    await this.init();
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await db.query('SELECT data FROM dota_guess_state WHERE id = 1 FOR UPDATE');
      const data = normalizeState(result.rows[0]?.data);
      const mutationResult = mutator(data);
      await db.query(
        'UPDATE dota_guess_state SET data = $1::jsonb, updated_at = NOW() WHERE id = 1',
        [JSON.stringify(data)]
      );
      await db.query('COMMIT');
      return mutationResult;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
}
