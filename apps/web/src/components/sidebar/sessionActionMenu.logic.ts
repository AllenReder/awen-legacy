import type { ContextMenuItem } from "@awen/contracts";

export type SessionActionMenuId =
  | "open"
  | "focus"
  | "split:right"
  | "split:down"
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

  if (state.canRename) {
    items.push({
      id: "rename",
      label: "Rename",
      icon: "pencil",
      separatorBefore: true,
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
