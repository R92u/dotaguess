import fs from 'node:fs/promises';
import path from 'node:path';

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
      await this.#atomicWrite({ version: 1, games: {} });
    }
  }

  async read() {
    await this.init();
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.games !== 'object') {
        throw new Error('Invalid storage format');
      }
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError || error.message === 'Invalid storage format') {
        const backup = `${this.filePath}.broken-${Date.now()}`;
        await fs.rename(this.filePath, backup).catch(() => {});
        const empty = { version: 1, games: {} };
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
    this.writeQueue = this.writeQueue.then(async () => {
      const data = await this.read();
      data.games[dateKey] = game;

      // Храним только последние 60 дней, чтобы файл не рос бесконечно.
      const keys = Object.keys(data.games).sort();
      for (const oldKey of keys.slice(0, Math.max(0, keys.length - 60))) {
        delete data.games[oldKey];
      }

      await this.#atomicWrite(data);
    });
    return this.writeQueue;
  }

  async #atomicWrite(data) {
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}
