import { describe, expect, it } from 'vitest';
import { createInMemoryListStore } from './in-memory.js';

describe('createInMemoryListStore', () => {
  it('keeps only the latest N items when maxItems is configured', async () => {
    const store = createInMemoryListStore<number>({ maxItems: 3 });

    await store.append(1);
    await store.append(2);
    await store.append(3);
    await store.append(4);

    await expect(store.list()).resolves.toEqual([2, 3, 4]);
  });
});
