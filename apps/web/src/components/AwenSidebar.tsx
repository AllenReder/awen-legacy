import {
  AgentSessionId,
  type AwenWorkspaceShell,
  type ContextMenuItem,
  type EnvironmentId,
  type ProjectId,
  type TerminalSessionId,
  type ThreadId,
  type WorkspaceId,
} from "@awen/contracts";
import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";
import type { ConnectionTarget } from "@awen/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@awen/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  FolderIcon,
  GitBranchIcon,
  PlusIcon,
  TerminalIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useUiStateStore } from "../uiStateStore";
import { openCommandPalette } from "../commandPaletteBus";
import { newThreadId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { environmentServerConfigsAtom } from "../state/server";
import { useEnvironments } from "../state/environments";
import { useAwenProjects, useThreadShell } from "../state/entities";
import { projectEnvironment, workspaceEnvironment } from "../state/projects";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { scopeProjectRef, scopeThreadRef, scopedThreadKey } from "@awen/client-runtime/environment";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { SessionRow } from "./sidebar/SessionRow";
import {
  isUnreadCompletion,
  resolveAgentIcon,
  resolveAgentSessionStatus,
  resolveTerminalIcon,
  resolveTerminalSessionStatus,
} from "./sidebar/sidebarSessionPresentation";
import { AddWorkspaceDialog, NewWorkspaceDialog } from "./sidebar/WorkspaceDialogs";
import { SidebarRenameDialog } from "./sidebar/SidebarRenameDialog";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { createTerminalId } from "../lib/terminalIds";
import { requestDestructiveConfirmation } from "../lib/destructiveConfirmation";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { SidebarContent, SidebarGroup } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { sessionRouteForTarget } from "../workbench/deepLinks";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { runtimeTerminalIdForTarget, terminalTargetForRuntime } from "../workbench/sessionTarget";
import type { ViewTarget } from "../workbench/viewRegistry";
import { useWorkbenchDragController, useWorkbenchDragState } from "../workbench/workbenchDrag";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import { useWorkbenchStore } from "../workbench/workbenchStore";

type ProjectMenuId =
  | "new-project"
  | "add-workspace"
  | "new-workspace"
  | "associate-worktree"
  | "new-worktree"
  | "rename-project"
  | "remove-project";

type WorkspaceMenuId =
  | "browse-files"
  | "review-changes"
  | "new-agent-session"
  | "new-terminal-session"
  | "rename-workspace"
  | "remove-workspace"
  | "remove-registration"
  | "delete-directory";

function commandFailureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function directoryName(path: string | undefined, fallback: string): string {
  return (
    path
      ?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || fallback
  );
}

function SidebarHoverName({
  displayName,
  actualName,
  actualTestId,
  className,
}: {
  readonly displayName: string;
  readonly actualName: string;
  readonly actualTestId?: string;
  readonly className: string;
}) {
  if (displayName === actualName) {
    return (
      <span data-testid={actualTestId} className={className}>
        {displayName}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={`relative min-w-0 ${className}`}>
            <span className="block truncate transition-[opacity,filter] duration-200 ease-in-out group-hover/rename:opacity-0 group-hover/rename:blur-[3px] group-focus-visible/rename:opacity-0 group-focus-visible/rename:blur-[3px] motion-reduce:transition-none">
              {displayName}
            </span>
            <span
              data-testid={actualTestId}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 block truncate opacity-0 blur-[3px] transition-[opacity,filter] duration-200 ease-in-out group-hover/rename:opacity-100 group-hover/rename:blur-[0px] group-focus-visible/rename:opacity-100 group-focus-visible/rename:blur-[0px] motion-reduce:transition-none"
            >
              {actualName}
            </span>
          </span>
        }
      />
      <TooltipPopup side="right" className="max-w-72 break-all whitespace-normal">
        {actualName}
      </TooltipPopup>
    </Tooltip>
  );
}

type SidebarRenameTarget =
  | {
      readonly kind: "Project";
      readonly environmentId: EnvironmentId;
      readonly projectId: EnvironmentAwenProject["id"];
      readonly title: string;
      readonly directoryName: string;
    }
  | {
      readonly kind: "Workspace";
      readonly environmentId: EnvironmentId;
      readonly workspaceId: WorkspaceId;
      readonly title: string;
      readonly directoryName: string;
    };

export function projectMenuItems(input: {
  readonly canManageWorkspaces: boolean;
}): ReadonlyArray<ContextMenuItem<ProjectMenuId>> {
  return [
    ...(input.canManageWorkspaces
      ? ([
          { id: "add-workspace", label: "Add Workspace", icon: "folder-input" },
          { id: "new-workspace", label: "New Workspace", icon: "git-branch" },
        ] satisfies ContextMenuItem<ProjectMenuId>[])
      : []),
    {
      id: "rename-project",
      label: "Rename project",
      icon: "pencil",
      separatorBefore: input.canManageWorkspaces,
    },
    {
      id: "remove-project",
      label: "Remove project",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export function workspaceMenuItems(input: {
  readonly canDeleteDirectory: boolean;
  readonly onDragBrowseFiles?: (event: PointerEvent) => void;
  readonly onDragReviewChanges?: (event: PointerEvent) => void;
  readonly onDragNewAgentSession?: (event: PointerEvent) => void;
  readonly onDragNewTerminalSession?: (event: PointerEvent) => void;
}): ReadonlyArray<ContextMenuItem<WorkspaceMenuId>> {
  return [
    {
      id: "browse-files",
      label: "Browse Files",
      icon: "folder",
      ...(input.onDragBrowseFiles ? { onPointerDown: input.onDragBrowseFiles } : {}),
    },
    {
      id: "review-changes",
      label: "Review Changes",
      icon: "git-branch",
      ...(input.onDragReviewChanges ? { onPointerDown: input.onDragReviewChanges } : {}),
    },
    {
      id: "new-agent-session",
      label: "New Agent Session",
      icon: "message-square-plus",
      ...(input.onDragNewAgentSession ? { onPointerDown: input.onDragNewAgentSession } : {}),
    },
    {
      id: "new-terminal-session",
      label: "New Terminal Session",
      icon: "terminal",
      ...(input.onDragNewTerminalSession ? { onPointerDown: input.onDragNewTerminalSession } : {}),
    },
    { id: "rename-workspace", label: "Rename", icon: "pencil", separatorBefore: true },
    {
      id: "remove-workspace",
      label: "Remove workspace",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
    ...(input.canDeleteDirectory
      ? ([
          {
            id: "delete-directory",
            label: "Delete workspace directory",
            icon: "trash",
            destructive: true,
            separatorBefore: true,
          },
        ] satisfies ContextMenuItem<WorkspaceMenuId>[])
      : []),
  ];
}

export function projectDeleteInputs(project: EnvironmentAwenProject): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly projectId: ProjectId; readonly force: true };
}> {
  return project.workspaces.map((workspace) => ({
    environmentId: project.environmentId,
    input: { projectId: workspace.awenProjectId, force: true },
  }));
}

function rowKeydown(handler: (rect: DOMRect) => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      event.stopPropagation();
      handler(event.currentTarget.getBoundingClientRect());
    }
  };
}

/**
 * Remote = any registered target that is neither this machine's primary
 * environment nor a desktop-local secondary backend (WSL). Remote projects
 * wear a cloud icon in the sidebar tree so they read as off-machine.
 */
export function isRemoteEnvironmentTarget(target: ConnectionTarget): boolean {
  return target._tag !== "PrimaryConnectionTarget" && !isDesktopLocalConnectionTarget(target);
}

export function AwenSidebar() {
  const navigate = useNavigate();
  const projects = useAwenProjects();
  const { environments } = useEnvironments();
  const connectedEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => environment.connection.phase === "connected")
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const remoteEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isRemoteEnvironmentTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const [addWorkspaceProject, setAddWorkspaceProject] = useState<EnvironmentAwenProject | null>(
    null,
  );
  const [newWorkspaceProject, setNewWorkspaceProject] = useState<EnvironmentAwenProject | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<SidebarRenameTarget | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(new Set());
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<ReadonlySet<string>>(new Set());
  const [historyExpanded, setHistoryExpanded] = useState<ReadonlySet<string>>(new Set());
  const workspaceSessionOrderById = useUiStateStore((state) => state.workspaceSessionOrderById);

  const associateWorkspace = useAtomCommand(workspaceEnvironment.associate);
  const createWorktree = useAtomCommand(workspaceEnvironment.createWorktree);
  const removeWorkspace = useAtomCommand(workspaceEnvironment.remove);
  const renameWorkspace = useAtomCommand(workspaceEnvironment.rename);
  const renameProject = useAtomCommand(workspaceEnvironment.renameProject);
  const deleteProject = useAtomCommand(projectEnvironment.delete);
  const openTerminal = useAtomCommand(terminalEnvironment.open);
  const renameTerminalSession = useAtomCommand(terminalEnvironment.rename);
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const dragController = useWorkbenchDragController();

  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const submitSidebarRename = useCallback(
    async (target: SidebarRenameTarget, title: string) => {
      const result =
        target.kind === "Project"
          ? await renameProject({
              environmentId: target.environmentId,
              input: { projectId: target.projectId, title },
            })
          : await renameWorkspace({
              environmentId: target.environmentId,
              input: { workspaceId: target.workspaceId, title },
            });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        throw error instanceof Error ? error : new Error(`Could not rename ${target.kind}.`);
      }
    },
    [renameProject, renameWorkspace],
  );

  const toggleWorkspaceExpanded = useCallback((workspaceKey: string) => {
    setExpandedWorkspaces((current) => {
      const next = new Set(current);
      if (next.has(workspaceKey)) next.delete(workspaceKey);
      else next.add(workspaceKey);
      return next;
    });
  }, []);

  const openAgentSession = useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) => {
      const target = {
        kind: "agentSession" as const,
        environmentId,
        agentSessionId: AgentSessionId.make(threadId),
      };
      useWorkbenchStore.getState().openTarget(target);
      const route = sessionRouteForTarget(target);
      void navigate({ to: route.to as never, params: route.params } as never);
    },
    [navigate],
  );

  const createEagerAgentSession = useCallback(
    (
      project: EnvironmentAwenProject,
      workspace: AwenWorkspaceShell,
      threadId: ReturnType<typeof newThreadId>,
    ) => {
      const createdAt = new Date().toISOString();
      const draftId = DraftId.make(threadId);
      useComposerDraftStore
        .getState()
        .setWorkspaceDraftThreadId(
          workspace.id,
          scopeProjectRef(project.environmentId, workspace.awenProjectId),
          draftId,
          {
            threadId,
            createdAt,
            envMode: workspace.role === "main" ? "local" : "worktree",
            worktreePath: workspace.role === "main" ? null : workspace.workspaceRoot,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        );
      void createThread({
        environmentId: project.environmentId,
        input: {
          threadId,
          projectId: workspace.awenProjectId,
          title: "New Agent Session",
          modelSelection: NO_PROVIDER_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace.role === "main" ? null : workspace.workspaceRoot,
          createdAt,
        },
      }).then((result) => {
        if (result._tag === "Failure") {
          useComposerDraftStore.getState().clearDraftThread(draftId);
          useWorkbenchStore.getState().removeSessionViews({
            kind: "agentSession",
            environmentId: project.environmentId,
            agentSessionId: AgentSessionId.make(threadId),
          });
          if (!isAtomCommandInterrupted(result)) {
            commandFailureToast("Unable to create Agent Session", squashAtomCommandFailure(result));
          }
        }
      });
    },
    [createThread],
  );

  const newAgentSession = useCallback(
    (project: EnvironmentAwenProject, workspace: AwenWorkspaceShell) => {
      const threadId = newThreadId();
      createEagerAgentSession(project, workspace, threadId);
      openAgentSession(project.environmentId, threadId);
    },
    [createEagerAgentSession, openAgentSession],
  );

  const newTerminalSession = useCallback(
    (project: EnvironmentAwenProject, workspace: AwenWorkspaceShell) => {
      const terminalId = createTerminalId();
      void openTerminal({
        environmentId: project.environmentId,
        input: { workspaceId: workspace.id, terminalId },
      }).then((result) => {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            commandFailureToast("Unable to create terminal", squashAtomCommandFailure(result));
          }
          return;
        }
        const target = terminalTargetForRuntime({
          environmentId: project.environmentId,
          workspaceId: workspace.id,
          terminalId,
        });
        useWorkbenchStore.getState().openTarget(target);
        const route = sessionRouteForTarget(target);
        void navigate({ to: route.to as never, params: route.params, replace: true } as never);
      });
    },
    [navigate, openTerminal],
  );

  const handleAssociateWorkspace = useCallback(
    async (path: string) => {
      if (!addWorkspaceProject) return;
      const result = await associateWorkspace({
        environmentId: addWorkspaceProject.environmentId,
        input: { projectId: addWorkspaceProject.id, path },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        commandFailureToast("Could not add Workspace", error);
        throw error;
      }
      setAddWorkspaceProject(null);
    },
    [addWorkspaceProject, associateWorkspace],
  );

  const handleCreateWorkspace = useCallback(
    async (input: {
      readonly newBranch?: string | undefined;
      readonly baseRef?: string | undefined;
      readonly path?: string | undefined;
    }) => {
      if (!newWorkspaceProject) return;
      const result = await createWorktree({
        environmentId: newWorkspaceProject.environmentId,
        input: {
          projectId: newWorkspaceProject.id,
          ...(input.newBranch ? { newBranch: input.newBranch } : {}),
          ...(input.baseRef ? { baseRef: input.baseRef } : {}),
          ...(input.path ? { path: input.path } : {}),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        commandFailureToast("Could not create Workspace", error);
        throw error;
      }
      setNewWorkspaceProject(null);
    },
    [createWorktree, newWorkspaceProject],
  );

  const removeAwenProject = useCallback(
    async (project: EnvironmentAwenProject) => {
      const confirmed = await requestDestructiveConfirmation({
        message: `Remove project "${project.title}" and its Sessions?`,
        onFailure: (error) => commandFailureToast("Could not confirm project removal", error),
      });
      if (!confirmed) return;

      for (const command of projectDeleteInputs(project)) {
        const result = await deleteProject(command);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          commandFailureToast("Could not remove project", squashAtomCommandFailure(result));
          return;
        }
      }
    },
    [deleteProject],
  );

  const handleProjectMenu = useCallback(
    (project: EnvironmentAwenProject, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      void (async () => {
        const clicked = await api.contextMenu.show(
          projectMenuItems({
            canManageWorkspaces:
              serverConfigs.get(project.environmentId)?.environment.capabilities
                .workspaceManagement === true,
          }),
          position,
        );
        if (clicked === null) return;
        if (clicked === "add-workspace" || (clicked as string) === "associate-worktree") {
          setAddWorkspaceProject(project);
        }
        if (clicked === "new-workspace" || (clicked as string) === "new-worktree") {
          setNewWorkspaceProject(project);
        }
        if (clicked === "rename-project") {
          const workspace =
            project.workspaces.find((candidate) => candidate.role === "main") ??
            project.workspaces[0];
          setRenameTarget({
            kind: "Project",
            environmentId: project.environmentId,
            projectId: project.id,
            title: project.title,
            directoryName: directoryName(workspace?.workspaceRoot, project.title),
          });
        }
        if (clicked === "remove-project") await removeAwenProject(project);
      })();
    },
    [removeAwenProject, serverConfigs],
  );

  const handleWorkspaceMenu = useCallback(
    (
      project: EnvironmentAwenProject,
      workspace: AwenWorkspaceShell,
      position: { x: number; y: number },
    ) => {
      const api = readLocalApi();
      if (!api) return;
      void (async () => {
        const clicked = await api.contextMenu.show(
          workspaceMenuItems({
            canDeleteDirectory: workspace.origin === "awen-created",
            onDragBrowseFiles: (event) => {
              dragController.beginDrag(
                {
                  kind: "sidebar",
                  target: {
                    kind: "workspace",
                    definitionId: "fileView",
                    environmentId: project.environmentId,
                    workspaceId: workspace.id,
                  },
                },
                "Browse Files",
                event,
              );
            },
            onDragReviewChanges: (event) => {
              dragController.beginDrag(
                {
                  kind: "sidebar",
                  target: {
                    kind: "workspace",
                    definitionId: "gitView",
                    environmentId: project.environmentId,
                    workspaceId: workspace.id,
                  },
                },
                "Review Changes",
                event,
              );
            },
            onDragNewAgentSession: (event) => {
              const threadId = newThreadId();
              const target = {
                kind: "agentSession" as const,
                environmentId: project.environmentId,
                agentSessionId: AgentSessionId.make(threadId),
              };
              dragController.beginDrag(
                {
                  kind: "sidebar",
                  target,
                  workspaceId: workspace.id,
                  onCommit: () => {
                    createEagerAgentSession(project, workspace, threadId);
                  },
                },
                "New Agent Session",
                event,
              );
            },
            onDragNewTerminalSession: (event) => {
              const terminalId = createTerminalId();
              const target = terminalTargetForRuntime({
                environmentId: project.environmentId,
                workspaceId: workspace.id,
                terminalId,
              });
              dragController.beginDrag(
                {
                  kind: "sidebar",
                  target,
                  onCommit: () => {
                    void openTerminal({
                      environmentId: project.environmentId,
                      input: { workspaceId: workspace.id, terminalId },
                    }).then((result) => {
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        commandFailureToast(
                          "Unable to create terminal",
                          squashAtomCommandFailure(result),
                        );
                      }
                    });
                  },
                },
                "Terminal Session",
                event,
              );
            },
          }),
          position,
        );
        if (clicked === null) return;
        if (clicked === "browse-files") {
          useWorkbenchStore.getState().openTarget({
            kind: "workspace",
            definitionId: "fileView",
            environmentId: project.environmentId,
            workspaceId: workspace.id,
          });
        }
        if (clicked === "review-changes") {
          useWorkbenchStore.getState().openTarget({
            kind: "workspace",
            definitionId: "gitView",
            environmentId: project.environmentId,
            workspaceId: workspace.id,
          });
        }
        if (clicked === "new-agent-session") newAgentSession(project, workspace);
        if (clicked === "new-terminal-session") newTerminalSession(project, workspace);
        if (clicked === "rename-workspace") {
          setRenameTarget({
            kind: "Workspace",
            environmentId: project.environmentId,
            workspaceId: workspace.id,
            title: workspace.title,
            directoryName: directoryName(workspace.workspaceRoot, workspace.title),
          });
        }
        if (clicked === "remove-workspace" || (clicked as string) === "remove-registration") {
          const confirmed = await requestDestructiveConfirmation({
            message: `Remove Workspace "${workspace.title}" from this project?`,
            onFailure: (error) => commandFailureToast("Could not confirm Workspace removal", error),
          });
          if (!confirmed) return;

          const result = await removeWorkspace({
            environmentId: project.environmentId,
            input: { workspaceId: workspace.id },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            commandFailureToast("Could not remove Workspace", squashAtomCommandFailure(result));
          }
        }
        if (clicked === "delete-directory") {
          const confirmed = await requestDestructiveConfirmation({
            message: `Remove Workspace "${workspace.title}" and delete its directory?`,
            onFailure: (error) =>
              commandFailureToast("Could not confirm Workspace deletion", error),
          });
          if (!confirmed) return;

          const result = await removeWorkspace({
            environmentId: project.environmentId,
            input: { workspaceId: workspace.id, deleteDirectory: true },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            commandFailureToast("Could not delete Workspace", squashAtomCommandFailure(result));
          }
        }
      })();
    },
    [
      createEagerAgentSession,
      dragController,
      newAgentSession,
      newTerminalSession,
      openTerminal,
      removeWorkspace,
    ],
  );

  const renameAgent = useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId, currentTitle: string) => {
      const title = window.prompt("Session name", currentTitle)?.trim();
      if (!title) return;
      void updateThreadMetadata({ environmentId, input: { threadId, title } }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          commandFailureToast("Could not rename Agent Session", squashAtomCommandFailure(result));
        }
      });
    },
    [updateThreadMetadata],
  );

  const renameTerminal = useCallback(
    (target: Extract<ViewTarget, { kind: "workspaceTerminal" }>, currentTitle: string) => {
      const title = window.prompt("Session name", currentTitle)?.trim();
      if (!title) return;
      const terminalId = runtimeTerminalIdForTarget(target);
      void renameTerminalSession({
        environmentId: target.environmentId,
        input: {
          terminalId,
          ...(target.workspaceId !== undefined ? { workspaceId: target.workspaceId } : {}),
          title,
        },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          commandFailureToast(
            "Could not rename Terminal Session",
            squashAtomCommandFailure(result),
          );
        }
      });
    },
    [renameTerminalSession],
  );

  return (
    <>
      <SidebarChromeHeader />
      <SidebarContent className="gap-0">
        {/* 最上面区域：可以放置若干按钮，每个一行，目前先只放 Add Project */}
        <SidebarGroup data-testid="sidebar-top-section" className="shrink-0 px-2 pt-2 pb-1">
          <div className="flex flex-col gap-1 w-full">
            <button
              type="button"
              data-testid="sidebar-add-project"
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-sidebar-row-hover"
              onClick={openAddProject}
            >
              <PlusIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Add Project</span>
            </button>
          </div>
        </SidebarGroup>

        {/* 中间区域：紧贴着上面区域，放置实际 sidebar 的三级菜单（project/workspace/session），并且这里去掉 Projects 字样，直接显示三级树状菜单 */}
        <SidebarGroup
          data-testid="sidebar-middle-section"
          className="min-h-0 flex-1 overflow-auto px-2 pb-2 pt-0"
        >
          <div
            role="tree"
            aria-label="Projects, Workspaces, and Sessions"
            className="flex flex-col gap-px"
          >
            {projects.map((project) => {
              const projectKey = `${project.environmentId}:${project.id}`;
              const projectCollapsed = collapsedProjects.has(projectKey);
              return (
                <div key={projectKey} role="treeitem" aria-expanded={!projectCollapsed}>
                  <button
                    type="button"
                    data-testid="sidebar-project-row"
                    className="group/rename flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs font-medium hover:bg-sidebar-row-hover"
                    onClick={() =>
                      setCollapsedProjects((current) => {
                        const next = new Set(current);
                        if (next.has(projectKey)) next.delete(projectKey);
                        else next.add(projectKey);
                        return next;
                      })
                    }
                    onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleProjectMenu(project, { x: event.clientX, y: event.clientY });
                    }}
                    onKeyDown={rowKeydown((rect) => {
                      handleProjectMenu(project, { x: rect.left + rect.width / 2, y: rect.bottom });
                    })}
                  >
                    {projectCollapsed ? (
                      <ChevronRightIcon className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronDownIcon className="size-3.5 shrink-0" />
                    )}
                    {remoteEnvironmentIds.has(project.environmentId) ? (
                      <CloudIcon
                        aria-label="Remote project"
                        className="size-3.5 shrink-0 text-sidebar-muted-foreground"
                      />
                    ) : (
                      <FolderIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
                    )}
                    <SidebarHoverName
                      displayName={project.title}
                      actualName={directoryName(
                        (
                          project.workspaces.find((workspace) => workspace.role === "main") ??
                          project.workspaces[0]
                        )?.workspaceRoot,
                        project.title,
                      )}
                      className="min-w-0 flex-1 truncate"
                    />
                  </button>
                  {!projectCollapsed ? (
                    <div className="ms-4 flex flex-col gap-px border-s border-sidebar-border ps-1.5">
                      {project.workspaces.map((workspace) => {
                        const workspaceKey = `${project.environmentId}:${workspace.id}`;
                        const workspaceExpanded = expandedWorkspaces.has(workspaceKey);
                        const sessionOrder = workspaceSessionOrderById[workspaceKey];
                        const rawSessions = workspace.sessions ?? [];
                        const activeSessions =
                          sessionOrder && sessionOrder.length > 0
                            ? (() => {
                                const rank = new Map(sessionOrder.map((id, index) => [id, index]));
                                return [...rawSessions].sort((a, b) => {
                                  const rankA = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
                                  const rankB = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
                                  return rankA - rankB;
                                });
                              })()
                            : rawSessions;
                        const historySessions = workspace.historySessions ?? [];
                        return (
                          <div key={workspaceKey} className="flex flex-col gap-px">
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                data-testid="sidebar-workspace-disclosure"
                                aria-label={
                                  workspaceExpanded ? "Collapse Workspace" : "Expand Workspace"
                                }
                                className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-sidebar-row-hover"
                                onClick={() => toggleWorkspaceExpanded(workspaceKey)}
                              >
                                {workspaceExpanded ? (
                                  <ChevronDownIcon className="size-3" />
                                ) : (
                                  <ChevronRightIcon className="size-3" />
                                )}
                              </button>
                              <button
                                type="button"
                                data-testid="sidebar-workspace-row"
                                data-environment-connected={connectedEnvironmentIds.has(
                                  project.environmentId,
                                )}
                                role="treeitem"
                                className="group/rename flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                                onClick={() => toggleWorkspaceExpanded(workspaceKey)}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  handleWorkspaceMenu(project, workspace, {
                                    x: event.clientX,
                                    y: event.clientY,
                                  });
                                }}
                                onKeyDown={rowKeydown((rect) => {
                                  handleWorkspaceMenu(project, workspace, {
                                    x: rect.left + rect.width / 2,
                                    y: rect.bottom,
                                  });
                                })}
                              >
                                <GitBranchIcon className="size-3 shrink-0" />
                                <span
                                  data-testid="sidebar-workspace-branch"
                                  className="min-w-0 flex-1 truncate font-medium"
                                >
                                  {workspace.branch ||
                                    (workspace.role === "main" ? "main" : workspace.title)}
                                </span>
                                <SidebarHoverName
                                  displayName={workspace.title}
                                  actualName={directoryName(
                                    workspace.workspaceRoot,
                                    workspace.title,
                                  )}
                                  actualTestId="sidebar-workspace-dir"
                                  className="max-w-[52%] shrink-0 truncate text-[10px] text-sidebar-muted-foreground"
                                />
                              </button>
                            </div>
                            {workspaceExpanded ? (
                              <div className="ms-4 flex flex-col gap-px border-s border-sidebar-border ps-1.5">
                                <WorkspaceActiveSessions
                                  project={project}
                                  workspace={workspace}
                                  workspaceKey={workspaceKey}
                                  activeSessions={activeSessions}
                                  renameAgent={renameAgent}
                                  renameTerminal={renameTerminal}
                                  navigate={navigate}
                                />
                                {historySessions.length > 0 ? (
                                  <button
                                    type="button"
                                    data-testid="sidebar-history-toggle"
                                    className="flex min-h-6 items-center gap-1 rounded-md px-2 text-left text-[10px] text-sidebar-muted-foreground hover:bg-sidebar-row-hover"
                                    onClick={() =>
                                      setHistoryExpanded((current) => {
                                        const next = new Set(current);
                                        if (next.has(workspaceKey)) next.delete(workspaceKey);
                                        else next.add(workspaceKey);
                                        return next;
                                      })
                                    }
                                  >
                                    {historyExpanded.has(workspaceKey) ? (
                                      <ChevronDownIcon className="size-3" />
                                    ) : (
                                      <ChevronRightIcon className="size-3" />
                                    )}
                                    History ({historySessions.length})
                                  </button>
                                ) : null}
                                {historyExpanded.has(workspaceKey)
                                  ? historySessions.map((session) =>
                                      session.kind === "agent" ? (
                                        <WorkspaceAgentSessionRow
                                          key={session.id}
                                          project={project}
                                          workspace={workspace}
                                          session={session}
                                          isClosed
                                          renameAgent={renameAgent}
                                          navigate={navigate}
                                        />
                                      ) : (
                                        <WorkspaceTerminalSessionRow
                                          key={session.id}
                                          project={project}
                                          workspace={workspace}
                                          session={session}
                                          isClosed
                                          renameTerminal={renameTerminal}
                                          navigate={navigate}
                                        />
                                      ),
                                    )
                                  : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </SidebarGroup>
      </SidebarContent>

      {/* 下面区域：向下对齐，贴着底边，目前先什么都不放 */}
      <div
        data-testid="sidebar-bottom-section"
        className="mt-auto shrink-0 px-2 py-2 empty:min-h-0 empty:p-0"
      />

      <SidebarChromeFooter />

      <AddWorkspaceDialog
        project={addWorkspaceProject}
        open={addWorkspaceProject !== null}
        onOpenChange={(open) => {
          if (!open) setAddWorkspaceProject(null);
        }}
        onAssociate={handleAssociateWorkspace}
      />
      <NewWorkspaceDialog
        project={newWorkspaceProject}
        open={newWorkspaceProject !== null}
        onOpenChange={(open) => {
          if (!open) setNewWorkspaceProject(null);
        }}
        onCreate={handleCreateWorkspace}
      />
      {renameTarget !== null ? (
        <SidebarRenameDialog
          key={
            renameTarget.kind === "Project"
              ? `project:${renameTarget.projectId}`
              : `workspace:${renameTarget.workspaceId}`
          }
          kind={renameTarget.kind}
          title={renameTarget.title}
          directoryName={renameTarget.directoryName}
          onClose={() => setRenameTarget(null)}
          onRename={(title) => submitSidebarRename(renameTarget, title)}
        />
      ) : null}
    </>
  );
}

function WorkspaceAgentSessionRow({
  project,
  workspace,
  session,
  isClosed = false,
  style,
  renameAgent,
  navigate,
}: {
  readonly project: EnvironmentAwenProject;
  readonly workspace: EnvironmentAwenProject["workspaces"][number];
  readonly session: { readonly id: string; readonly title: string; readonly threadId: ThreadId };
  readonly isClosed?: boolean;
  readonly style?: CSSProperties;
  readonly renameAgent: (environmentId: EnvironmentId, threadId: ThreadId, title: string) => void;
  readonly navigate: ReturnType<typeof useNavigate>;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(project.environmentId, session.threadId),
    [project.environmentId, session.threadId],
  );
  const threadShell = useThreadShell(threadRef);
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const ProviderIcon = resolveAgentIcon(threadShell?.modelSelection?.instanceId);
  const status = isClosed ? "ready" : resolveAgentSessionStatus(threadShell);
  const isUnread =
    !isClosed &&
    isUnreadCompletion({
      status,
      latestTurn: threadShell?.latestTurn,
      lastVisitedAt,
    });

  return (
    <SessionRow
      key={session.id}
      workspaceId={workspace.id}
      style={style}
      data-testid="sidebar-session-row"
      data-session-kind="agent"
      data-session-closed={isClosed ? "true" : undefined}
      isClosed={isClosed}
      sessionTitle={session.title}
      status={status}
      isUnread={isUnread}
      target={{
        kind: "agentSession",
        environmentId: project.environmentId,
        agentSessionId: session.id as AgentSessionId,
      }}
      onStartRename={() => renameAgent(project.environmentId, session.threadId, session.title)}
      navigateTo={(route) => void navigate({ ...route, to: route.to as never } as never)}
    >
      <ProviderIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
    </SessionRow>
  );
}

function WorkspaceTerminalSessionRow({
  project,
  workspace,
  session,
  isClosed = false,
  style,
  renameTerminal,
  navigate,
}: {
  readonly project: EnvironmentAwenProject;
  readonly workspace: EnvironmentAwenProject["workspaces"][number];
  readonly session: { readonly id: string; readonly title: string };
  readonly isClosed?: boolean;
  readonly style?: CSSProperties;
  readonly renameTerminal: (
    target: Extract<ViewTarget, { kind: "workspaceTerminal" }>,
    title: string,
  ) => void;
  readonly navigate: ReturnType<typeof useNavigate>;
}) {
  const knownSessions = useKnownTerminalSessions({
    environmentId: project.environmentId,
    workspaceId: workspace.id,
  });
  const terminalSession = knownSessions.find(
    (item) =>
      item.target.terminalId === session.id ||
      item.state.summary?.terminalId === session.id ||
      item.state.summary?.sessionId === session.id,
  );
  const summary = terminalSession?.state.summary;
  const TerminalOrAgentIcon = resolveTerminalIcon(summary);
  const status = isClosed ? "ready" : resolveTerminalSessionStatus(summary);

  return (
    <SessionRow
      key={session.id}
      workspaceId={workspace.id}
      style={style}
      data-testid="sidebar-session-row"
      data-session-kind="terminal"
      data-session-closed={isClosed ? "true" : undefined}
      isClosed={isClosed}
      sessionTitle={session.title}
      status={status}
      target={{
        kind: "workspaceTerminal",
        environmentId: project.environmentId,
        workspaceId: workspace.id,
        terminalSessionId: session.id as TerminalSessionId,
      }}
      navigateTo={(route) => void navigate({ ...route, to: route.to as never } as never)}
      onStartRename={() =>
        renameTerminal(
          {
            kind: "workspaceTerminal",
            environmentId: project.environmentId,
            workspaceId: workspace.id,
            terminalSessionId: session.id as TerminalSessionId,
          },
          session.title,
        )
      }
    >
      <TerminalOrAgentIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
    </SessionRow>
  );
}

interface WorkspaceActiveSessionsProps {
  readonly project: EnvironmentAwenProject;
  readonly workspace: EnvironmentAwenProject["workspaces"][number];
  readonly workspaceKey: string;
  readonly activeSessions: ReadonlyArray<
    NonNullable<EnvironmentAwenProject["workspaces"][number]["sessions"]>[number]
  >;
  readonly renameAgent: (environmentId: EnvironmentId, threadId: ThreadId, title: string) => void;
  readonly renameTerminal: (
    target: Extract<ViewTarget, { kind: "workspaceTerminal" }>,
    title: string,
  ) => void;
  readonly navigate: ReturnType<typeof useNavigate>;
}

function WorkspaceActiveSessions({
  project,
  workspace,
  workspaceKey,
  activeSessions,
  renameAgent,
  renameTerminal,
  navigate,
}: WorkspaceActiveSessionsProps) {
  const dragState = useWorkbenchDragState();
  const containerRef = useRef<HTMLDivElement>(null);
  const [settlingSession, setSettlingSession] = useState<{
    sessionId: string;
    offset: number;
  } | null>(null);
  const lastSessionDragInfoRef = useRef<{
    sessionId: string;
    fromIndex: number;
    toIndex: number;
    deltaY: number;
  } | null>(null);

  const isSessionTarget =
    dragState?.source.kind === "sidebar" &&
    (dragState.source.target.kind === "agentSession" ||
      dragState.source.target.kind === "workspaceTerminal");
  const isSidebarDrag =
    dragState?.phase === "dragging" &&
    dragState.source.kind === "sidebar" &&
    dragState.isOverSidebar;
  const isCurrentWorkspaceDrag =
    isSidebarDrag &&
    isSessionTarget &&
    dragState.source.target.environmentId === project.environmentId &&
    dragState.source.workspaceId === workspace.id;

  const draggedSessionId =
    isCurrentWorkspaceDrag && dragState && isSessionTarget
      ? dragState.source.target.kind === "agentSession"
        ? dragState.source.target.agentSessionId
        : dragState.source.target.terminalSessionId
      : null;

  const draggedSourceIndex = draggedSessionId
    ? activeSessions.findIndex((s) => s.id === draggedSessionId)
    : -1;

  const rowHeight = 25; // 24px button height + 1px gap
  const deltaY =
    isCurrentWorkspaceDrag && dragState ? dragState.pointer.y - dragState.startPointer.y : 0;

  let targetIndex = draggedSourceIndex;
  if (isCurrentWorkspaceDrag && draggedSourceIndex >= 0 && dragState) {
    const containerEl = containerRef.current;
    if (containerEl) {
      const containerRect = containerEl.getBoundingClientRect();
      const currentCenterY = dragState.startRect.top + deltaY + rowHeight / 2 - containerRect.top;
      const rawSlot = Math.floor(currentCenterY / rowHeight);
      targetIndex = Math.max(0, Math.min(rawSlot, activeSessions.length - 1));
    }
  }

  if (isCurrentWorkspaceDrag && draggedSessionId && draggedSourceIndex >= 0) {
    lastSessionDragInfoRef.current = {
      sessionId: draggedSessionId,
      fromIndex: draggedSourceIndex,
      toIndex: targetIndex,
      deltaY,
    };
  } else if (lastSessionDragInfoRef.current) {
    const prev = lastSessionDragInfoRef.current;
    lastSessionDragInfoRef.current = null;
    const isCancelled = dragState?.phase === "canceling" || dragState?.phase === "rejected";
    const initialOffset = isCancelled
      ? prev.deltaY
      : (prev.fromIndex - prev.toIndex) * rowHeight + prev.deltaY;
    if (Math.abs(initialOffset) > 2) {
      setSettlingSession({ sessionId: prev.sessionId, offset: initialOffset });
    }
  }

  useEffect(() => {
    if (!settlingSession) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        setSettlingSession(null);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [settlingSession]);

  return (
    <div
      ref={containerRef}
      data-sidebar-active-sessions={workspaceKey}
      className="flex flex-col gap-px"
    >
      {activeSessions.map((session, index) => {
        const isDragged = isCurrentWorkspaceDrag && session.id === draggedSessionId;
        const isSettling = settlingSession?.sessionId === session.id;

        let sessionStyle: CSSProperties | undefined;
        if (isCurrentWorkspaceDrag && draggedSourceIndex >= 0) {
          if (isDragged) {
            sessionStyle = {
              transform: `translate3d(0, ${deltaY}px, 0)`,
              zIndex: 30,
              opacity: 0.95,
              pointerEvents: "none",
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
              transition: "none",
            };
          } else {
            let shift = 0;
            if (targetIndex > draggedSourceIndex) {
              if (index > draggedSourceIndex && index <= targetIndex) {
                shift = -rowHeight;
              }
            } else if (targetIndex < draggedSourceIndex) {
              if (index >= targetIndex && index < draggedSourceIndex) {
                shift = rowHeight;
              }
            }
            sessionStyle = {
              transform: shift !== 0 ? `translate3d(0, ${shift}px, 0)` : undefined,
              transition:
                "transform calc(220ms * var(--motion-duration-scale, 1)) cubic-bezier(0.22, 1, 0.36, 1)",
            };
          }
        } else if (settlingSession) {
          if (settlingSession.sessionId === session.id) {
            sessionStyle = {
              transform: `translate3d(0, ${settlingSession.offset}px, 0)`,
              transition: "none",
            };
          } else {
            sessionStyle = {
              transition: "none",
            };
          }
        } else {
          sessionStyle = {
            transition:
              "transform calc(220ms * var(--motion-duration-scale, 1)) cubic-bezier(0.22, 1, 0.36, 1)",
          };
        }

        if (session.kind === "agent") {
          return (
            <WorkspaceAgentSessionRow
              key={session.id}
              style={sessionStyle}
              project={project}
              workspace={workspace}
              session={session}
              renameAgent={renameAgent}
              navigate={navigate}
            />
          );
        }

        return (
          <WorkspaceTerminalSessionRow
            key={session.id}
            style={sessionStyle}
            project={project}
            workspace={workspace}
            session={session}
            renameTerminal={renameTerminal}
            navigate={navigate}
          />
        );
      })}
    </div>
  );
}
