import type { ContextMenuItem, WorkspaceId } from "@awen/contracts";

/**
 * The other Workspaces of the same Project that an Agent Session assigned to
 * `workspaceId` can move to. Returns an empty list when the Project or the
 * current Workspace is not in the projection.
 */
export function siblingWorkspacesForAgent<
  P extends {
    readonly environmentId: string;
    readonly workspaces: ReadonlyArray<{ readonly id: WorkspaceId }>;
  },
>(projects: ReadonlyArray<P>, environmentId: string, workspaceId: WorkspaceId): P["workspaces"] {
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === environmentId &&
      candidate.workspaces.some((workspace) => workspace.id === workspaceId),
  );
  if (project === undefined) return [];
  return project.workspaces.filter((workspace) => workspace.id !== workspaceId);
}

export type SessionActionMenuId =
  | "open"
  | "focus"
  | "split:right"
  | "split:down"
  | "move-workspace"
  | "rename"
  | "close-session"
  | "delete-session";

export interface SessionActionMenuState {
  readonly kind: "agent" | "terminal";
  readonly isClosed: boolean;
  /**
   * Whether this Session already has its one Session View in the Workbench.
   * ADR-0010 makes a Session View unique across Tabs, not just within one.
   */
  readonly isOpenInWorkbench: boolean;
  /** Whether that View currently has focus. */
  readonly isFocusedInWorkbench: boolean;
  readonly canRename: boolean;
  readonly canClose: boolean;
  readonly canDelete: boolean;
  /** Agent-only: the Session can move to another Workspace of its Project. */
  readonly canMigrate: boolean;
  /** Migration is refused while the Agent is executing. */
  readonly canMigrateNow: boolean;
}

/**
 * Build the capability-gated context menu items for an Agent or Terminal Session.
 *
 * Rules:
 * - Active rows show Open, Focus (when open), Split right/down, Close session, Delete session.
 * - History rows show Open, Focus (when open), Split right/down, Delete session (no Close session).
 * - Focus is disabled if already focused; Split moves the existing View instead of
 *   opening a second one.
 * - Rename is provided when the caller exposes a rename operation.
 * - Delete session is styled as destructive with separator.
 */
export function buildSessionActionMenuItems(
  state: SessionActionMenuState,
): ReadonlyArray<ContextMenuItem<SessionActionMenuId>> {
  const items: ContextMenuItem<SessionActionMenuId>[] = [
    {
      id: "open",
      label: "Open",
      icon: "maximize-2",
    },
  ];

  if (state.isOpenInWorkbench) {
    items.push({
      id: "focus",
      label: "Focus",
      icon: "crosshair",
      disabled: state.isFocusedInWorkbench,
    });
  }

  items.push(
    {
      id: "split:right",
      label: "Split right",
      icon: "columns",
    },
    {
      id: "split:down",
      label: "Split down",
      icon: "rows",
    },
  );

  if (state.canMigrate) {
    items.push({
      id: "move-workspace",
      label: "Move to Workspace…",
      icon: "folder",
      separatorBefore: true,
      disabled: !state.canMigrateNow,
    });
  }

  if (state.canRename) {
    items.push({
      id: "rename",
      label: "Rename",
      icon: "pencil",
      separatorBefore: !state.canMigrate,
    });
  }

  if (!state.isClosed && state.canClose) {
    items.push({
      id: "close-session",
      label: "Close session",
      icon: "x-circle",
      separatorBefore: true,
    });
  }

  if (state.canDelete) {
    items.push({
      id: "delete-session",
      label: "Delete session",
      icon: "trash",
      destructive: true,
      separatorBefore: state.isClosed || !state.canClose,
    });
  }

  return items;
}
