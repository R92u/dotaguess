import { JsonStore } from './storage.js';
import { PostgresStore } from './postgresStore.js';

export async function createStore({ databaseUrl, dataDir }) {
  const store = databaseUrl ? new PostgresStore(databaseUrl) : new JsonStore(dataDir);
  await store.init();
  return store;
}
