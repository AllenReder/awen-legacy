import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const sidebarMocks = vi.hoisted(() => {
  const success = { _tag: "Success" as const };
  return {
    confirm: vi.fn(),
    showContextMenu: vi.fn(),
    removeWorkspace: vi.fn().mockResolvedValue(success),
    defaultCommand: vi.fn().mockResolvedValue(success),
  };
});

vi.mock("../localApi", () => {
  const api = {
    dialogs: { confirm: sidebarMocks.confirm },
    contextMenu: { show: sidebarMocks.showContextMenu, close: vi.fn() },
    shell: { openExternal: vi.fn(), openSystemSettings: vi.fn() },
    persistence: { getClientSettings: vi.fn(), setClientSettings: vi.fn() },
  };
  return {
    readLocalApi: () => api,
    ensureLocalApi: () => api,
  };
});

const mockState = {
  projects: [] as any[],
  environments: [] as any[],
  navigate: vi.fn(),
  threadShell: null as any,
};

const mockTerminalSessions = {
  sessions: [] as any[],
};

vi.mock("../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => mockTerminalSessions.sessions,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockState.navigate,
  useCanGoBack: () => true,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/" }),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => new Map(),
  useAtomRefresh: () => vi.fn(),
}));

vi.mock("../state/entities", () => ({
  useAwenProjects: () => mockState.projects,
  useAwenAgentSessionShell: () => null,
  readThreadShell: () => null,
  useThreadShell: () => mockState.threadShell,
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: mockState.environments }),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly label?: string }) =>
    command.label === "environment-data:workspace:remove"
      ? sidebarMocks.removeWorkspace
      : sidebarMocks.defaultCommand,
}));

vi.mock("./ui/sidebar", () => ({
  SidebarContent: ({ children }: any) => <div data-sidebar="content">{children}</div>,
  SidebarGroup: ({ children }: any) => <div data-sidebar="group">{children}</div>,
  SidebarGroupLabel: ({ children }: any) => <div data-sidebar="group-label">{children}</div>,
  SidebarHeader: ({ children }: any) => <header data-sidebar="header">{children}</header>,
  SidebarFooter: ({ children, className, ...props }: any) => (
    <footer className={className} data-sidebar="footer" {...props}>
      {children}
    </footer>
  ),
  SidebarMenu: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: any) => <li>{children}</li>,
  SidebarMenuButton: ({ children, onClick, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  useSidebar: () => ({
    isMobile: false,
    setOpenMobile: vi.fn(),
    toggleSidebar: vi.fn(),
    open: true,
  }),
  useSidebarVisibility: () => true,
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ render }: any) => render,
  TooltipPopup: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

vi.mock("./sidebar/SidebarProviderUpdatePill", () => ({
  SidebarProviderUpdatePill: () => null,
}));

vi.mock("./sidebar/SidebarUpdatePill", () => ({
  SidebarUpdateArchitectureWarning: () => null,
  SidebarUpdatePill: () => null,
}));

vi.mock("./SidebarStageBackdrop", () => ({
  useEnvironmentStageLabel: () => null,
  resolveEnvironmentIdentificationPillLabel: () => null,
}));

vi.mock("../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));

import { AwenSidebar, workspaceMenuItems } from "./AwenSidebar";
import { toastManager } from "./ui/toast";
import { useUiStateStore } from "../uiStateStore";

function removableWorkspaceProject() {
  return [
    {
      id: "p1",
      environmentId: "local",
      title: "Test Project",
      workspaces: [
        {
          id: "w1",
          title: "Main Workspace",
          role: "main",
          origin: "awen-created",
          sessions: [],
          historySessions: [],
        },
      ],
    },
  ];
}

describe("AwenSidebar", () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    sidebarMocks.confirm.mockReset();
    sidebarMocks.showContextMenu.mockReset().mockResolvedValue(null);
    sidebarMocks.removeWorkspace.mockReset().mockResolvedValue({ _tag: "Success" });
    sidebarMocks.defaultCommand.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockState.projects = [];
    mockTerminalSessions.sessions = [];
    mockState.threadShell = null;
    useUiStateStore.setState({ threadLastVisitedAtById: {} });
  });

  it("renders the sidebar header and add project button when there are no projects", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockState.projects = [];

    await act(() => {
      renderer = create(<AwenSidebar />);
    });

    const addProjectBtn = renderer.root.findByProps({ "data-testid": "sidebar-add-project" });
    expect(addProjectBtn).toBeDefined();

    const header = renderer.root.findByProps({ "data-sidebar": "header" });
    expect(header).toBeDefined();
  });

  it("renders the sidebar header and project list when projects exist", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockState.projects = [
      {
        id: "p1",
        environmentId: "local",
        title: "Test Project",
        workspaces: [],
      },
    ];

    await act(() => {
      renderer = create(<AwenSidebar />);
    });

    const projectRow = renderer.root.findByProps({ "data-testid": "sidebar-project-row" });
    expect(projectRow).toBeDefined();

    const header = renderer.root.findByProps({ "data-sidebar": "header" });
    expect(header).toBeDefined();
  });

  it("renders active sessions sorted according to workspaceSessionOrderById", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const { useUiStateStore } = await import("../uiStateStore");

    mockState.projects = [
      {
        id: "p1",
        environmentId: "local",
        title: "Test Project",
        workspaces: [
          {
            id: "w1",
            title: "Main Workspace",
            role: "main",
            sessions: [
              { kind: "agent", id: "s1", title: "Session One" },
              { kind: "agent", id: "s2", title: "Session Two" },
              { kind: "agent", id: "s3", title: "Session Three" },
            ],
          },
        ],
      },
    ];

    // Set custom order: s3, s1, s2
    act(() => {
      useUiStateStore.setState({
        workspaceSessionOrderById: {
          "local:w1": ["s3", "s1", "s2"],
        },
      });
    });

    await act(() => {
      renderer = create(<AwenSidebar />);
    });

    // Expand workspace
    const workspaceRow = renderer.root.findByProps({ "data-testid": "sidebar-workspace-row" });
    await act(() => {
      workspaceRow.props.onClick();
    });

    const sessionRows = renderer.root.findAllByProps({ "data-sidebar-session-row": "true" });
    expect(sessionRows).toHaveLength(3);
    expect(sessionRows.map((r) => r.props["data-session-id"])).toEqual(["s3", "s1", "s2"]);
  });

  it("includes browse-files in workspace menu items", () => {
    const items = workspaceMenuItems({ canDeleteDirectory: false });
    const browseFilesItem = items.find((item) => item.id === "browse-files");
    expect(browseFilesItem).toBeDefined();
    expect(browseFilesItem?.label).toBe("Browse Files");
  });

  it("includes review-changes in workspace menu items", () => {
    const items = workspaceMenuItems({ canDeleteDirectory: false });
    const reviewChangesItem = items.find((item) => item.id === "review-changes");
    expect(reviewChangesItem).toBeDefined();
    expect(reviewChangesItem?.label).toBe("Review Changes");
    expect(reviewChangesItem?.icon).toBe("git-branch");
  });

  it("renders branch name on the left and workspace directory name on the right without role badge", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockState.projects = [
      {
        id: "p1",
        environmentId: "local",
        title: "awen",
        workspaces: [
          {
            id: "w1",
            title: "awen",
            workspaceRoot: "/code/awen",
            role: "main",
            branch: "main",
            sessions: [],
            historySessions: [],
          },
        ],
      },
    ];

    await act(() => {
      renderer = create(<AwenSidebar />);
    });

    const workspaceRow = renderer.root.findByProps({ "data-testid": "sidebar-workspace-row" });
    expect(
      workspaceRow.findByProps({ "data-testid": "sidebar-workspace-branch" }).props.children,
    ).toBe("main");
    expect(
      workspaceRow.findByProps({ "data-testid": "sidebar-workspace-dir" }).props.children,
    ).toBe("awen");
    expect(workspaceRow.findAllByProps({ "data-testid": "sidebar-workspace-role" })).toHaveLength(
      0,
    );
  });

  it("exposes the full directory name when a custom Workspace name is truncated", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockState.projects = [
      {
        id: "p1",
        environmentId: "local",
        title: "Repository",
        workspaces: [
          {
            id: "w1",
            title: "Short name",
            workspaceRoot: "/code\\very-long-directory-name/",
            role: "main",
            branch: "main",
            sessions: [],
            historySessions: [],
          },
        ],
      },
    ];

    await act(() => {
      renderer = create(<AwenSidebar />);
    });

    const directory = renderer.root.findByProps({ "data-testid": "sidebar-workspace-dir" });
    expect(directory.props.children).toBe("very-long-directory-name");
    expect(directory.parent?.props.className).toContain("truncate");
    expect(
      renderer.root
        .findAllByType("div")
        .some((popup) => popup.props.children === "very-long-directory-name"),
    ).toBe(true);
  });

  it("renders agent sessions with provider icon and terminal sessions with terminal/agent icon and 14px status gutter", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockState.projects = [
      {
        id: "p1",
        environmentId: "local",
        title: "awen",
        workspaces: [
          {
            id: "w1",
            title: "awen",
            workspaceRoot: "/code/awen",
            role: "main",
            branch: "main",
            sessions: [
              { kind: "agent", id: "agent-1", threadId: "thread-1", title: "Coding Agent" },
              { kind: "terminal", id: "term-1", title: "Terminal Shell" },
            ],
            historySessions: [],
          },
        ],
      },
    ];

    await act(() => {
      renderer = create(<AwenSidebar />);
    });

    // Expand workspace
    const workspaceRow = renderer.root.findByProps({ "data-testid": "sidebar-workspace-row" });
    await act(() => {
      workspaceRow.props.onClick();
    });

    const sessionRows = renderer.root.findAllByProps({ "data-sidebar-session-row": "true" });
    expect(sessionRows).toHaveLength(2);

    // Both rows must render the 14px Status Gutter
    const gutters = renderer.root.findAllByProps({ "data-status-gutter": "true" });
    expect(gutters.length).toBeGreaterThanOrEqual(2);
  });

  it("dynamically shows agent icon and running alert for terminal running an agent CLI", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockState.projects = [
      {
        id: "p1",
        environmentId: "local",
        title: "awen",
        workspaces: [
          {
            id: "w1",
            title: "awen",
            workspaceRoot: "/code/awen",
            role: "main",
            branch: "main",
            sessions: [{ kind: "terminal", id: "term-1", title: "Terminal Shell" }],
            historySessions: [],
          },
        ],
      },
    ];

    mockTerminalSessions.sessions = [
      {
        target: { terminalId: "term-1" },
        state: {
          summary: {
            terminalId: "term-1",
            hasRunningSubprocess: true,
            label: "codex",
            status: "running",
          },
        },
      },
    ];

    await act(() => {
      renderer = create(<AwenSidebar />);
    });

    const workspaceRow = renderer.root.findByProps({ "data-testid": "sidebar-workspace-row" });
    await act(() => {
      workspaceRow.props.onClick();
    });

    const terminalRow = renderer.root.findByProps({ "data-session-kind": "terminal" });
    expect(terminalRow.props.status).toBe("working");
  });

  it("keeps a completed agent session unread until its thread is visited", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockState.projects = [
      {
        id: "p1",
        environmentId: "local",
        title: "awen",
        workspaces: [
          {
            id: "w1",
            title: "awen",
            workspaceRoot: "/code/awen",
            role: "main",
            branch: "main",
            sessions: [
              { kind: "agent", id: "agent-1", threadId: "thread-1", title: "Coding Agent" },
            ],
            historySessions: [],
          },
        ],
      },
    ];
    mockState.threadShell = {
      id: "thread-1",
      environmentId: "local",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      interactionMode: "default",
      backgroundLiveness: null,
      session: null,
      latestTurn: {
        turnId: "turn-1",
        state: "completed",
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:05:00.000Z",
      },
    };
    useUiStateStore.setState({ threadLastVisitedAtById: {} });

    await act(() => {
      renderer = create(<AwenSidebar />);
    });
    const workspaceRow = renderer.root.findByProps({ "data-testid": "sidebar-workspace-row" });
    await act(() => {
      workspaceRow.props.onClick();
    });

    let agentRow = renderer.root.findByProps({ "data-session-kind": "agent" });
    expect(agentRow.props.status).toBe("ready");
    expect(agentRow.props.isUnread).toBe(true);

    // Focusing the session stamps the visit at the completion; the dot clears.
    await act(() => {
      useUiStateStore.setState({
        threadLastVisitedAtById: { "local:thread-1": "2026-03-09T10:05:00.000Z" },
      });
    });
    agentRow = renderer.root.findByProps({ "data-session-kind": "agent" });
    expect(agentRow.props.isUnread).toBe(false);
  });

  it.each([
    {
      action: "remove-workspace",
      message: 'Remove Workspace "Main Workspace" from this project?',
      input: { workspaceId: "w1" },
    },
    {
      action: "delete-directory",
      message: 'Remove Workspace "Main Workspace" and delete its directory?',
      input: { workspaceId: "w1", deleteDirectory: true },
    },
  ])(
    "confirms $action through the shared destructive dialog",
    async ({ action, message, input }) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      mockState.projects = removableWorkspaceProject();
      sidebarMocks.confirm.mockResolvedValue(true);
      sidebarMocks.showContextMenu.mockResolvedValue(action);

      await act(() => {
        renderer = create(<AwenSidebar />);
      });
      const workspaceRow = renderer.root.findByProps({ "data-testid": "sidebar-workspace-row" });
      await act(async () => {
        workspaceRow.props.onContextMenu({
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          clientX: 10,
          clientY: 20,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(sidebarMocks.confirm).toHaveBeenCalledWith(message, { variant: "destructive" });
      expect(sidebarMocks.removeWorkspace).toHaveBeenCalledWith({
        environmentId: "local",
        input,
      });
    },
  );

  it("does not remove a Workspace when the shared dialog is cancelled", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockState.projects = removableWorkspaceProject();
    sidebarMocks.confirm.mockResolvedValue(false);
    sidebarMocks.showContextMenu.mockResolvedValue("remove-workspace");

    await act(() => {
      renderer = create(<AwenSidebar />);
    });
    const workspaceRow = renderer.root.findByProps({ "data-testid": "sidebar-workspace-row" });
    await act(async () => {
      workspaceRow.props.onContextMenu({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 10,
        clientY: 20,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sidebarMocks.removeWorkspace).not.toHaveBeenCalled();
  });

  it("reports a confirmation failure and does not remove the Workspace", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mockState.projects = removableWorkspaceProject();
    const failure = new Error("dialog unavailable");
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("confirmation-failure");
    sidebarMocks.confirm.mockRejectedValue(failure);
    sidebarMocks.showContextMenu.mockResolvedValue("remove-workspace");

    await act(() => {
      renderer = create(<AwenSidebar />);
    });
    const workspaceRow = renderer.root.findByProps({ "data-testid": "sidebar-workspace-row" });
    await act(async () => {
      workspaceRow.props.onContextMenu({
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        clientX: 10,
        clientY: 20,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not confirm Workspace removal",
        description: "dialog unavailable",
      }),
    );
    expect(sidebarMocks.removeWorkspace).not.toHaveBeenCalled();
  });
});
