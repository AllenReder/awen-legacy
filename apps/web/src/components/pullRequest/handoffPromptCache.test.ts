import { describe, expect, it } from "vite-plus/test";

import { createHandoffPromptCache } from "./handoffPromptCache";

describe("handoff prompt cache", () => {
  it("stays bounded instead of holding every hand-off of the session", () => {
    const cache = createHandoffPromptCache();
    for (let index = 0; index < 200; index += 1) {
      cache.remember(`draft-${index}`, `hand-off ${index}`);
    }

    const retained = Array.from({ length: 200 }, (_, index) => `draft-${index}`).filter(
      (target) => cache.get(target) !== undefined,
    );

    // A map that only ever grows is the defect: prompts are large, and every draft a reader
    // hands off to would otherwise stay resident for the life of the process. The exact cap is
    // the cache's business, not the test's.
    expect(retained.length).toBeLessThanOrEqual(64);
    expect(retained.length).toBeGreaterThan(0);
    expect(cache.get("draft-199")).toBe("hand-off 199");
  });

  it("remembers the newest hand-off for a draft it already knows", () => {
    const cache = createHandoffPromptCache();

    cache.remember("draft-1", "the first hand-off");
    cache.remember("draft-1", "the second hand-off");

    expect(cache.get("draft-1")).toBe("the second hand-off");
    expect(cache.get("draft-2")).toBeUndefined();
  });
});
