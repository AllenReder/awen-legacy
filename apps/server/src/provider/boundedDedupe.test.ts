import { describe, expect, it } from "vite-plus/test";

import { BoundedDedupeMap, BoundedDedupeSet } from "./boundedDedupe.ts";

describe("BoundedDedupeSet", () => {
  it("evicts the oldest entry once the capacity is exceeded", () => {
    const ids = new BoundedDedupeSet<string>(3);

    for (const id of ["first", "second", "third", "fourth"]) {
      ids.add(id);
    }

    expect(ids.has("first")).toBe(false);
    for (const id of ["second", "third", "fourth"]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("keeps an id that already exists instead of storing it twice", () => {
    const ids = new BoundedDedupeSet<string>(2);

    ids.add("tool");
    ids.add("tool");

    expect(ids.has("tool")).toBe(true);
    expect(ids.delete("tool")).toBe(true);
    expect(ids.has("tool")).toBe(false);
  });

  it("treats a repeated write as fresh, so a live id outlives colder ones", () => {
    const ids = new BoundedDedupeSet<string>(2);

    ids.add("hot");
    ids.add("cold");
    // "hot" is re-delivered, which must not let the next insert evict it.
    ids.add("hot");
    ids.add("newest");

    expect(ids.has("cold")).toBe(false);
    expect(ids.has("hot")).toBe(true);
    expect(ids.has("newest")).toBe(true);
  });

  it("still bounds the set when the capacity is not a usable number", () => {
    const ids = new BoundedDedupeSet<string>(Number.NaN);

    ids.add("first");
    ids.add("second");

    expect(ids.has("first")).toBe(false);
    expect(ids.has("second")).toBe(true);
  });

  it("clears every retained id", () => {
    const ids = new BoundedDedupeSet<string>(4);
    ids.add("a");
    ids.add("b");

    ids.clear();

    expect(ids.has("a")).toBe(false);
    expect(ids.has("b")).toBe(false);
    expect(ids.delete("a")).toBe(false);
  });
});

describe("BoundedDedupeMap", () => {
  it("evicts the least recently written key", () => {
    const entries = new BoundedDedupeMap<string, number>(2);

    entries.set("first", 1);
    entries.set("second", 2);
    entries.set("first", 11);
    entries.set("third", 3);

    expect(entries.get("first")).toBe(11);
    expect(entries.get("second")).toBeUndefined();
    expect(entries.get("third")).toBe(3);
  });

  it("deletes and clears retained keys", () => {
    const entries = new BoundedDedupeMap<string, number>(4);
    entries.set("a", 1);
    entries.set("b", 2);

    expect(entries.delete("a")).toBe(true);
    expect(entries.delete("a")).toBe(false);
    entries.clear();

    expect(entries.get("b")).toBeUndefined();
  });
});
