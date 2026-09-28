import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TERMINAL_ID,
  TerminalAttachInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalError,
  TerminalOpenInput,
  TerminalProviderEnvironmentError,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const encodeTerminalError = Schema.encodeUnknownSync(TerminalError);
const decodeTerminalError = Schema.decodeUnknownSync(TerminalError);

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("TerminalProviderEnvironmentError", () => {
  it("round-trips its required cause without exposing it in the message", () => {
    const cause = { operation: "read-secret", detail: "secret backend unavailable" };
    const error = new TerminalProviderEnvironmentError({
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      cause,
    });
    const encoded = encodeTerminalError(error);
    const decoded = decodeTerminalError(encoded);

    expect(decoded).toMatchObject({
      _tag: "TerminalProviderEnvironmentError",
      providerInstanceId: "codex_work",
      cause,
    });
    expect(decoded.message).toBe(
      "Could not prepare the terminal environment for provider instance: codex_work",
    );
    expect(decoded.message).not.toContain("secret backend unavailable");
  });
});

describe("TerminalOpenInput", () => {
  it("accepts a stable terminal id with a launch cwd", () => {
    expect(
      decodes(TerminalOpenInput, {
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 120,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("accepts a Workspace assignment without a client-supplied cwd", () => {
    expect(
      decodes(TerminalOpenInput, {
        terminalId: DEFAULT_TERMINAL_ID,
        workspaceId: "workspace-1",
      }),
    ).toBe(true);
  });

  it("addresses a terminal without requiring a Workspace", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
    });
    expect(parsed.workspaceId).toBeUndefined();
  });

  it("accepts ultrawide terminal dimensions from xterm fit", () => {
    expect(
      decodes(TerminalOpenInput, {
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 423,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("rejects invalid bounds", () => {
    expect(
      decodes(TerminalOpenInput, {
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 10,
        rows: 0,
      }),
    ).toBe(false);
  });

  it("requires terminalId — the client must always pick an id", () => {
    expect(
      decodes(TerminalOpenInput, {
        cwd: "/tmp/project",
        cols: 100,
        rows: 24,
      }),
    ).toBe(false);
  });

  it("accepts optional env overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      worktreePath: "/tmp/project/.awen/worktrees/feature-a",
      cols: 100,
      rows: 24,
      env: {
        AWEN_PROJECT_ROOT: "/tmp/project",
        CUSTOM_FLAG: "1",
      },
      providerInstanceId: "codex_work",
    });
    expect(parsed.env).toMatchObject({
      AWEN_PROJECT_ROOT: "/tmp/project",
      CUSTOM_FLAG: "1",
    });
    expect(parsed.worktreePath).toBe("/tmp/project/.awen/worktrees/feature-a");
    expect(parsed.providerInstanceId).toBe("codex_work");
  });

  it("drops env keys that are not valid shell identifiers", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      cols: 100,
      rows: 24,
      env: {
        "bad-key": "1",
        GOOD_KEY: "2",
      },
    });
    expect(parsed.env).toEqual({ GOOD_KEY: "2" });
  });

  it("rejects invalid provider instance ids", () => {
    for (const providerInstanceId of ["", "1invalid", "invalid id"]) {
      expect(
        decodes(TerminalOpenInput, {
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: "/tmp/project",
          providerInstanceId,
        }),
      ).toBe(false);
    }
  });
});

describe("TerminalAttachInput", () => {
  it("accepts explicit inactive-session restart intent", () => {
    const parsed = decodeSync(TerminalAttachInput, {
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      restartIfNotRunning: true,
    });

    expect(parsed.restartIfNotRunning).toBe(true);
  });
});

describe("TerminalSessionSnapshot", () => {
  it("represents a terminal Session with a nullable Workspace assignment", () => {
    const parsed = decodeSync(TerminalSessionSnapshot, {
      terminalId: DEFAULT_TERMINAL_ID,
      sessionId: DEFAULT_TERMINAL_ID,
      kind: "terminal",
      cwd: "/tmp/project",
      worktreePath: null,
      status: "running",
      pid: 42,
      history: "hello\n",
      exitCode: null,
      exitSignal: null,
      label: "Terminal",
      updatedAt: "2026-09-18T00:00:00.000Z",
      generation: 2,
    });
    expect(parsed.workspaceId).toBeUndefined();
    expect(parsed.sessionId).toBe(DEFAULT_TERMINAL_ID);
    expect(parsed.generation).toBe(2);
  });

  it("carries the current Workspace assignment when one exists", () => {
    const parsed = decodeSync(TerminalSessionSnapshot, {
      terminalId: DEFAULT_TERMINAL_ID,
      sessionId: DEFAULT_TERMINAL_ID,
      kind: "terminal",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      worktreePath: null,
      status: "running",
      pid: 42,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Terminal",
      updatedAt: "2026-09-18T00:00:00.000Z",
    });
    expect(parsed.workspaceId).toBe("workspace-1");
  });

  it("requires a stable session identity", () => {
    expect(
      decodes(TerminalSessionSnapshot, {
        terminalId: DEFAULT_TERMINAL_ID,
        kind: "terminal",
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running",
        pid: 42,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "Terminal",
        updatedAt: "2026-09-18T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("TerminalWriteInput", () => {
  it("accepts non-empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        terminalId: DEFAULT_TERMINAL_ID,
        data: "echo hello\n",
      }),
    ).toBe(true);
  });

  it("rejects empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        terminalId: DEFAULT_TERMINAL_ID,
        data: "",
      }),
    ).toBe(false);
  });

  it("rejects missing terminalId", () => {
    expect(
      decodes(TerminalWriteInput, {
        data: "echo hello\n",
      }),
    ).toBe(false);
  });
});

describe("TerminalResizeInput", () => {
  it("accepts valid size", () => {
    expect(
      decodes(TerminalResizeInput, {
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 80,
        rows: 24,
      }),
    ).toBe(true);
  });

  it("rejects missing terminalId", () => {
    expect(
      decodes(TerminalResizeInput, {
        cols: 80,
        rows: 24,
      }),
    ).toBe(false);
  });
});

describe("TerminalClearInput", () => {
  it("requires terminalId", () => {
    expect(decodes(TerminalClearInput, {})).toBe(false);
  });

  it("accepts an explicit terminalId", () => {
    const parsed = decodeSync(TerminalClearInput, {
      terminalId: DEFAULT_TERMINAL_ID,
    });
    expect(parsed.terminalId).toBe(DEFAULT_TERMINAL_ID);
  });
});

describe("TerminalCloseInput", () => {
  it("requires terminalId and accepts optional deleteHistory", () => {
    expect(decodes(TerminalCloseInput, { deleteHistory: true })).toBe(false);
    expect(
      decodes(TerminalCloseInput, {
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      }),
    ).toBe(true);
  });
});

describe("TerminalEvent", () => {
  const isoTimestamp = "2026-01-01T00:00:00.000Z";

  it("accepts output events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "output",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "line\n",
      }),
    ).toBe(true);
  });

  it("accepts exited events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "exited",
        terminalId: DEFAULT_TERMINAL_ID,
        exitCode: 0,
        exitSignal: null,
      }),
    ).toBe(true);
  });

  it("accepts closed events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "closed",
        terminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe(true);
  });

  it("accepts activity events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "activity",
        terminalId: DEFAULT_TERMINAL_ID,
        hasRunningSubprocess: true,
        label: "vim",
      }),
    ).toBe(true);
  });

  it("accepts assignment changes and omits the Workspace when unassigned", () => {
    expect(
      decodes(TerminalEvent, {
        type: "assigned",
        terminalId: DEFAULT_TERMINAL_ID,
        workspaceId: "workspace:sibling",
        sequence: 7,
      }),
    ).toBe(true);
    expect(
      decodes(TerminalEvent, {
        type: "assigned",
        terminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe(true);
  });

  it("accepts started events with snapshot worktree metadata", () => {
    expect(
      decodes(TerminalEvent, {
        type: "started",
        terminalId: DEFAULT_TERMINAL_ID,
        snapshot: {
          terminalId: DEFAULT_TERMINAL_ID,
          sessionId: DEFAULT_TERMINAL_ID,
          kind: "terminal",
          cwd: "/tmp/project/.awen/worktrees/feature-a",
          worktreePath: "/tmp/project/.awen/worktrees/feature-a",
          status: "running",
          pid: 1234,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Primary",
          updatedAt: isoTimestamp,
        },
      }),
    ).toBe(true);
  });
});
