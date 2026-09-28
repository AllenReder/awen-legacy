import { act, useEffect, type PointerEvent as ReactPointerEvent } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  WorkbenchDragProvider,
  WorkbenchDropOverlay,
  useWorkbenchDragController,
} from "./workbenchDrag";
import { resetWorkbenchStore, useWorkbenchStore } from "./workbenchStore";
import { leaf, splitPane } from "./layout";
import type { WorkbenchTab, PaneView, ViewDragSource } from "./workbenchState";
import type { EnvironmentId, WorkspaceId, AgentSessionId } from "@awen/contracts";

const dummyView = (_id: string): PaneView => ({
  presentation: {},
  definitionId: "agent",
  target: { kind: "welcome" },
});

let renderer: ReactTestRenderer | undefined;
let fakeDataset: Record<string, string | undefined>;

type DragListeners = Record<string, Array<(e: unknown) => void>>;

/**
 * Stubs `window` with a listener registry the test can dispatch pointer events through.
 */
function stubDragWindow(): DragListeners {
  const listeners: DragListeners = {};
  vi.stubGlobal("window", {
    addEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]!.push(fn);
    }),
    removeEventListener: vi.fn((event: string, fn: (e: unknown) => void) => {
      if (!listeners[event]) return;
      listeners[event] = listeners[event]!.filter((f) => f !== fn);
    }),
    dispatchEvent: vi.fn(),
    getSelection: () => ({ removeAllRanges: vi.fn() }),
  });
  return listeners;
}

/**
 * The drag code calls bare `requestAnimationFrame`, never `window.requestAnimationFrame`,
 * so the frame shims are stubbed globally.
 */
function stubAnimationFrames(): void {
  vi.stubGlobal("requestAnimationFrame", (cb: (time: number) => void) => {
    queueMicrotask(() => cb(16));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fakeDataset = {};
  const fakeDoc = {
    documentElement: {
      dataset: fakeDataset,
    },
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    elementFromPoint: vi.fn(() => null),
  };
  vi.stubGlobal("document", fakeDoc);
  stubDragWindow();
  stubAnimationFrames();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  delete document.documentElement.dataset.workbenchDragging;
  resetWorkbenchStore();
  vi.unstubAllGlobals();
});

function DragTrigger({
  onController,
}: {
  readonly onController: (controller: ReturnType<typeof useWorkbenchDragController>) => void;
}) {
  const controller = useWorkbenchDragController();
  useEffect(() => {
    onController(controller);
  }, [controller, onController]);
  return <div data-workbench-pane-drop data-pane-id="pane-a" />;
}

describe("WorkbenchDrag lifecycle and overlay animations", () => {
  it("transitions data-workbench-dragging from pending -> active -> settling -> deleted", async () => {
    vi.useFakeTimers();

    const listeners = stubDragWindow();

    const twoPaneTab: WorkbenchTab = {
      id: "tab-1",
      layout: splitPane(leaf("pane-a"), "pane-a", "right", "pane-b"),
      panes: new Map([
        ["pane-a", dummyView("pane-a")],
        ["pane-b", dummyView("pane-b")],
      ]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };
    useWorkbenchStore.setState({
      tabs: [twoPaneTab],
      activeTabId: "tab-1",
    });

    let controller!: ReturnType<typeof useWorkbenchDragController>;
    await act(() => {
      renderer = create(
        <WorkbenchDragProvider>
          <DragTrigger onController={(c) => (controller = c)} />
          <WorkbenchDropOverlay />
        </WorkbenchDragProvider>,
      );
    });

    const source: ViewDragSource = { kind: "pane", tabId: "tab-1", paneId: "pane-a" };
    const fakeHandle = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 40 }),
    } as unknown as HTMLElement;

    // 1. beginDrag -> pending
    act(() => {
      controller.beginDrag(source, "Pane A", {
        button: 0,
        clientX: 50,
        clientY: 20,
        currentTarget: fakeHandle,
        defaultPrevented: false,
      } as unknown as React.PointerEvent<HTMLElement>);
    });
    expect(fakeDataset.workbenchDragging).toBe("pending");

    // 2. move past threshold (5px) -> active
    act(() => {
      listeners.pointermove?.forEach((fn) =>
        fn({
          clientX: 80,
          clientY: 20,
        }),
      );
    });
    expect(fakeDataset.workbenchDragging).toBe("active");

    // 3. pointerup -> settling
    act(() => {
      listeners.pointerup?.forEach((fn) => fn({}));
    });
    expect(fakeDataset.workbenchDragging).toBe("settling");

    // 4. after settle duration (240ms) -> deleted
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(fakeDataset.workbenchDragging).toBeUndefined();

    vi.useRealTimers();
  });

  it("renders destination indicator with workbench-drop-destination-indicator class and secondary panes", async () => {
    const listeners = stubDragWindow();

    const twoPaneTab: WorkbenchTab = {
      id: "tab-1",
      layout: splitPane(leaf("pane-a"), "pane-a", "right", "pane-b"),
      panes: new Map([
        ["pane-a", dummyView("pane-a")],
        ["pane-b", dummyView("pane-b")],
      ]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };
    useWorkbenchStore.setState({
      tabs: [twoPaneTab],
      activeTabId: "tab-1",
    });

    const viewportEl = {
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
      }),
    } as unknown as HTMLElement;

    const paneBEl = {
      dataset: { workbenchPaneDrop: "", workbenchTabId: "tab-1", paneId: "pane-b" },
      getBoundingClientRect: () => ({
        left: 400,
        top: 0,
        width: 400,
        height: 600,
        right: 800,
        bottom: 600,
      }),
      closest: (sel: string) => (sel === "[data-workbench-pane-drop]" ? paneBEl : null),
    } as unknown as HTMLElement;

    const fakeDoc = {
      documentElement: { dataset: fakeDataset },
      querySelector: vi.fn((sel: string) => {
        if (sel === ".workbench-viewport") return viewportEl;
        return null;
      }),
      querySelectorAll: vi.fn(() => []),
      elementFromPoint: vi.fn(() => paneBEl),
    };
    vi.stubGlobal("document", fakeDoc);

    let controller!: ReturnType<typeof useWorkbenchDragController>;
    await act(() => {
      renderer = create(
        <WorkbenchDragProvider>
          <DragTrigger onController={(c) => (controller = c)} />
          <WorkbenchDropOverlay />
        </WorkbenchDragProvider>,
        {
          createNodeMock: (el) => {
            if ((el.props as Record<string, unknown>)["data-workbench-drop-preview"]) {
              return {
                getBoundingClientRect: () => ({
                  left: 0,
                  top: 0,
                  width: 800,
                  height: 600,
                  right: 800,
                  bottom: 600,
                }),
              };
            }
            return null;
          },
        },
      );
    });

    const source: ViewDragSource = { kind: "pane", tabId: "tab-1", paneId: "pane-a" };
    const fakeHandle = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 40 }),
    } as unknown as HTMLElement;

    act(() => {
      controller.beginDrag(source, "Pane A", {
        button: 0,
        clientX: 50,
        clientY: 20,
        currentTarget: fakeHandle,
        defaultPrevented: false,
      } as unknown as React.PointerEvent<HTMLElement>);
    });

    // Move over right edge of pane B (x = 750, y = 300)
    act(() => {
      listeners.pointermove?.forEach((fn) =>
        fn({
          clientX: 750,
          clientY: 300,
        }),
      );
    });

    const destinationPane = renderer!.root.findByProps({
      "data-workbench-preview-pane": true,
      "data-destination": "true",
    });
    expect(destinationPane.props.className).toContain("workbench-drop-destination-indicator");
    expect(destinationPane.props["data-pane-id"]).toBe("pane-a");

    const secondaryPanes = renderer!.root.findAllByProps({
      "data-workbench-preview-pane": true,
      "data-destination": "false",
    });
    expect(secondaryPanes.length).toBe(0);
  });

  it("renders destination indicator when dragging a session from the sidebar into the workbench", async () => {
    const listeners = stubDragWindow();

    const twoPaneTab: WorkbenchTab = {
      id: "tab-1",
      layout: splitPane(leaf("pane-a"), "pane-a", "right", "pane-b"),
      panes: new Map([
        ["pane-a", dummyView("pane-a")],
        ["pane-b", dummyView("pane-b")],
      ]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };
    useWorkbenchStore.setState({
      tabs: [twoPaneTab],
      activeTabId: "tab-1",
    });

    const viewportEl = {
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
      }),
    } as unknown as HTMLElement;

    const paneBEl = {
      dataset: { workbenchPaneDrop: "", workbenchTabId: "tab-1", paneId: "pane-b" },
      getBoundingClientRect: () => ({
        left: 400,
        top: 0,
        width: 400,
        height: 600,
        right: 800,
        bottom: 600,
      }),
      closest: (sel: string) => (sel === "[data-workbench-pane-drop]" ? paneBEl : null),
    } as unknown as HTMLElement;

    const fakeDoc = {
      documentElement: { dataset: fakeDataset },
      querySelector: vi.fn((sel: string) => {
        if (sel === ".workbench-viewport") return viewportEl;
        if (sel === "[data-app-sidebar]" || sel === '[data-slot="sidebar"]') {
          return {
            getBoundingClientRect: () => ({
              left: 0,
              top: 0,
              width: 200,
              height: 600,
              right: 200,
              bottom: 600,
            }),
          };
        }
        return null;
      }),
      querySelectorAll: vi.fn(() => []),
      elementFromPoint: vi.fn((x: number) => {
        // When pointer is at x < 200, it's over sidebar. At x >= 200, over workbench pane B
        if (x < 200) return null;
        return paneBEl;
      }),
    };
    vi.stubGlobal("document", fakeDoc);

    let controller!: ReturnType<typeof useWorkbenchDragController>;
    await act(() => {
      renderer = create(
        <WorkbenchDragProvider>
          <DragTrigger onController={(c) => (controller = c)} />
          <WorkbenchDropOverlay />
        </WorkbenchDragProvider>,
        {
          createNodeMock: (el) => {
            if ((el.props as Record<string, unknown>)["data-workbench-drop-preview"]) {
              return {
                getBoundingClientRect: () => ({
                  left: 0,
                  top: 0,
                  width: 800,
                  height: 600,
                  right: 800,
                  bottom: 600,
                }),
              };
            }
            return null;
          },
        },
      );
    });

    const source: ViewDragSource = {
      kind: "sidebar",
      target: {
        kind: "agentSession",
        environmentId: "local" as EnvironmentId,
        agentSessionId: "s1" as AgentSessionId,
      },
    };
    const fakeHandle = {
      getBoundingClientRect: () => ({ left: 20, top: 20, width: 160, height: 32 }),
    } as unknown as HTMLElement;

    // 1. Drag starts in the sidebar (x = 50, y = 20)
    act(() => {
      controller.beginDrag(source, "Session 1", {
        button: 0,
        clientX: 50,
        clientY: 20,
        currentTarget: fakeHandle,
        defaultPrevented: false,
      } as unknown as React.PointerEvent<HTMLElement>);
    });

    // 2. Initial pointermove still over sidebar (x = 60, y = 20)
    act(() => {
      listeners.pointermove?.forEach((fn) =>
        fn({
          clientX: 60,
          clientY: 20,
        }),
      );
    });

    // While over sidebar, drop overlay returns null
    const destOverSidebar = renderer!.root.findAllByProps({
      "data-workbench-preview-pane": true,
      "data-destination": "true",
    });
    expect(destOverSidebar).toHaveLength(0);

    // 3. Move pointer into workbench (x = 750, y = 300 - over right half of Pane B)
    await act(async () => {
      listeners.pointermove?.forEach((fn) =>
        fn({
          clientX: 750,
          clientY: 300,
        }),
      );
    });

    // Now inside workbench, the destination indicator MUST be rendered!
    let destinationPane = renderer!.root.findByProps({
      "data-workbench-preview-pane": true,
      "data-destination": "true",
    });
    expect(destinationPane.props.className).toContain("workbench-drop-destination-indicator");

    // 4. Move pointer back into sidebar (x = 50, y = 20)
    await act(async () => {
      listeners.pointermove?.forEach((fn) =>
        fn({
          clientX: 50,
          clientY: 20,
        }),
      );
    });
    const found = renderer!.root.findAllByProps({
      "data-workbench-preview-pane": true,
      "data-destination": "true",
    });
    expect(found.length).toBe(0);

    // 5. Move pointer back into workbench again (x = 750, y = 300)
    await act(async () => {
      listeners.pointermove?.forEach((fn) =>
        fn({
          clientX: 750,
          clientY: 300,
        }),
      );
    });
    destinationPane = renderer!.root.findByProps({
      "data-workbench-preview-pane": true,
      "data-destination": "true",
    });
    // findByProps throws when the destination indicator is absent.
    expect(destinationPane.props.className).toContain("workbench-drop-destination-indicator");
  });

  it("renders destination indicator and executes onCommit when dragging workspace context menu action", async () => {
    const listeners = stubDragWindow();

    const twoPaneTab: WorkbenchTab = {
      id: "tab-1",
      layoutMode: "bsp",
      layout: splitPane(leaf("pane-a"), "pane-a", "right", "pane-b"),
      panes: new Map([
        ["pane-a", dummyView("pane-a")],
        ["pane-b", dummyView("pane-b")],
      ]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };
    useWorkbenchStore.setState({
      tabs: [twoPaneTab],
      activeTabId: "tab-1",
    });

    const viewportEl = {
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 800,
      clientHeight: 600,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
      }),
    } as unknown as HTMLElement;

    const paneBEl = {
      dataset: { workbenchPaneDrop: "", workbenchTabId: "tab-1", paneId: "pane-b" },
      getBoundingClientRect: () => ({
        left: 400,
        top: 0,
        width: 400,
        height: 600,
        right: 800,
        bottom: 600,
      }),
      closest: (sel: string) => (sel === "[data-workbench-pane-drop]" ? paneBEl : null),
    } as unknown as HTMLElement;

    const fakeDoc = {
      documentElement: { dataset: fakeDataset },
      querySelector: vi.fn((sel: string) => {
        if (sel === ".workbench-viewport") return viewportEl;
        if (sel === '[data-workbench-pane-drop][data-pane-id="pane-b"]') return paneBEl;
        return null;
      }),
      querySelectorAll: vi.fn(() => []),
      elementFromPoint: vi.fn(() => paneBEl),
    };
    vi.stubGlobal("document", fakeDoc);

    const onCommit = vi.fn();
    let handleBeginDrag: ((e: unknown) => void) | undefined;
    function WorkspaceActionDragHandle() {
      const { beginDrag } = useWorkbenchDragController();
      handleBeginDrag = (e: unknown) => {
        beginDrag(
          {
            kind: "sidebar",
            target: {
              kind: "workspace",
              definitionId: "fileView",
              environmentId: "env-1" as EnvironmentId,
              workspaceId: "ws-1" as WorkspaceId,
            },
            onCommit,
          },
          "Browse Files",
          e as ReactPointerEvent<HTMLElement>,
        );
      };
      return null;
    }

    await act(async () => {
      renderer = create(
        <WorkbenchDragProvider>
          <WorkspaceActionDragHandle />
          <WorkbenchDropOverlay />
        </WorkbenchDragProvider>,
        {
          createNodeMock: (el) => {
            if ((el.props as Record<string, unknown>)["data-workbench-drop-preview"]) {
              return {
                getBoundingClientRect: () => ({
                  left: 0,
                  top: 0,
                  width: 800,
                  height: 600,
                  right: 800,
                  bottom: 600,
                }),
              };
            }
            return null;
          },
        },
      );
    });

    // 1. Pointerdown on the action handle
    act(() => {
      handleBeginDrag?.({
        button: 0,
        clientX: 50,
        clientY: 50,
        currentTarget: {
          getBoundingClientRect: () => ({ left: 50, top: 50, width: 100, height: 28 }),
        },
      });
    });

    expect(fakeDataset.workbenchDragging).toBe("pending");

    // 2. Drag into workbench pane-b right edge (x = 750, y = 300)
    await act(async () => {
      listeners["pointermove"]?.forEach((fn) =>
        fn({
          clientX: 750,
          clientY: 300,
        }),
      );
    });

    expect(fakeDataset.workbenchDragging).toBe("active");
    const destinationPane = renderer!.root.findByProps({
      "data-workbench-preview-pane": true,
      "data-destination": "true",
    });
    expect(destinationPane.props.className).toContain("workbench-drop-destination-indicator");

    // 3. Pointerup: commits the drop and triggers onCommit
    act(() => {
      listeners["pointerup"]?.forEach((fn) => fn({}));
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(useWorkbenchStore.getState().tabs[0]?.panes.size).toBe(3);
  });

  it("renders destination indicator and commits drop when dragging an inactive single-pane Tab into the workbench canvas (ADR-0017)", async () => {
    const listeners = stubDragWindow();

    const terminalTarget = {
      kind: "workspaceTerminal" as const,
      environmentId: "env-1" as EnvironmentId,
      workspaceId: "ws-1" as WorkspaceId,
      terminalSessionId: "term-1" as any,
    };

    const agentTarget = {
      kind: "agentSession" as const,
      environmentId: "env-1" as EnvironmentId,
      agentSessionId: "agent-1" as AgentSessionId,
    };

    const initialTabs: WorkbenchTab[] = [
      {
        id: "tab-active",
        layout: leaf("pane-active"),
        panes: new Map([
          [
            "pane-active",
            {
              presentation: {},
              definitionId: "agent",
              target: agentTarget,
            },
          ],
        ]),
        focusedPaneId: "pane-active",
        titleMode: "auto",
        titleOverride: null,
      },
      {
        id: "tab-inactive",
        layout: leaf("pane-inactive"),
        panes: new Map([
          [
            "pane-inactive",
            {
              presentation: {},
              definitionId: "terminal",
              target: terminalTarget,
            },
          ],
        ]),
        focusedPaneId: "pane-inactive",
        titleMode: "auto",
        titleOverride: null,
      },
    ];

    useWorkbenchStore.setState({
      tabs: initialTabs,
      activeTabId: "tab-active",
      focusRequestId: 0,
    });

    const activeViewportEl = {
      getBoundingClientRect: () => ({ left: 0, top: 40, width: 800, height: 560 }),
      dataset: { tabActive: "true" },
      scrollLeft: 0,
      scrollTop: 0,
    };

    const tabStripEl = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 36, bottom: 36 }),
      querySelectorAll: () => [],
      scrollLeft: 0,
    };

    const paneEl = {
      dataset: { workbenchPaneDrop: "", paneId: "pane-active", workbenchTabId: "tab-active" },
      getBoundingClientRect: () => ({ left: 0, top: 40, width: 800, height: 560 }),
      closest: (sel: string) => {
        if (sel === "[data-workbench-pane-drop]") return paneEl;
        return null;
      },
    };

    const fakeDoc = {
      documentElement: { dataset: fakeDataset },
      querySelector: (sel: string) => {
        if (sel.includes(".workbench-viewport")) return activeViewportEl;
        if (sel.includes("[data-workbench-tab-strip-drop]")) return tabStripEl;
        if (sel.includes("[data-tab-id]")) {
          return { getBoundingClientRect: () => ({ width: 176 }) };
        }
        return null;
      },
      querySelectorAll: () => [],
      elementFromPoint: () => paneEl,
    };
    vi.stubGlobal("document", fakeDoc);

    let handleBeginDrag: ((e: unknown) => void) | undefined;
    function TabDragHandle() {
      const { beginDrag } = useWorkbenchDragController();
      handleBeginDrag = (e: unknown) => {
        beginDrag(
          { kind: "tab", tabId: "tab-inactive" },
          "Terminal Tab",
          e as ReactPointerEvent<HTMLElement>,
        );
      };
      return null;
    }

    await act(async () => {
      renderer = create(
        <WorkbenchDragProvider>
          <TabDragHandle />
          <WorkbenchDropOverlay />
        </WorkbenchDragProvider>,
        {
          createNodeMock: (el) => {
            if ((el.props as Record<string, unknown>)["data-workbench-drop-preview"]) {
              return {
                getBoundingClientRect: () => ({
                  left: 0,
                  top: 40,
                  width: 800,
                  height: 560,
                  right: 800,
                  bottom: 600,
                }),
              };
            }
            return null;
          },
        },
      );
    });

    // 1. Pointerdown on the inactive tab
    act(() => {
      handleBeginDrag?.({
        button: 0,
        clientX: 200,
        clientY: 18,
        currentTarget: {
          getBoundingClientRect: () => ({ left: 176, top: 0, width: 176, height: 36 }),
        },
      });
    });

    expect(fakeDataset.workbenchDragging).toBe("pending");

    // 2. Drag within Topbar (> DRAG_THRESHOLD, but y stays within Topbar)
    await act(async () => {
      listeners["pointermove"]?.forEach((fn) =>
        fn({
          clientX: 220,
          clientY: 20,
        }),
      );
    });

    expect(fakeDataset.workbenchDragging).toBe("active");
    // While in topbar, destination indicator should NOT be rendered
    expect(
      renderer!.root.findAllByProps({
        "data-workbench-preview-pane": true,
        "data-destination": "true",
      }),
    ).toHaveLength(0);

    // 3. Drag downward into canvas (> 12px below Topbar, e.g. clientY = 200)
    await act(async () => {
      listeners["pointermove"]?.forEach((fn) =>
        fn({
          clientX: 700,
          clientY: 200,
        }),
      );
    });

    const destinationPane = renderer!.root.findByProps({
      "data-workbench-preview-pane": true,
      "data-destination": "true",
    });
    expect(destinationPane.props.className).toContain("workbench-drop-destination-indicator");

    // 4. Pointerup: commits the drop to active tab
    act(() => {
      listeners["pointerup"]?.forEach((fn) => fn({}));
    });

    // Inactive tab should be closed and removed from tabs
    const storeAfter = useWorkbenchStore.getState();
    expect(storeAfter.tabs).toHaveLength(1);
    expect(storeAfter.tabs[0]?.id).toBe("tab-active");
    expect(storeAfter.tabs[0]?.panes.size).toBe(2);
    expect(storeAfter.tabs[0]?.panes.has("pane-inactive")).toBe(true);
    expect(storeAfter.tabs[0]?.focusedPaneId).toBe("pane-inactive");
  });
});
