import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 3;

function emptyState() {
  return {
    version: STATE_VERSION,
    games: {},
    dailySettings: {},
    leaderboard: {},
    guesses: {},
    leaderboardResetAt: null,
    gameResetAt: null
  };
}

function normalizeState(value) {
  const state = value && typeof value === 'object' ? value : {};
  return {
    version: STATE_VERSION,
    games: state.games && typeof state.games === 'object' ? state.games : {},
    dailySettings:
      state.dailySettings && typeof state.dailySettings === 'object' ? state.dailySettings : {},
    leaderboard:
      state.leaderboard && typeof state.leaderboard === 'object' ? state.leaderboard : {},
    guesses: state.guesses && typeof state.guesses === 'object' ? state.guesses : {},
    leaderboardResetAt: state.leaderboardResetAt || null,
    gameResetAt: state.gameResetAt || null
  };
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedLeaderboardRows(state) {
  return Object.entries(state.leaderboard || {}).map(([participantId, entry]) => ({
    participantId,
    name: String(entry?.name || 'Без имени'),
    wins: Math.max(0, normalizeInteger(entry?.wins)),
    attempts: Math.max(0, normalizeInteger(entry?.attempts)),
    createdAt: entry?.createdAt || null,
    updatedAt: entry?.updatedAt || null
  }));
}

function sortLeaderboardRows(rows) {
  return rows.sort((a, b) =>
    b.wins - a.wins ||
    b.attempts - a.attempts ||
    String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')) ||
    a.name.localeCompare(b.name, 'ru')
  );
}

function leaderboardEntries(state, limit = 50) {
  return sortLeaderboardRows(normalizedLeaderboardRows(state))
    .slice(0, limit)
    .map(({ participantId: _participantId, createdAt: _createdAt, ...entry }, index) => ({
      rank: index + 1,
      ...entry
    }));
}

function adminLeaderboardEntries(state, limit = 500) {
  return sortLeaderboardRows(normalizedLeaderboardRows(state))
    .slice(0, limit)
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}

function trimOldGamesAndSettings(data) {
  const keys = Object.keys(data.games).sort();
  for (const oldKey of keys.slice(0, Math.max(0, keys.length - 60))) {
    delete data.games[oldKey];
  }

  const settingsKeys = Object.keys(data.dailySettings).sort();
  for (const oldKey of settingsKeys.slice(0, Math.max(0, settingsKeys.length - 90))) {
    delete data.dailySettings[oldKey];
  }
}

function removeGuessesForDate(data, dateKey) {
  let removedGuesses = 0;
  const deductions = new Map();

  for (const [key, guess] of Object.entries(data.guesses || {})) {
    if (String(guess?.dateKey || '') !== dateKey && !key.startsWith(`${dateKey}:`)) continue;
    removedGuesses += 1;
    const participantId = String(guess?.participantId || '');
    if (participantId) {
      const current = deductions.get(participantId) || { attempts: 0, wins: 0 };
      current.attempts += 1;
      if (guess?.correct) current.wins += 1;
      deductions.set(participantId, current);
    }
    delete data.guesses[key];
  }

  for (const [participantId, deduction] of deductions) {
    const participant = data.leaderboard[participantId];
    if (!participant) continue;
    participant.attempts = Math.max(0, normalizeInteger(participant.attempts) - deduction.attempts);
    participant.wins = Math.max(0, normalizeInteger(participant.wins) - deduction.wins);
    participant.updatedAt = new Date().toISOString();
  }

  return removedGuesses;
}

function applyDailyReset(data, { dateKey, matchCount, playerAccountIds }) {
  const now = new Date().toISOString();
  const previous = data.dailySettings[dateKey] || {};
  const resetNonce = Math.max(0, normalizeInteger(previous.resetNonce)) + 1;
  const revision = `${Date.now()}-${resetNonce}-${crypto.randomBytes(4).toString('hex')}`;

  data.dailySettings[dateKey] = {
    matchCount,
    playerAccountIds,
    resetNonce,
    revision,
    updatedAt: now
  };
  delete data.games[dateKey];
  const clearedGuesses = removeGuessesForDate(data, dateKey);
  data.gameResetAt = now;
  trimOldGamesAndSettings(data);

  return {
    dateKey,
    matchCount,
    playerAccountIds,
    resetNonce,
    revision,
    clearedGuesses,
    resetAt: now
  };
}

function applyLeaderboardUpsert(data, { participantId, name, wins, attempts }) {
  const now = new Date().toISOString();
  const id = participantId || `admin_${crypto.randomUUID().replaceAll('-', '')}`;
  const previous = data.leaderboard[id] || {};
  data.leaderboard[id] = {
    participantId: id,
    name,
    wins,
    attempts,
    createdAt: previous.createdAt || now,
    updatedAt: now
  };
  return { participantId: id, ...data.leaderboard[id] };
}

function applyLeaderboardDelete(data, participantId) {
  const existed = Boolean(data.leaderboard[participantId]);
  delete data.leaderboard[participantId];
  let clearedGuesses = 0;
  for (const [key, guess] of Object.entries(data.guesses || {})) {
    if (String(guess?.participantId || '') !== participantId) continue;
    delete data.guesses[key];
    clearedGuesses += 1;
  }
  return { deleted: existed, clearedGuesses };
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
      trimOldGamesAndSettings(data);
    });
  }

  async getDailySettings(dateKey) {
    const data = await this.read();
    return data.dailySettings[dateKey] || null;
  }

  async resetDailyGame(payload) {
    return this.#mutate((data) => applyDailyReset(data, payload));
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
      participant.attempts = normalizeInteger(participant.attempts) + 1;
      if (correct) participant.wins = normalizeInteger(participant.wins) + 1;
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

  async upsertLeaderboardEntry(payload) {
    return this.#mutate((data) => applyLeaderboardUpsert(data, payload));
  }

  async deleteLeaderboardEntry(participantId) {
    return this.#mutate((data) => applyLeaderboardDelete(data, participantId));
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

  async getAdminLeaderboard(limit = 500) {
    const data = await this.read();
    return adminLeaderboardEntries(data, limit);
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

export {
  STATE_VERSION,
  adminLeaderboardEntries,
  applyDailyReset,
  applyLeaderboardDelete,
  applyLeaderboardUpsert,
  emptyState,
  leaderboardEntries,
  normalizeState
};
