import fs from 'node:fs/promises';
import path from 'node:path';

function emptyState() {
  return {
    version: 2,
    games: {},
    leaderboard: {},
    guesses: {},
    leaderboardResetAt: null
  };
}

function normalizeState(value) {
  const state = value && typeof value === 'object' ? value : {};
  return {
    version: 2,
    games: state.games && typeof state.games === 'object' ? state.games : {},
    leaderboard:
      state.leaderboard && typeof state.leaderboard === 'object' ? state.leaderboard : {},
    guesses: state.guesses && typeof state.guesses === 'object' ? state.guesses : {},
    leaderboardResetAt: state.leaderboardResetAt || null
  };
}

function leaderboardEntries(state, limit = 50) {
  return Object.values(state.leaderboard || {})
    .map((entry) => ({
      name: entry.name,
      wins: Number(entry.wins) || 0,
      attempts: Number(entry.attempts) || 0,
      updatedAt: entry.updatedAt || null
    }))
    .sort((a, b) =>
      b.wins - a.wins ||
      b.attempts - a.attempts ||
      String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')) ||
      a.name.localeCompare(b.name, 'ru')
    )
    .slice(0, limit)
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}

export class JsonStore {
  constructor(directory) {
    this.directory = directory;
    this.filePath = path.join(directory, 'daily-games.json');
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.#atomicWrite(emptyState());
    }
  }

  async read() {
    await this.init();
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid storage format');
      return normalizeState(parsed);
    } catch (error) {
      if (error instanceof SyntaxError || error.message === 'Invalid storage format') {
        const backup = `${this.filePath}.broken-${Date.now()}`;
        await fs.rename(this.filePath, backup).catch(() => {});
        const empty = emptyState();
        await this.#atomicWrite(empty);
        return empty;
      }
      throw error;
    }
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

      // Храним только последние 60 дней, чтобы файл не рос бесконечно.
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

      // Ограничиваем историю ответов примерно одним годом при двух матчах в день.
      const guessKeys = Object.keys(data.guesses);
      if (guessKeys.length > 250_000) {
        guessKeys
          .sort((a, b) => String(data.guesses[a].createdAt).localeCompare(String(data.guesses[b].createdAt)))
          .slice(0, guessKeys.length - 200_000)
          .forEach((key) => delete data.guesses[key]);
      }

      return { alreadySubmitted: false, correct: Boolean(correct), guess, actual };
    });
  }

  async clearLeaderboard() {
    return this.#mutate((data) => {
      const clearedParticipants = Object.keys(data.leaderboard || {}).length;
      const clearedGuesses = Object.keys(data.guesses || {}).length;
      data.leaderboard = {};
      data.guesses = {};
      data.leaderboardResetAt = new Date().toISOString();
      return { clearedParticipants, clearedGuesses, resetAt: data.leaderboardResetAt };
    });
  }

  async getLeaderboardSnapshot(limit = 50) {
    const data = await this.read();
    return {
      entries: leaderboardEntries(data, limit),
      resetAt: data.leaderboardResetAt || null
    };
  }

  async getLeaderboard(limit = 50) {
    const data = await this.read();
    return leaderboardEntries(data, limit);
  }

  async #mutate(mutator) {
    let result;
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const data = await this.read();
      result = mutator(data);
      await this.#atomicWrite(data);
    });
    await this.writeQueue;
    return result;
  }

  async #atomicWrite(data) {
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

export { emptyState, leaderboardEntries, normalizeState };
