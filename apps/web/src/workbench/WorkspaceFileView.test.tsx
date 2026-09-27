import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, WorkspaceId } from "@awen/contracts";

import { WorkspaceFileView } from "./WorkspaceFileView";
import { resolveViewDefinition, type ViewTarget } from "./viewRegistry";
import { workspaceFileViewDefinition, registerCoreViewDefinitions } from "./viewDefinitions";
import * as environmentsModule from "../state/environments";

vi.mock("../state/entities", () => ({
  useAwenWorkspace: (env: string, id: string) =>
    id === "ws-missing" ? null : { id, workspaceRoot: `/repos/${id}`, title: "Repo Title" },
}));

const mockPanelProps = vi.fn();

vi.mock("../components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("../components/files/FilePreviewPanel", () => ({
  default: (props: unknown) => {
    mockPanelProps(props);
    return <div data-testid="mock-file-preview-panel">{JSON.stringify(props)}</div>;
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

describe("WorkspaceFileView", () => {
  it("renders FilePreviewPanel with workspace root and explicitSave enabled", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const target: Extract<ViewTarget, { kind: "workspace" }> = {
      kind: "workspace",
      definitionId: "fileView",
      environmentId,
      workspaceId,
    };

    await act(() => {
      renderer = create(
        <WorkspaceFileView target={target} paneId="pane-1" focused availableSize={availableSize} />,
      );
    });

    const root = renderer.root.findByProps({ "data-testid": "workspace-file-view" });
    expect(root).toBeDefined();

    expect(mockPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId,
        cwd: "/repos/ws-1",
        projectName: "Repo Title",
        relativePath: null,
        explicitSave: true,
        paneId: "pane-1",
      }),
    );
  });

  it("passes initialPath and revealLine when specified on the target", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const target: Extract<ViewTarget, { kind: "workspace" }> = {
      kind: "workspace",
      definitionId: "fileView",
      environmentId,
      workspaceId,
      initialPath: "src/main.ts",
      revealLine: 42,
    };

    await act(() => {
      renderer = create(
        <WorkspaceFileView target={target} paneId="pane-2" focused availableSize={availableSize} />,
      );
    });

    expect(mockPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId,
        cwd: "/repos/ws-1",
        relativePath: "src/main.ts",
        revealLine: 42,
        explicitSave: true,
        paneId: "pane-2",
      }),
    );
  });

  it("renders offline state when workspace is missing and environment is disconnected", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const target: Extract<ViewTarget, { kind: "workspace" }> = {
      kind: "workspace",
      definitionId: "fileView",
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
        <WorkspaceFileView
          target={target}
          paneId="pane-offline"
          focused
          availableSize={availableSize}
        />,
      );
    });

    expect(
      renderer.root.findByProps({ "data-testid": "workspace-file-offline-state" }),
    ).toBeDefined();
  });

  it("renders unavailable state when workspace is missing", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const target: Extract<ViewTarget, { kind: "workspace" }> = {
      kind: "workspace",
      definitionId: "fileView",
      environmentId,
      workspaceId: "ws-missing" as WorkspaceId,
    };

    await act(() => {
      renderer = create(
        <WorkspaceFileView target={target} paneId="pane-3" focused availableSize={availableSize} />,
      );
    });

    expect(
      renderer.root.findByProps({ children: "Workspace is no longer available." }),
    ).toBeDefined();
  });

  it("is registered and resolved as fileView in viewDefinitions", () => {
    const target: Extract<ViewTarget, { kind: "workspace" }> = {
      kind: "workspace",
      definitionId: "fileView",
      environmentId,
      workspaceId,
    };
    const definition = resolveViewDefinition(target);
    expect(definition).toBeDefined();
    expect(definition?.id).toBe("fileView");
    expect(definition?.label).toBe("Files");
  });
});
