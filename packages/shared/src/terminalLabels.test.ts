import { describe, expect, it } from "vite-plus/test";

import type { TerminalSummary } from "@awen/contracts";
import { DEFAULT_TERMINAL_ID } from "@awen/contracts";

import { getTerminalLabel, resolveTerminalSessionLabel } from "./terminalLabels.ts";

describe("getTerminalLabel", () => {
  it("uses the numeric suffix for term-* ids", () => {
    expect(getTerminalLabel(DEFAULT_TERMINAL_ID)).toBe("Terminal 1");
    expect(getTerminalLabel("term-2")).toBe("Terminal 2");
    expect(getTerminalLabel("term-12")).toBe("Terminal 12");
    expect(getTerminalLabel("terminal-3")).toBe("Terminal 3");
  });

  it("falls back to the raw id for unknown shapes", () => {
    expect(getTerminalLabel("custom-session")).toBe("custom-session");
  });
});

describe("resolveTerminalSessionLabel", () => {
  it("prefers a non-empty summary label", () => {
    const summary = { label: "  bun  " } as Pick<TerminalSummary, "label">;
    expect(resolveTerminalSessionLabel("term-1", summary)).toBe("bun");
  });

  it("falls back to getTerminalLabel when summary is missing or blank", () => {
    expect(resolveTerminalSessionLabel(DEFAULT_TERMINAL_ID, { label: "   " })).toBe("Terminal 1");
    expect(resolveTerminalSessionLabel(DEFAULT_TERMINAL_ID, null)).toBe("Terminal 1");
    expect(resolveTerminalSessionLabel("term-2", undefined)).toBe("Terminal 2");
  });
});
