import type { KeyValueStore, ListStore, SingletonStore } from './contracts.js';

export const createInMemoryKeyValueStore = <K, V>(): KeyValueStore<K, V> => {
  const store = new Map<K, V>();

  return {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      return store.delete(key);
    },
    async values() {
      return [...store.values()];
    },
    async size() {
      return store.size;
    }
  };
};

type CreateInMemoryListStoreOptions = {
  maxItems?: number;
};

export const createInMemoryListStore = <T>(options: CreateInMemoryListStoreOptions = {}): ListStore<T> => {
  const maxItems = options.maxItems;
  const items: T[] = [];

  return {
    async append(item) {
      items.push(item);
      if (typeof maxItems === 'number' && maxItems > 0 && items.length > maxItems) {
        items.splice(0, items.length - maxItems);
      }
    },
    async list() {
      return [...items];
    }
  };
};

export const createInMemorySingletonStore = <T>(initialValue?: T): SingletonStore<T> => {
  let currentValue = initialValue;

  return {
    async get() {
      return currentValue;
    },
    async set(value) {
      currentValue = value;
    }
  };
};
