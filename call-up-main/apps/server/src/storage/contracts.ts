export type KeyValueStore<K, V> = {
  get(key: K): Promise<V | undefined>;
  set(key: K, value: V): Promise<void>;
  delete(key: K): Promise<boolean>;
  values(): Promise<V[]>;
  size(): Promise<number>;
};

export type ListStore<T> = {
  append(item: T): Promise<void>;
  list(): Promise<T[]>;
};

export type SingletonStore<T> = {
  get(): Promise<T | undefined>;
  set(value: T): Promise<void>;
};
