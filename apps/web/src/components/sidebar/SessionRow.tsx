import { useCallback, useState, type ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { getSessionRowTabState, type SessionRowTabState } from "../../workbench/workbenchState";
import { useWorkbenchStore } from "../../workbench/workbenchStore";
import type { ViewTarget } from "../../workbench/viewRegistry";
import { sessionRouteForTarget } from "../../workbench/deepLinks";
import { useSessionActionMenu } from "../../hooks/useSessionActionMenu";
import { useWorkbenchDragSource, useWorkbenchDragState } from "../../workbench/workbenchDrag";
import { FLUID_MOTION_DURATION_MS, scaledMotionDuration } from "../../workbench/workbenchMotion";
import type { WillCloseRevert } from "../../hooks/useSessionCommands";
import type { SessionStatus } from "./sidebarSessionPresentation";
import type { WorkspaceId } from "@awen/contracts";

export type SessionTarget = Extract<ViewTarget, { kind: "agentSession" | "workspaceTerminal" }>;
export type SessionTabState = SessionRowTabState;

const STATUS_DOT_CLASS: Record<Exclude<SessionStatus, "ready">, string> = {
  approval: "size-1.5 rounded-full bg-amber-500",
  input: "size-1.5 rounded-full bg-indigo-500",
  plan: "size-1.5 rounded-full bg-violet-500",
  working: "size-1.5 rounded-full bg-sky-500 animate-pulse",
  monitoring: "size-1.5 rounded-full bg-sky-500",
  failed: "size-1.5 rounded-full bg-destructive",
};

const UNREAD_COMPLETION_DOT_CLASS = "size-1.5 rounded-full bg-emerald-500";

export interface SessionRowProps extends ComponentProps<"button"> {
  readonly target: SessionTarget;
  readonly workspaceId?: WorkspaceId;
  readonly isClosed?: boolean;
  readonly isClosing?: boolean;
  readonly onWillClose?: () => Promise<WillCloseRevert | void> | WillCloseRevert | void;
  readonly sessionTitle?: string;
  readonly status?: SessionStatus;
  readonly isUnread?: boolean;
  readonly onStartRename?: () => void;
  readonly navigateTo?: (input: {
    readonly to: string;
    readonly params: Record<string, string>;
    readonly replace: boolean;
  }) => void;
}

/** Sidebar navigation addresses Sessions; Workbench commands own layout and uniqueness. */
export function SessionRow({
  target,
  workspaceId: assignedWorkspaceId,
  isClosed = false,
  isClosing = false,
  onWillClose,
  sessionTitle,
  status = "ready",
  isUnread = false,
  onStartRename,
  navigateTo,
  onClick,
  onClickCapture,
  onContextMenu,
  onKeyDown,
  onPointerDown,
  onMouseDown,
  onAuxClick,
  className,
  ...props
}: SessionRowProps) {
  const tabState = useWorkbenchStore((state) => getSessionRowTabState(state, target));

  const isFocused = tabState === "active-focused";
  const isOpenInActiveTab = isFocused || tabState === "active-unfocused";
  const isOpenInWorkbench = tabState !== "unopened";

  const workspaceId =
    assignedWorkspaceId ?? (target.kind === "workspaceTerminal" ? target.workspaceId : null);
  const workspaceKey = `${target.environmentId}:${workspaceId ?? ""}`;
  const sessionId =
    target.kind === "agentSession" ? target.agentSessionId : target.terminalSessionId;

  const dotClass =
    status === "ready" ? (isUnread ? UNREAD_COMPLETION_DOT_CLASS : null) : STATUS_DOT_CLASS[status];

  const dragState = useWorkbenchDragState();
  const draggedTarget = dragState?.source.kind === "sidebar" ? dragState.source.target : null;
  const isBeingDragged =
    draggedTarget !== null &&
    draggedTarget.kind === target.kind &&
    draggedTarget.environmentId === target.environmentId &&
    (dragState?.source.kind !== "sidebar" || dragState.source.workspaceId === workspaceId) &&
    (draggedTarget.kind === "agentSession" && target.kind === "agentSession"
      ? draggedTarget.agentSessionId === target.agentSessionId
      : draggedTarget.kind === "workspaceTerminal" && target.kind === "workspaceTerminal"
        ? draggedTarget.terminalSessionId === target.terminalSessionId
        : false);

  const [selfClosing, setSelfClosing] = useState(false);
  const handleWillClose = useCallback(async () => {
    setSelfClosing(true);
    const duration = scaledMotionDuration(FLUID_MOTION_DURATION_MS);
    if (duration > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, duration));
    }
    const outerRevert = await onWillClose?.();
    return () => {
      setSelfClosing(false);
      outerRevert?.();
    };
  }, [onWillClose]);

  const closing = isClosing || selfClosing;
  const buttonStyle = closing ? undefined : props.style;

  const { openMenu, commands } = useSessionActionMenu({
    target,
    isClosed,
    sessionTitle,
    onStartRename,
    navigateTo,
    onWillClose: handleWillClose,
  });
  const drag = useWorkbenchDragSource(
    { kind: "sidebar", target, ...(workspaceId ? { workspaceId } : {}) },
    sessionTitle ?? (target.kind === "agentSession" ? "Agent Session" : "Terminal Session"),
  );
  const navigateTarget = () => {
    const route = sessionRouteForTarget(target);
    if (navigateTo !== undefined) {
      navigateTo({ ...route, replace: true });
      return;
    }
    if (typeof window !== "undefined" && "__awenRouter" in window) {
      const router = (window as { __awenRouter?: { navigate: (input: unknown) => void } })
        .__awenRouter;
      router?.navigate({ ...route, replace: true });
    }
  };

  return (
    <button
      {...props}
      style={buttonStyle}
      type="button"
      role="treeitem"
      aria-level={3}
      data-workbench-drag-source="sidebar"
      data-sidebar-session-row="true"
      data-session-closed={isClosed ? "true" : undefined}
      data-session-closing={closing ? "true" : undefined}
      data-workspace-key={workspaceKey}
      data-session-id={sessionId}
      className={cn(
        "sidebar-session-row-item relative flex min-h-6 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground will-change-transform",
        isBeingDragged && (props.style?.opacity !== undefined ? undefined : "opacity-40"),
        isFocused
          ? "bg-sidebar-row-active font-bold text-sidebar-foreground"
          : tabState === "active-unfocused"
            ? "text-sidebar-foreground"
            : tabState === "background-tab"
              ? "text-sidebar-foreground/80"
              : undefined,
        isClosed && "opacity-75",
        className,
      )}
      aria-current={isFocused ? "page" : isOpenInActiveTab ? "true" : undefined}
      data-session-tab-state={tabState}
      data-session-focused={isFocused ? "true" : "false"}
      data-session-open={isOpenInWorkbench ? "true" : "false"}
      aria-description="Open Session (Alt/Option: split right; Alt/Option+Shift: split down)"
      onClick={(event) => {
        const commands = useWorkbenchStore.getState();
        if (event.altKey) {
          commands.splitFocused(target, event.shiftKey ? "down" : "right");
        } else {
          commands.openTarget(target);
          navigateTarget();
        }
        onClick?.(event);
      }}
      onClickCapture={(event) => {
        if (drag.consumeSuppressedClick()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClickCapture?.(event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu({ x: event.clientX, y: event.clientY });
        onContextMenu?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu({ x: rect.left + rect.width / 2, y: rect.bottom });
        }
        onKeyDown?.(event);
      }}
      onPointerDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
        } else if (!isClosed && !closing) {
          drag.onPointerDown(event);
        }
        onPointerDown?.(event);
      }}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
        onMouseDown?.(event);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
          if (!closing && !isBeingDragged) {
            if (isClosed) {
              void commands.deleteSession(sessionTitle);
            } else {
              void commands.closeSession();
            }
          }
        }
        onAuxClick?.(event);
      }}
    >
      <span
        aria-hidden="true"
        data-status-gutter="true"
        data-session-status={status}
        data-session-unread={isUnread ? "true" : "false"}
        className="pointer-events-none flex size-3.5 shrink-0 items-center justify-center"
      >
        {dotClass !== null ? <span className={dotClass} /> : null}
      </span>
      {tabState === "active-unfocused" ? (
        <span
          aria-hidden="true"
          data-session-indicator="active-unfocused"
          className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 h-3.5 w-0.5 rounded-full bg-primary/80"
        />
      ) : null}
      {tabState === "background-tab" ? (
        <span
          aria-hidden="true"
          data-session-indicator="background-tab"
          className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 size-0.5 rounded-full bg-muted-foreground/70"
        />
      ) : null}
      {props.children}
    </button>
  );
}
