import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, WorkspaceId } from "@awen/contracts";

import { WorkspaceGitView } from "./WorkspaceGitView";
import { resolveViewDefinition, type ViewTarget } from "./viewRegistry";
import { registerCoreViewDefinitions } from "./viewDefinitions";
import * as environmentsModule from "../state/environments";

vi.mock("../state/entities", () => ({
  useAwenWorkspace: (env: string, id: string) =>
    id === "ws-missing" ? null : { id, workspaceRoot: `/repos/${id}`, title: "Repo Title" },
}));

const mockDiffPanelProps = vi.fn();

vi.mock("../components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("../components/DiffPanel", () => ({
  default: (props: unknown) => {
    mockDiffPanelProps(props);
    return <div data-testid="mock-diff-panel">{JSON.stringify(props)}</div>;
  },
}));

let renderer: ReactTestRenderer;

beforeEach(() => {
  registerCoreViewDefinitions({ force: true });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const environmentId = "local" as EnvironmentId;
const workspaceId = "ws-1" as WorkspaceId;
const availableSize = { width: 800, height: 600 };

describe("WorkspaceGitView", () => {
  it("renders DiffPanel with workspaceScope and initialGitScope enabled", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const target: Extract<ViewTarget, { kind: "workspace" }> = {
      kind: "workspace",
      definitionId: "gitView",
      environmentId,
      workspaceId,
    };

    await act(() => {
      renderer = create(
        <WorkspaceGitView target={target} paneId="pane-1" focused availableSize={availableSize} />,
      );
    });

    const root = renderer.root.findByProps({ "data-testid": "workspace-git-view" });
    expect(root).toBeDefined();

    expect(mockDiffPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "embedded",
        workspaceScope: {
          environmentId,
          workspaceId,
          cwd: "/repos/ws-1",
        },
        initialGitScope: "unstaged",
      }),
    );
  });

  it("renders offline state when workspace is missing and environment is disconnected", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const target: Extract<ViewTarget, { kind: "workspace" }> = {
      kind: "workspace",
      definitionId: "gitView",
      environmentId: "env-offline" as EnvironmentId,
      workspaceId: "ws-missing" as WorkspaceId,
    };

    vi.spyOn(environmentsModule, "useEnvironment").mockReturnValueOnce({
      environmentId: "env-offline" as EnvironmentId,
      label: "WSL-Remote",
      displayUrl: null,
      entry: {} as any,
      connection: {
        phase: "reconnecting",
        error: "Connection lost",
        traceId: null,
        failureCode: null,
      },
      serverConfig: null,
    });

    await act(() => {
      renderer = create(
        <WorkspaceGitView
          target={target}
          paneId="pane-offline"
          focused
          availableSize={availableSize}
        />,
      );
    });

    expect(
      renderer.root.findByProps({ "data-testid": "workspace-git-offline-state" }),
    ).toBeDefined();
  });

  it("renders unavailable state when workspace is missing", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const target: Extract<ViewTarget, { kind: "workspace" }> = {
      kind: "workspace",
      definitionId: "gitView",
      environmentId,
      workspaceId: "ws-missing" as WorkspaceId,
    };

    await act(() => {
      renderer = create(
        <WorkspaceGitView target={target} paneId="pane-2" focused availableSize={availableSize} />,
      );
    });

    expect(
      renderer.root.findByProps({ children: "Workspace is no longer available." }),
    ).toBeDefined();
  });

  it("is registered and resolved as gitView in viewDefinitions", () => {
    const target: Extract<ViewTarget, { kind: "workspace" }> = {
      kind: "workspace",
      definitionId: "gitView",
      environmentId,
      workspaceId,
    };
    const definition = resolveViewDefinition(target);
    expect(definition).toBeDefined();
    expect(definition?.id).toBe("gitView");
    expect(definition?.label).toBe("Changes");
  });
});
