import { describe, expect, it, beforeEach } from "vite-plus/test";
import type { ComponentType } from "react";

import type { AgentSessionId, EnvironmentId, WorkspaceId } from "@awen/contracts";

import {
  clearViewRegistry,
  emptyViewBinding,
  registerViewDefinition,
  resolveViewDefinition,
  targetKey,
  targetsEqual,
  type ViewDefinition,
  type ViewTarget,
} from "./viewRegistry";
import { terminalTargetForRuntime } from "./sessionTarget";

const FIX_ENV: EnvironmentId = "primary" as EnvironmentId;
const FIX_WORKSPACE: WorkspaceId = "ws-1" as WorkspaceId;
const FIX_AGENT: AgentSessionId = "agent-1" as AgentSessionId;

const StubComponent: ComponentType<{
  target: ViewTarget;
  paneId: string;
  focused: boolean;
}> = () => null;

beforeEach(() => {
  clearViewRegistry();
});

function agentTarget(
  overrides: Partial<Extract<ViewTarget, { kind: "agentSession" }>> = {},
): Extract<ViewTarget, { kind: "agentSession" }> {
  return {
    kind: "agentSession",
    environmentId: FIX_ENV,
    agentSessionId: FIX_AGENT,
    ...overrides,
  };
}

function terminalTarget(
  overrides: Partial<Extract<ViewTarget, { kind: "workspaceTerminal" }>> = {},
): Extract<ViewTarget, { kind: "workspaceTerminal" }> {
  return {
    ...terminalTargetForRuntime({
      environmentId: FIX_ENV,
      workspaceId: FIX_WORKSPACE,
      terminalId: "term-1",
    }),
    ...overrides,
  };
}

describe("targetKey", () => {
  it("is stable across calls for the same target", () => {
    const a = agentTarget();
    const b = agentTarget();
    expect(targetKey(a)).toBe(targetKey(b));
  });

  it("differentiates targets of different kinds", () => {
    expect(targetKey(agentTarget())).not.toBe(targetKey(terminalTarget()));
  });

  it("differentiates targets that differ only in their leaf id", () => {
    const a = agentTarget({ agentSessionId: "agent-1" as AgentSessionId });
    const b = agentTarget({ agentSessionId: "agent-2" as AgentSessionId });
    expect(targetKey(a)).not.toBe(targetKey(b));
  });

  it("keys an Agent Pane by Environment and Session", () => {
    expect(targetKey(agentTarget())).toBe('["agentSession","primary","agent-1"]');
  });
});

describe("targetsEqual", () => {
  it("returns true for two structurally identical targets of the same kind", () => {
    expect(targetsEqual(agentTarget(), agentTarget())).toBe(true);
  });

  it("returns false across kinds", () => {
    expect(targetsEqual(agentTarget(), terminalTarget())).toBe(false);
  });

  it("returns false when any leaf id differs", () => {
    expect(
      targetsEqual(agentTarget(), agentTarget({ agentSessionId: "x" as AgentSessionId })),
    ).toBe(false);
  });
});

describe("registerViewDefinition / resolveViewDefinition", () => {
  const agentDefinition: ViewDefinition<Extract<ViewTarget, { kind: "agentSession" }>> = {
    id: "agentSession",
    label: "Agent",
    accepts: (target): target is Extract<ViewTarget, { kind: "agentSession" }> =>
      target.kind === "agentSession",
    bind: emptyViewBinding,
    Component: StubComponent as unknown as ViewDefinition<
      Extract<ViewTarget, { kind: "agentSession" }>
    >["Component"],
  };

  const terminalDefinition: ViewDefinition<Extract<ViewTarget, { kind: "workspaceTerminal" }>> = {
    id: "workspaceTerminal",
    label: "Terminal",
    accepts: (target): target is Extract<ViewTarget, { kind: "workspaceTerminal" }> =>
      target.kind === "workspaceTerminal",
    bind: emptyViewBinding,
    Component: StubComponent as unknown as ViewDefinition<
      Extract<ViewTarget, { kind: "workspaceTerminal" }>
    >["Component"],
  };

  it("returns null when no definition is registered for the target", () => {
    expect(resolveViewDefinition(agentTarget())).toBeNull();
  });

  it("returns the matching definition once registered", () => {
    registerViewDefinition(agentDefinition);
    expect(resolveViewDefinition(agentTarget())?.id).toBe("agentSession");
  });

  it("dispatches by target kind across multiple registered definitions", () => {
    registerViewDefinition(agentDefinition);
    registerViewDefinition(terminalDefinition);
    expect(resolveViewDefinition(agentTarget())?.id).toBe("agentSession");
    expect(resolveViewDefinition(terminalTarget())?.id).toBe("workspaceTerminal");
  });

  it("resolves registered workspace fileView definition", () => {
    const fileViewDefinition: ViewDefinition<Extract<ViewTarget, { kind: "workspace" }>> = {
      id: "fileView",
      label: "Files",
      accepts: (target): target is Extract<ViewTarget, { kind: "workspace" }> =>
        target.kind === "workspace" && target.definitionId === "fileView",
      bind: emptyViewBinding,
      Component: StubComponent as unknown as ViewDefinition<
        Extract<ViewTarget, { kind: "workspace" }>
      >["Component"],
    };
    registerViewDefinition(fileViewDefinition);

    const target: ViewTarget = {
      kind: "workspace",
      definitionId: "fileView",
      environmentId: FIX_ENV,
      workspaceId: FIX_WORKSPACE,
    };
    expect(resolveViewDefinition(target)?.id).toBe("fileView");
    expect(targetKey(target)).toBe(
      JSON.stringify(["workspace", "fileView", FIX_ENV, FIX_WORKSPACE]),
    );
  });

  it("resolves registered workspace gitView definition", () => {
    const gitViewDefinition: ViewDefinition<Extract<ViewTarget, { kind: "workspace" }>> = {
      id: "gitView",
      label: "Changes",
      accepts: (target): target is Extract<ViewTarget, { kind: "workspace" }> =>
        target.kind === "workspace" && target.definitionId === "gitView",
      bind: emptyViewBinding,
      Component: StubComponent as unknown as ViewDefinition<
        Extract<ViewTarget, { kind: "workspace" }>
      >["Component"],
    };
    registerViewDefinition(gitViewDefinition);

    const target: ViewTarget = {
      kind: "workspace",
      definitionId: "gitView",
      environmentId: FIX_ENV,
      workspaceId: FIX_WORKSPACE,
    };
    expect(resolveViewDefinition(target)?.id).toBe("gitView");
    expect(targetKey(target)).toBe(
      JSON.stringify(["workspace", "gitView", FIX_ENV, FIX_WORKSPACE]),
    );
  });

  it("clearViewRegistry removes all registrations", () => {
    registerViewDefinition(agentDefinition);
    clearViewRegistry();
    expect(resolveViewDefinition(agentTarget())).toBeNull();
  });
});
