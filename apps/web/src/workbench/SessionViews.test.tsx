import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { type AgentSessionId, type EnvironmentId, type WorkspaceId } from "@awen/contracts";
import { AgentView } from "./AgentView";
import { TerminalView } from "./TerminalView";
import { terminalTargetForRuntime } from "./sessionTarget";
import { resetWorkbenchStore, useWorkbenchStore } from "./workbenchStore";
import { getActiveTab } from "./workbenchState";
import { useComposerDraftStore } from "../composerDraftStore";

// The trusted runtime adapters are the agreed integration boundary. Present
// their inputs as text, without starting a provider, PTY, or GPU in Node.
vi.mock("../state/entities", () => ({
  useAwenProjects: () => [],
  useAwenAgentSessionShell: (_environment: unknown, session: string) => ({
    threadId: `thread-${session}`,
    workspaceId: "workspace" as WorkspaceId,
    status: session === "closed-session" ? "closed" : "open",
  }),
  useAwenWorkspace: () => ({ workspaceRoot: "/checkout" }),
  useThread: () => null,
  useThreadShell: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("../components/ChatView", () => ({
  default: (props: Record<string, unknown>) => <output {...props}>{JSON.stringify(props)}</output>,
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({
  TerminalViewport: (props: unknown) => <output>{JSON.stringify(props)}</output>,
}));
let renderer: ReactTestRenderer;
const initialComposerState = useComposerDraftStore.getInitialState();
afterEach(async () => {
  await act(() => renderer?.unmount());
  useComposerDraftStore.setState(initialComposerState);
  vi.unstubAllGlobals();
});
const environmentId = "local" as EnvironmentId;
const workspaceId = "workspace" as WorkspaceId;
const availableSize = { width: 640, height: 480 };

it("isolates Agent data by Session target and forwards focus and measured size to the existing presentation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(
      <>
        {["one", "two"].map((id) => (
          <AgentView
            key={id}
            target={{
              kind: "agentSession",
              environmentId,
              agentSessionId: id as AgentSessionId,
            }}
            paneId={id}
            focused={id === "two"}
            availableSize={availableSize}
          />
        ))}
      </>,
    );
  });
  expect(
    renderer!.root.findAllByType("output").map((node) => JSON.parse(node.children[0] as string)),
  ).toEqual([
    expect.objectContaining({ threadId: "thread-one", focused: false, availableSize }),
    expect.objectContaining({ threadId: "thread-two", focused: true, availableSize }),
  ]);
});

it("reattaches the same Terminal identity and forwards changing Pane dimensions and focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const target = terminalTargetForRuntime({ environmentId, workspaceId, terminalId: "shell" });
  await act(() => {
    renderer = create(
      <TerminalView target={target} paneId="pane" focused={false} availableSize={availableSize} />,
    );
  });
  const read = () => JSON.parse(renderer!.root.findByType("output").children[0] as string);
  expect(read()).toMatchObject({ workspaceId, terminalId: "shell", focused: false, availableSize });
  const resized = { width: 320, height: 240 };
  await act(() =>
    renderer.update(<TerminalView target={target} paneId="pane" focused availableSize={resized} />),
  );
  expect(read()).toMatchObject({
    workspaceId,
    terminalId: "shell",
    focused: true,
    autoFocus: true,
    availableSize: resized,
  });
  await act(() => renderer.unmount());
  await act(() => {
    renderer = create(
      <TerminalView target={target} paneId="new-pane" focused availableSize={resized} />,
    );
  });
  expect(read()).toMatchObject({ workspaceId, terminalId: "shell" });
});

it("renders closed read-only status banner when viewing a closed Agent Session from History", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(
      <AgentView
        target={{
          kind: "agentSession",
          environmentId,
          agentSessionId: "closed-session" as AgentSessionId,
        }}
        paneId="closed-pane"
        focused={false}
        availableSize={availableSize}
      />,
    );
  });

  const banner = renderer!.root.findByProps({ role: "status" });
  expect(banner).toBeDefined();
  const text = banner
    .findAllByType("span")
    .map((n) => n.children.join(""))
    .join(" ");
  expect(text).toContain("This Agent Session is closed and preserved in Workspace History.");
});
it("detaches only the current View on closeView and closes the emptied Tab on removeSessionViews", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  resetWorkbenchStore();
  const targetA = {
    kind: "agentSession",
    environmentId,
    agentSessionId: "one" as AgentSessionId,
  } as const;
  const targetB = {
    kind: "agentSession",
    environmentId,
    agentSessionId: "two" as AgentSessionId,
  } as const;
  const terminalTarget = terminalTargetForRuntime({
    environmentId,
    workspaceId,
    terminalId: "shell",
  });

  const store = useWorkbenchStore.getState();
  store.openTarget(targetA);
  const tab1Id = getActiveTab(useWorkbenchStore.getState()).id;

  // A second Tab holds a different Session plus a Terminal: ADR-0010 gives each Session one View.
  store.openTarget(targetB);
  const tab2Id = getActiveTab(useWorkbenchStore.getState()).id;
  expect(tab2Id).not.toBe(tab1Id);
  store.splitFocused(terminalTarget, "right");
  expect(getActiveTab(useWorkbenchStore.getState()).panes.size).toBe(2);
  expect(useWorkbenchStore.getState().tabs).toHaveLength(2);

  // 1. closeView on Tab 2 detaches only that PaneView; the Tab keeps its Terminal
  const tab2PaneId = [...getActiveTab(useWorkbenchStore.getState()).panes.entries()].find(
    ([, view]) => view.target.kind === "agentSession",
  )![0];
  store.closeView(tab2PaneId);
  const tab2 = getActiveTab(useWorkbenchStore.getState());
  expect(useWorkbenchStore.getState().tabs).toHaveLength(2);
  expect(tab2.panes.size).toBe(1);
  expect([...tab2.panes.values()][0]?.target.kind).toBe("workspaceTerminal");

  // 2. removeSessionViews closes Tab 1 once its only View is removed. The Tab
  // first enters its closing animation (ADR-0013) and is removed once the
  // 220ms collapse has settled.
  store.activateTab(tab1Id);
  useWorkbenchStore.getState().removeSessionViews(targetA);
  expect(useWorkbenchStore.getState().closingTabIds.has(tab1Id)).toBe(true);
  expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual([tab1Id, tab2Id]);
  expect(useWorkbenchStore.getState().activeTabId).toBe(tab2Id);

  act(() => {
    vi.advanceTimersByTime(220);
  });
  expect(useWorkbenchStore.getState().closingTabIds.size).toBe(0);
  expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual([tab2Id]);
  expect(useWorkbenchStore.getState().activeTabId).toBe(tab2Id);
  expect(useWorkbenchStore.getState().tabs[0]!.panes.size).toBe(1);
  vi.useRealTimers();
});

it("binds workspace actions (browse files, new terminal) from AgentView to ChatView", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetWorkbenchStore();
  const target = {
    kind: "agentSession" as const,
    environmentId,
    agentSessionId: "one" as AgentSessionId,
  };
  useWorkbenchStore.getState().openTarget(target);
  const sourcePaneId = getActiveTab(useWorkbenchStore.getState()).focusedPaneId;

  await act(() => {
    renderer = create(
      <AgentView target={target} paneId={sourcePaneId} focused availableSize={availableSize} />,
    );
  });

  const output = renderer!.root.findByType("output");
  expect(typeof output.props.onBrowseFiles).toBe("function");
  expect(typeof output.props.onNewTerminalSession).toBe("function");

  await act(() => output.props.onBrowseFiles());
  const tab = getActiveTab(useWorkbenchStore.getState());
  expect(tab.panes.size).toBe(2);
  expect(tab.panes.get(tab.focusedPaneId)?.target).toEqual({
    kind: "workspace",
    definitionId: "fileView",
    environmentId,
    workspaceId,
  });
});
