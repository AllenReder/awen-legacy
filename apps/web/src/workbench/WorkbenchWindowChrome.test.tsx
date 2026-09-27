import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  AwenProjectId,
  AgentSessionId,
  EnvironmentId,
  TerminalSessionId,
  WorkspaceId,
} from "@awen/contracts";
import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";

import { SidebarProvider } from "../components/ui/sidebar";
import { WorkbenchWindowChrome } from "./WorkbenchWindowChrome";
import { applyCreateTab, applyOpenTarget, emptyWorkbenchSnapshot } from "./workbenchState";
import { resetWorkbenchStore, useWorkbenchStore } from "./workbenchStore";
import type { ViewTarget } from "./viewRegistry";

const environmentId = "env-a" as EnvironmentId;
const workspaceId = "ws-a" as WorkspaceId;
const projectId = "project-a" as AwenProjectId;
const agentSessionId = "agent-a" as AgentSessionId;
const now = "2026-09-20T00:00:00.000Z";

const agentTarget = {
  kind: "agentSession",
  environmentId,
  agentSessionId,
} satisfies ViewTarget;

const terminalTarget = {
  kind: "workspaceTerminal",
  environmentId,
  workspaceId,
  terminalSessionId: "terminal-a" as TerminalSessionId,
} satisfies ViewTarget;

const projects: ReadonlyArray<EnvironmentAwenProject> = [
  {
    id: projectId,
    environmentId,
    title: "Awen",
    createdAt: now,
    updatedAt: now,
    workspaces: [
      {
        id: workspaceId,
        projectId,
        awenProjectId: "awen-project-a" as never,
        title: "Main",
        workspaceRoot: "/workspace",
        role: "main",
        createdAt: now,
        updatedAt: now,
        sessions: [
          {
            kind: "agent",
            id: agentSessionId,
            workspaceId,
            title: "Implement tabs",
            status: "open",
            createdAt: now,
            updatedAt: now,
            threadId: "thread-a" as never,
          },
          {
            kind: "terminal",
            id: terminalTarget.terminalSessionId,
            workspaceId,
            title: "Dev server",
            status: "open",
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  },
];

beforeEach(() => {
  resetWorkbenchStore();
  useWorkbenchStore.setState({
    activateTab: () => {},
    closeTab: () => {},
    canCloseTab: () => Promise.resolve(true),
  });
  if (typeof window !== "undefined") {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }
});

function createTestSnapshot() {
  const ids = (() => {
    let n = 0;
    return () => `id-${++n}`;
  })();
  let snapshot = applyOpenTarget(emptyWorkbenchSnapshot(ids), agentTarget, ids);
  snapshot = applyCreateTab(snapshot, ids);
  return applyOpenTarget(snapshot, terminalTarget, ids);
}

// Capture the real store actions at module evaluation time, before any
// beforeEach hook replaces them with mocks. Tests that need the real closing
// lifecycle re-install this reference.
const realCloseTab = useWorkbenchStore.getState().closeTab;

it("renders the selected compact Topbar Surface with real titles and a new-tab action", () => {
  const snapshot = createTestSnapshot();

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
    </SidebarProvider>,
  );

  expect(html).toContain("data-workbench-window-chrome");
  expect(html).toContain("data-tauri-drag-region");
  expect(html).toContain("Dev server");
  expect(html).toContain('aria-label="Open Implement tabs"');
  expect(html).toContain('aria-label="New tab"');
  expect(html).not.toContain("Awen");
});

it("keeps the titlebar separator mounted for a continuous Sidebar fade", () => {
  const snapshot = createTestSnapshot();

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen={true}>
      <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
    </SidebarProvider>,
  );

  expect(html).toContain('data-slot="workbench-titlebar-separator"');
  expect(html).toContain("opacity:calc(1 - var(--sidebar-motion-progress, 1))");
});

it("renders separator and offset for docked controls when sidebar is collapsed", () => {
  const snapshot = createTestSnapshot();

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen={false}>
      <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
    </SidebarProvider>,
  );

  expect(html).toContain('data-slot="workbench-titlebar-separator"');
});

it("renders flat tiling tabs with uniform width and hover-only close buttons", () => {
  const snapshot = createTestSnapshot();

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
    </SidebarProvider>,
  );

  // Flat tiling width w-44 and border-r divider
  expect(html).toContain("w-44");
  expect(html).toContain("border-r");
  // Close button with hover opacity
  expect(html).toContain("opacity-0 group-hover:opacity-100");
});

it("omits window controls in standard non-desktop environment", () => {
  const snapshot = createTestSnapshot();

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
    </SidebarProvider>,
  );

  expect(html).not.toContain('data-slot="window-controls"');
});

it("renders window controls at the trailing end of the topbar when on Windows desktop", () => {
  const snapshot = createTestSnapshot();

  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {},
  });
  vi.stubGlobal("navigator", {
    platform: "Win32",
  });

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
    </SidebarProvider>,
  );

  expect(html).toContain('data-slot="window-controls"');
  expect(html).toContain('aria-label="Minimize"');
  expect(html).toContain('aria-label="Maximize"');
  expect(html).toContain('aria-label="Close"');

  vi.unstubAllGlobals();
});

it("renders window controls at the trailing end of the topbar when on Linux desktop", () => {
  const snapshot = createTestSnapshot();

  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {},
  });
  vi.stubGlobal("navigator", {
    platform: "Linux x86_64",
  });

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
    </SidebarProvider>,
  );

  expect(html).toContain('data-slot="window-controls"');
  expect(html).toContain('aria-label="Minimize"');
  expect(html).toContain('aria-label="Maximize"');
  expect(html).toContain('aria-label="Close"');

  vi.unstubAllGlobals();
});

it("renders tabs as draggable tab sources with data-workbench-drag-source", () => {
  const snapshot = createTestSnapshot();

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
    </SidebarProvider>,
  );

  expect(html).toContain('data-workbench-drag-source="tab"');
});

it("defers inactive tab activation on pointerdown and activates on click unless clicking close button", async () => {
  const snapshot = createTestSnapshot();
  const activateTab = vi.fn();
  const closeTab = vi.fn();
  useWorkbenchStore.setState({ activateTab, closeTab });

  const { create, act } = await import("react-test-renderer");
  let renderer: any;
  await act(async () => {
    renderer = create(
      <SidebarProvider defaultOpen>
        <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
      </SidebarProvider>,
    );
  });

  const tabElements = renderer.root.findAllByProps({ role: "tab" });
  expect(tabElements).toHaveLength(2);

  const inactiveTab = tabElements[0];
  expect(inactiveTab.props["data-active-tab"]).toBe("false");

  // Pointer down on inactive tab arms drag without activating immediately (ADR-0017)
  await act(async () => {
    inactiveTab.props.onPointerDown({
      button: 0,
      target: { closest: () => null },
    });
  });
  expect(activateTab).not.toHaveBeenCalled();

  // Click on inactive tab activates it
  await act(async () => {
    inactiveTab.props.onClick();
  });
  expect(activateTab).toHaveBeenCalledWith(snapshot.tabs[0]!.id);

  // Pointer down on close button does not activate
  activateTab.mockClear();
  await act(async () => {
    inactiveTab.props.onPointerDown({
      button: 0,
      target: { closest: (sel: string) => (sel.includes("button") ? {} : null) },
    });
  });
  expect(activateTab).not.toHaveBeenCalled();
});

it("renders tabs with workbench-tab-item class and will-change-transform for smooth fluid reordering", () => {
  const snapshot = createTestSnapshot();

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
    </SidebarProvider>,
  );

  expect(html).toContain("workbench-tab-item");
  expect(html).toContain("will-change-transform");
});

it("initiates fluid collapse animation on close, switching active tab immediately and committing close after 220ms", async () => {
  vi.useFakeTimers();
  const snapshot = createTestSnapshot();
  useWorkbenchStore.setState({ closeTab: realCloseTab });
  // Seed the store with the same Tabs the chrome renders, so the real
  // closeTab action can drive its closing lifecycle.
  useWorkbenchStore.setState({
    tabs: snapshot.tabs,
    activeTabId: snapshot.activeTabId,
  });

  const { create, act } = await import("react-test-renderer");
  let renderer: any;
  await act(async () => {
    renderer = create(
      <SidebarProvider defaultOpen>
        <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
      </SidebarProvider>,
    );
  });

  const tabElements = renderer.root.findAllByProps({ role: "tab" });
  expect(tabElements).toHaveLength(2);

  // Tab 1 is the currently active tab (Dev server)
  const activeTabElement = tabElements[1];
  expect(activeTabElement.props["data-active-tab"]).toBe("true");

  const closeButton = activeTabElement.findByProps({ "aria-label": "Close Dev server" });

  // Click close on the active tab
  await act(async () => {
    closeButton.props.onClick({ stopPropagation: () => {} });
  });

  // Active tab shifts immediately (0ms) to the adjacent tab (Tab 0)
  expect(useWorkbenchStore.getState().activeTabId).toBe(snapshot.tabs[0]!.id);

  // The closed tab enters closing state with data-tab-closing="true" (governed by CSS fluid collapse)
  expect(renderer.root.findAllByProps({ role: "tab" })[1].props["data-tab-closing"]).toBe("true");
  expect(useWorkbenchStore.getState().closingTabIds.has(snapshot.tabs[1]!.id)).toBe(true);
  expect(useWorkbenchStore.getState().tabs).toHaveLength(2);

  // Fast forward past the 220ms animation duration
  await act(async () => {
    vi.advanceTimersByTime(220);
  });

  // The store has now formally removed the Tab and cleared its closing state.
  expect(useWorkbenchStore.getState().closingTabIds.size).toBe(0);
  expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual([snapshot.tabs[0]!.id]);

  vi.useRealTimers();
});

it("renders the closing attribute while a Session close animates its emptied Tab away", async () => {
  vi.useFakeTimers();
  // Agent Session lives in Tab 0; the Terminal Tab is active.
  const snapshot = createTestSnapshot();
  useWorkbenchStore.setState({
    tabs: snapshot.tabs,
    activeTabId: snapshot.activeTabId,
  });

  const { create, act } = await import("react-test-renderer");
  let renderer: any;
  await act(async () => {
    renderer = create(
      <SidebarProvider defaultOpen>
        <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
      </SidebarProvider>,
    );
  });

  expect(renderer.root.findAllByProps({ role: "tab" })).toHaveLength(2);

  // A Sidebar Session close removes the Session View through the store.
  await act(async () => {
    useWorkbenchStore.getState().removeSessionViews(agentTarget);
  });

  const closingTabs = renderer.root
    .findAllByProps({ role: "tab" })
    .filter((node: any) => node.props["data-tab-closing"] === "true");
  expect(closingTabs).toHaveLength(1);
  expect(closingTabs[0].props["data-tab-id"]).toBe(snapshot.tabs[0]!.id);
  expect(useWorkbenchStore.getState().closingTabIds.has(snapshot.tabs[0]!.id)).toBe(true);

  await act(async () => {
    vi.advanceTimersByTime(220);
  });
  expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual([snapshot.tabs[1]!.id]);
  expect(useWorkbenchStore.getState().closingTabIds.size).toBe(0);

  vi.useRealTimers();
});

it("aborts tab collapse if canCloseTab rejects closure", async () => {
  const snapshot = createTestSnapshot();
  const activateTab = vi.fn();
  const closeTab = vi.fn();
  const canCloseTab = vi.fn().mockResolvedValue(false);
  useWorkbenchStore.setState({ activateTab, closeTab, canCloseTab });

  const { create, act } = await import("react-test-renderer");
  let renderer: any;
  await act(async () => {
    renderer = create(
      <SidebarProvider defaultOpen>
        <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
      </SidebarProvider>,
    );
  });

  const tabElements = renderer.root.findAllByProps({ role: "tab" });
  const activeTabElement = tabElements[1];
  const closeButton = activeTabElement.findByProps({ "aria-label": "Close Dev server" });

  await act(async () => {
    await closeButton.props.onClick({ stopPropagation: () => {} });
  });

  expect(canCloseTab).toHaveBeenCalledWith(snapshot.tabs[1]!.id);
  expect(activateTab).not.toHaveBeenCalled();
  expect(activeTabElement.props["data-tab-closing"]).toBeUndefined();
  expect(closeTab).not.toHaveBeenCalled();
});

it("supports concurrent closing animations without blocking", async () => {
  vi.useFakeTimers();
  let snapshot = createTestSnapshot();
  const ids = () => "id-extra";
  snapshot = applyCreateTab(snapshot, ids);

  const activateTab = vi.fn();
  useWorkbenchStore.setState({ activateTab, closeTab: realCloseTab });
  useWorkbenchStore.setState({
    tabs: snapshot.tabs,
    activeTabId: snapshot.activeTabId,
  });

  const { create, act } = await import("react-test-renderer");
  let renderer: any;
  await act(async () => {
    renderer = create(
      <SidebarProvider defaultOpen>
        <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
      </SidebarProvider>,
    );
  });

  const tabElements = renderer.root.findAllByProps({ role: "tab" });
  expect(tabElements).toHaveLength(3);
  const closeBtn1 = tabElements[1].findByProps({ "aria-label": "Close Dev server" });
  const closeBtn2 = tabElements[2].findAllByProps({ "aria-label": "Close Welcome" })[0];

  // Rapidly close two tabs concurrently while leaving 1 tab remaining
  await act(async () => {
    closeBtn1.props.onClick({ stopPropagation: () => {} });
    closeBtn2?.props.onClick({ stopPropagation: () => {} });
  });

  const closingTabs = renderer.root.findAllByProps({ role: "tab" });
  expect(closingTabs[1].props["data-tab-closing"]).toBe("true");
  expect(closingTabs[2].props["data-tab-closing"]).toBe("true");

  await act(async () => {
    vi.advanceTimersByTime(220);
  });

  expect(useWorkbenchStore.getState().closingTabIds.size).toBe(0);
  expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual([snapshot.tabs[0]!.id]);

  vi.useRealTimers();
});

it("omits the close button on the sole remaining tab", async () => {
  const ids = () => "id-single";
  const snapshot = applyOpenTarget(emptyWorkbenchSnapshot(ids), agentTarget, ids);

  const { create, act } = await import("react-test-renderer");
  let renderer: any;
  await act(async () => {
    renderer = create(
      <SidebarProvider defaultOpen>
        <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
      </SidebarProvider>,
    );
  });

  const tabElements = renderer.root.findAllByProps({ role: "tab" });
  expect(tabElements).toHaveLength(1);
  const closeBtns = tabElements[0].findAllByProps({ "aria-label": "Close Implement tabs" });
  expect(closeBtns).toHaveLength(0);
});

it("closes a tab when middle-clicked with button 1", async () => {
  vi.useFakeTimers();
  const snapshot = createTestSnapshot();

  // In createTestSnapshot(), tabs[1] is active, tabs[0] is inactive
  expect(snapshot.activeTabId).toBe(snapshot.tabs[1]!.id);

  const activateTab = vi.fn();
  useWorkbenchStore.setState({ activateTab, closeTab: realCloseTab });
  useWorkbenchStore.setState({
    tabs: snapshot.tabs,
    activeTabId: snapshot.activeTabId,
  });

  const { create, act } = await import("react-test-renderer");
  let renderer: any;
  await act(async () => {
    renderer = create(
      <SidebarProvider defaultOpen>
        <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
      </SidebarProvider>,
    );
  });

  const tabElements = renderer.root.findAllByProps({ role: "tab" });
  expect(tabElements).toHaveLength(2);

  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();

  // Test pointerdown / mousedown autoscroll suppression
  await act(async () => {
    tabElements[0].props.onPointerDown({
      button: 1,
      preventDefault,
      target: { closest: () => null },
    });
    tabElements[0].props.onMouseDown({
      button: 1,
      preventDefault,
    });
  });
  expect(preventDefault).toHaveBeenCalledTimes(2);

  // Middle-clicking the INACTIVE tab (tab 0)
  await act(async () => {
    tabElements[0].props.onAuxClick({
      button: 1,
      preventDefault,
      stopPropagation,
      target: { closest: () => null },
    });
  });

  expect(renderer.root.findAllByProps({ role: "tab" })[0].props["data-tab-closing"]).toBe("true");
  // Middle clicking an inactive tab should not switch active tab
  expect(activateTab).not.toHaveBeenCalled();

  await act(async () => {
    vi.advanceTimersByTime(220);
  });

  expect(useWorkbenchStore.getState().closingTabIds.size).toBe(0);
  expect(useWorkbenchStore.getState().tabs.map((tab) => tab.id)).toEqual([snapshot.tabs[1]!.id]);
  vi.useRealTimers();
});

it("ignores middle-click when only one tab remains", async () => {
  const ids = () => "id-single";
  const snapshot = applyOpenTarget(emptyWorkbenchSnapshot(ids), agentTarget, ids);

  const closeTab = vi.fn();
  useWorkbenchStore.setState({ closeTab });

  const { create, act } = await import("react-test-renderer");
  let renderer: any;
  await act(async () => {
    renderer = create(
      <SidebarProvider defaultOpen>
        <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
      </SidebarProvider>,
    );
  });

  const tabElements = renderer.root.findAllByProps({ role: "tab" });
  expect(tabElements).toHaveLength(1);

  await act(async () => {
    tabElements[0].props.onAuxClick({
      button: 1,
      preventDefault: () => {},
      stopPropagation: () => {},
      target: { closest: () => null },
    });
  });

  expect(tabElements[0].props["data-tab-closing"]).toBeUndefined();
  expect(closeTab).not.toHaveBeenCalled();
});

it("ignores non-middle-click on auxClick and ignores middle-click during rename", async () => {
  const snapshot = createTestSnapshot();

  const closeTab = vi.fn();
  useWorkbenchStore.setState({ closeTab });

  const { create, act } = await import("react-test-renderer");
  let renderer: any;
  await act(async () => {
    renderer = create(
      <SidebarProvider defaultOpen>
        <WorkbenchWindowChrome snapshot={snapshot} projects={projects} />
      </SidebarProvider>,
    );
  });

  const tabElements = renderer.root.findAllByProps({ role: "tab" });

  // AuxClick with button 2 (right click) should be ignored
  await act(async () => {
    tabElements[1].props.onAuxClick({
      button: 2,
      preventDefault: () => {},
      stopPropagation: () => {},
      target: { closest: () => null },
    });
  });
  expect(tabElements[1].props["data-tab-closing"]).toBeUndefined();

  // Double click active tab to start editing
  await act(async () => {
    tabElements[0].props.onDoubleClick();
  });

  // Re-query tab elements now that editing state is active
  const updatedTabElements = renderer.root.findAllByProps({ role: "tab" });
  await act(async () => {
    updatedTabElements[0].props.onAuxClick({
      button: 1,
      preventDefault: () => {},
      stopPropagation: () => {},
      target: { closest: (sel: string) => (sel === "input" ? {} : null) },
    });
  });
  expect(updatedTabElements[0].props["data-tab-closing"]).toBeUndefined();
  expect(closeTab).not.toHaveBeenCalled();
});
