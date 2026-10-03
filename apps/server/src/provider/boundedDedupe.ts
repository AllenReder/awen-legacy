/**
 * Dedupe collections with a fixed capacity.
 *
 * Provider adapters keep per-session guard sets so a redelivered event cannot
 * fork the timeline twice. Only the recent window matters: a redelivery
 * repeats events the adapter just handled, not the whole session history, so
 * an unbounded set buys nothing while growing for the life of a long session.
 *
 * Both classes are insertion-ordered, and writing an existing entry moves it to
 * the newest position, so eviction always drops the entry that has gone
 * untouched the longest.
 */

// `keys()` is the only iterator that yields the deletion key for both a Set
// (its values) and a Map (its keys).
function evictExcess<K>(entries: Set<K>, capacity: number): void;
function evictExcess<K, V>(entries: Map<K, V>, capacity: number): void;
function evictExcess(entries: Set<unknown> | Map<unknown, unknown>, capacity: number): void {
  while (entries.size > capacity) {
    const oldest = entries.keys().next();
    if (oldest.done === true) {
      return;
    }
    entries.delete(oldest.value);
  }
}

const normalizeCapacity = (capacity: number): number =>
  Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 1;

export class BoundedDedupeSet<T> {
  readonly #entries = new Set<T>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = normalizeCapacity(capacity);
  }

  add(value: T): void {
    this.#entries.delete(value);
    this.#entries.add(value);
    evictExcess(this.#entries, this.#capacity);
  }

  has(value: T): boolean {
    return this.#entries.has(value);
  }

  delete(value: T): boolean {
    return this.#entries.delete(value);
  }

  clear(): void {
    this.#entries.clear();
  }
}

export class BoundedDedupeMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = normalizeCapacity(capacity);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    evictExcess(this.#entries, this.#capacity);
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
