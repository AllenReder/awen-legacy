import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId, WorkspaceId } from "@awen/contracts";

import { runtimeTerminalIdForTarget, terminalTargetForRuntime } from "./sessionTarget";
import { targetKey } from "./viewRegistry";

const ENV_A: EnvironmentId = "env-a" as EnvironmentId;
const ENV_B: EnvironmentId = "env-b" as EnvironmentId;
const WS_A: WorkspaceId = "ws-a" as WorkspaceId;
const WS_B: WorkspaceId = "ws-b" as WorkspaceId;

describe("terminalTargetForRuntime", () => {
  it("binds a runtime terminal to a workbench target with its stable Awen identity", () => {
    const target = terminalTargetForRuntime({
      environmentId: ENV_A,
      workspaceId: WS_A,
      terminalId: "term-1",
    });

    expect(target.kind).toBe("workspaceTerminal");
    expect(target.workspaceId).toBe(WS_A);
    expect(target.terminalSessionId).toBe("term-1");
  });

  it("gives one runtime terminal the same target identity on every call", () => {
    const first = terminalTargetForRuntime({
      environmentId: ENV_A,
      workspaceId: WS_A,
      terminalId: "term-1",
    });
    const second = terminalTargetForRuntime({
      environmentId: ENV_A,
      workspaceId: WS_A,
      terminalId: "term-1",
    });

    expect(targetKey(first)).toBe(targetKey(second));
  });

  it("carries no Workspace requirement for an unassigned terminal", () => {
    const target = terminalTargetForRuntime({
      environmentId: ENV_A,
      terminalId: "term-1",
    });

    expect(target.workspaceId).toBeUndefined();
    expect(target.terminalSessionId).toBe("term-1");
  });
});

describe("runtimeTerminalIdForTarget", () => {
  it("resolves a workbench target back to the runtime terminal it addresses", () => {
    const target = terminalTargetForRuntime({
      environmentId: ENV_A,
      workspaceId: WS_A,
      terminalId: "term-7",
    });

    expect(runtimeTerminalIdForTarget(target)).toBe("term-7");
  });

  it("keeps one target identity when the Workspace assignment changes", () => {
    const inA = terminalTargetForRuntime({
      environmentId: ENV_A,
      workspaceId: WS_A,
      terminalId: "term-1",
    });
    const inB = terminalTargetForRuntime({
      environmentId: ENV_A,
      workspaceId: WS_B,
      terminalId: "term-1",
    });

    expect(targetKey(inA)).toBe(targetKey(inB));
    expect(runtimeTerminalIdForTarget(inA)).toBe("term-1");
    expect(runtimeTerminalIdForTarget(inB)).toBe("term-1");
  });

  it("scopes the same terminal id by Environment", () => {
    const inA = terminalTargetForRuntime({
      environmentId: ENV_A,
      workspaceId: WS_A,
      terminalId: "term-1",
    });
    const inB = terminalTargetForRuntime({
      environmentId: ENV_B,
      workspaceId: WS_A,
      terminalId: "term-1",
    });

    expect(targetKey(inA)).not.toBe(targetKey(inB));
  });
});
