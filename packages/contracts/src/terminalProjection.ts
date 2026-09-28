import { WorkspaceId } from "./baseSchemas.ts";
import type { TerminalSummary } from "./terminal.ts";
import type { AwenProjectShell, AwenTerminalSessionShell } from "./workspace.ts";

/**
 * Join the terminal metadata projection to the durable Workspace tree. The
 * metadata stream is authoritative for terminals; orchestration owns Agents.
 *
 * A terminal with no Workspace assignment is not part of any Workspace subtree;
 * its Pane and deep link survive independently of the assignment.
 */
export function projectTerminalSessions(
  projects: ReadonlyArray<AwenProjectShell>,
  terminals: ReadonlyArray<TerminalSummary>,
): ReadonlyArray<AwenProjectShell> {
  const activeSessions = new Map<WorkspaceId, Map<string, AwenTerminalSessionShell>>();
  const historySessions = new Map<WorkspaceId, Map<string, AwenTerminalSessionShell>>();

  for (const terminal of terminals) {
    if (terminal.workspaceId === undefined) continue;
    const workspaceId = WorkspaceId.make(terminal.workspaceId);
    const id = terminal.sessionId;
    const isClosed = terminal.status === "closed";
    const targetMap = isClosed ? historySessions : activeSessions;
    let group = targetMap.get(workspaceId);
    if (!group) {
      group = new Map();
      targetMap.set(workspaceId, group);
    }
    group.set(id, {
      kind: "terminal",
      id,
      workspaceId,
      title: (terminal.title ?? terminal.label).trim() || "Terminal",
      status: isClosed ? "closed" : "open",
      ...(isClosed ? { closedAt: terminal.updatedAt } : {}),
      createdAt: terminal.createdAt ?? terminal.updatedAt,
      updatedAt: terminal.updatedAt,
    });
  }
  return projects.map((project) => ({
    ...project,
    workspaces: project.workspaces.map((workspace) => ({
      ...workspace,
      sessions: [
        ...(workspace.sessions ?? []).filter((session) => session.kind !== "terminal"),
        ...(activeSessions.get(workspace.id)?.values() ?? []),
      ],
      historySessions: [
        ...(workspace.historySessions ?? []).filter((session) => session.kind !== "terminal"),
        ...(historySessions.get(workspace.id)?.values() ?? []),
      ],
    })),
  }));
}
