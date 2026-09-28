import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  selectRunningSubprocessTerminalIds,
  type KnownTerminalSession,
  type TerminalSessionState,
} from "@awen/client-runtime/state/terminal";
import {
  WorkspaceId,
  type EnvironmentId,
  type TerminalAttachInput,
  type TerminalSummary,
} from "@awen/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

const EMPTY_KNOWN_TERMINAL_SESSIONS = Object.freeze<ReadonlyArray<KnownTerminalSession>>([]);

interface TerminalMetadataIndex {
  readonly all: ReadonlyArray<TerminalSummary>;
  readonly byTerminalId: ReadonlyMap<string, TerminalSummary>;
  readonly byWorkspaceId: ReadonlyMap<string, ReadonlyArray<TerminalSummary>>;
  readonly views: Map<EnvironmentId, Map<string, ReadonlyArray<KnownTerminalSession>>>;
}

const metadataIndexes = new WeakMap<ReadonlyArray<TerminalSummary>, TerminalMetadataIndex>();
const sessionsBySummary = new WeakMap<TerminalSummary, Map<EnvironmentId, KnownTerminalSession>>();
const groupsByAnchor = new WeakMap<
  TerminalSummary,
  Map<EnvironmentId, WeakRef<ReadonlyArray<KnownTerminalSession>>>
>();

function knownSession(
  summary: TerminalSummary,
  environmentId: EnvironmentId,
): KnownTerminalSession {
  let byEnvironment = sessionsBySummary.get(summary);
  const previous = byEnvironment?.get(environmentId);
  if (previous) return previous;
  const session = {
    target: {
      environmentId,
      terminalId: summary.terminalId,
      ...(summary.workspaceId !== undefined
        ? { workspaceId: WorkspaceId.make(summary.workspaceId) }
        : {}),
    },
    state: combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
  };
  if (!byEnvironment) {
    byEnvironment = new Map();
    sessionsBySummary.set(summary, byEnvironment);
  }
  byEnvironment.set(environmentId, session);
  return session;
}

function terminalMetadataIndex(metadata: ReadonlyArray<TerminalSummary>): TerminalMetadataIndex {
  let index = metadataIndexes.get(metadata);
  if (!index) {
    const compare = new Intl.Collator(undefined, { numeric: true }).compare;
    const all = metadata.toSorted((left, right) => compare(left.terminalId, right.terminalId));
    const byTerminalId = new Map<string, TerminalSummary>();
    const byWorkspaceId = new Map<string, TerminalSummary[]>();
    for (const summary of all) {
      byTerminalId.set(summary.terminalId, summary);
      if (summary.workspaceId !== undefined) {
        const group = byWorkspaceId.get(summary.workspaceId);
        if (group) group.push(summary);
        else byWorkspaceId.set(summary.workspaceId, [summary]);
      }
    }
    index = { all, byTerminalId, byWorkspaceId, views: new Map() };
    metadataIndexes.set(metadata, index);
  }
  return index;
}

/**
 * Select the Terminal Sessions assigned to one Workspace in a stable order.
 *
 * Unassigned terminals are not part of a Workspace subtree; callers that own a
 * specific terminal address it directly by its stable id instead.
 */
export function selectKnownTerminalSessions(
  metadata: ReadonlyArray<TerminalSummary> | null,
  environmentId: EnvironmentId | null,
  workspaceId: WorkspaceId | null,
): ReadonlyArray<KnownTerminalSession> {
  if (environmentId === null || metadata === null || workspaceId === null) {
    return EMPTY_KNOWN_TERMINAL_SESSIONS;
  }
  const index = terminalMetadataIndex(metadata);
  let views = index.views.get(environmentId);
  const selectorKey = `workspace:${workspaceId}`;
  const cached = views?.get(selectorKey);
  if (cached) return cached;
  const summaries = index.byWorkspaceId.get(workspaceId);
  if (!summaries || summaries.length === 0) return EMPTY_KNOWN_TERMINAL_SESSIONS;

  const anchor = summaries[0]!;
  const previous = groupsByAnchor.get(anchor)?.get(environmentId)?.deref();
  const sessions =
    previous?.length === summaries.length &&
    previous.every((session, index) => session.state.summary === summaries[index])
      ? previous
      : summaries.map((summary) => knownSession(summary, environmentId));
  if (sessions !== previous) {
    const groups = groupsByAnchor.get(anchor) ?? new Map();
    groups.set(environmentId, new WeakRef(sessions));
    groupsByAnchor.set(anchor, groups);
  }
  if (!views) {
    views = new Map();
    index.views.set(environmentId, views);
  }
  views.set(selectorKey, sessions);
  return sessions;
}

export function useAttachedTerminalSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminal: TerminalAttachInput | null;
}): TerminalSessionState {
  const attach = useEnvironmentQuery(
    input.environmentId !== null && input.terminal !== null
      ? terminalEnvironment.attach({
          environmentId: input.environmentId,
          input: input.terminal,
        })
      : null,
  );
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );

  return useMemo(() => {
    if (input.environmentId === null || input.terminal === null) {
      return EMPTY_TERMINAL_SESSION_STATE;
    }
    const index = metadata.data === null ? null : terminalMetadataIndex(metadata.data);
    const summary =
      index === null ? null : (index.byTerminalId.get(input.terminal.terminalId) ?? null);
    const state = combineTerminalSessionState(summary, attach.data ?? EMPTY_TERMINAL_BUFFER_STATE);
    return attach.error === null ? state : { ...state, error: attach.error, status: "error" };
  }, [attach.data, attach.error, input.environmentId, input.terminal, metadata.data]);
}

/** Read one terminal's metadata by its stable identity, regardless of assignment. */
export function useTerminalSessionSummary(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminalId: string | null;
}): TerminalSummary | null {
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );
  return useMemo(() => {
    if (input.environmentId === null || input.terminalId === null || metadata.data === null) {
      return null;
    }
    return terminalMetadataIndex(metadata.data).byTerminalId.get(input.terminalId) ?? null;
  }, [input.environmentId, input.terminalId, metadata.data]);
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly workspaceId?: WorkspaceId | null;
}): ReadonlyArray<KnownTerminalSession> {
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );
  return useMemo(
    () =>
      selectKnownTerminalSessions(metadata.data, input.environmentId, input.workspaceId ?? null),
    [input.environmentId, input.workspaceId, metadata.data],
  );
}

export function useWorkspaceRunningTerminalIds(input: {
  readonly environmentId: EnvironmentId | null;
  readonly workspaceId?: WorkspaceId | null;
}): ReadonlyArray<string> {
  const sessions = useKnownTerminalSessions(input);
  return useMemo(() => selectRunningSubprocessTerminalIds(sessions), [sessions]);
}
