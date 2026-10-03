/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for terminal Sessions identified by a stable, client-chosen id.
 * A terminal's Workspace is a nullable, mutable assignment and is never a
 * lookup key.
 *
 * @module TerminalManager
 */
import {
  TerminalSessionId,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWorkspaceNotFoundError,
  TerminalWorkspaceResolutionUnavailableError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRenameInput,
  type TerminalResizeInput,
  type ResourceMonitorProcessTableEntry,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
  WorkspaceId,
} from "@awen/contracts";
import { makeKeyedCoalescingWorker } from "@awen/shared/KeyedCoalescingWorker";
import { HostProcessPlatform } from "@awen/shared/hostProcess";
import { getTerminalLabel } from "@awen/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import {
  makeTerminalDirectoryObserver,
  resolveWorkspaceAssignmentForDirectory,
  type RegisteredWorkspaceDirectory,
  type TerminalDirectoryObservation,
  type TerminalDirectoryObserver,
} from "./DirectoryObservation.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWorkspaceNotFoundError,
  TerminalWorkspaceResolutionUnavailableError,
  TerminalWriteError,
};

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_HISTORY_CHUNK_LENGTH = 16 * 1024;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DIRECTORY_POLL_INTERVAL_MS = 1_000;
const MAX_SUBPROCESS_POLL_INTERVAL_MS = 60_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_TERMINAL_LABEL_LENGTH = 128;
const MAX_PENDING_TERMINAL_TITLE_SEQUENCE = 8_192;
/**
 * How much terminal output one attached client may fall behind while it is
 * still receiving its first snapshot. Past this the drop is covered by a fresh
 * snapshot instead of an ever-growing handshake buffer.
 */
const MAX_PENDING_ATTACH_EVENTS = 256;
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

class TerminalSubprocessCheckError extends Schema.TaggedError<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps", "resource-monitor"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const details = [
      this.exitCode !== undefined && this.exitCode !== null ? `exit code ${this.exitCode}` : null,
      this.timedOut ? "timed out" : null,
      this.stdoutTruncated ? "output truncated" : null,
    ]
      .filter((detail) => detail !== null)
      .join(", ");
    return `Failed to inspect terminal subprocesses with ${this.command}${details.length > 0 ? ` (${details})` : ""}`;
  }
}

/** The projection read that maps observed directories to Workspaces failed. */
export class TerminalDirectoryRegistryError extends Schema.TaggedError<TerminalDirectoryRegistryError>()(
  "TerminalDirectoryRegistryError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to read registered Workspace directories for terminal assignment";
  }
}

class TerminalProcessSignalError extends Schema.TaggedError<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    /**
     * Open or attach to a terminal session.
     *
     * Reuses an existing session for the same stable terminal id and restores
     * persisted history on first open.
     */
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Attach to a terminal and stream its initial snapshot followed by live events.
     *
     * Returns an unsubscribe function.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;

    /**
     * Write input bytes to a terminal session.
     */
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    /**
     * Resize the PTY backing a terminal session.
     */
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    /**
     * Clear terminal output history.
     */
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /** Persist a user-chosen title and stop following terminal-provided titles. */
    readonly rename: (input: TerminalRenameInput) => Effect.Effect<TerminalSummary, TerminalError>;

    /**
     * Restart a terminal session in place.
     *
     * Durable history is retained across a restart.
     */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Close an active terminal session.
     *
     * Addresses exactly one terminal by its stable id.
     */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    /**
     * Read the live directory occupancy evidence for every Session.
     *
     * This is the separate check destructive Workspace deletion uses instead of
     * trusting the Sidebar assignment. A running Session reports its last
     * reliably observed working directory (or null when never observed), plus
     * its current assignment, launch directory, and host observation support.
     */
    readonly getDirectoryOccupancy: () => Effect.Effect<ReadonlyArray<TerminalDirectoryOccupancy>>;

    /**
     * Clear the assignment of every Session currently assigned to one Workspace.
     *
     * Called after a Workspace registration is removed: a still-running
     * terminal keeps its PTY and identity but becomes unassigned instead of
     * pointing at a Workspace that no longer exists.
     */
    readonly releaseWorkspaceAssignment: (workspaceId: string) => Effect.Effect<void>;

    /**
     * Subscribe to terminal runtime events with a direct callback.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /** Read the persisted Session metadata, including stopped runtimes. */
    readonly getMetadata: () => Effect.Effect<ReadonlyArray<TerminalSummary>>;

    /**
     * Subscribe to lightweight terminal metadata with an initial full snapshot.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("@awen/server/terminal/Manager/TerminalManager") {}

interface TerminalSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
}

interface TerminalSubprocessInspector {
  (
    terminalPid: number,
  ): Effect.Effect<TerminalSubprocessInspectResult, TerminalSubprocessCheckError>;
}

/**
 * One Session's contribution to the destructive-deletion occupancy check.
 *
 * `observedDirectory` is the last reliably observed working directory, or null
 * when the host never reported one. `workspaceId` is the last confirmed
 * assignment, which stands in when observation is unavailable. Neither is a
 * permanent lock: when the Session stops or observation confirms it left, the
 * workspace becomes deletable again.
 */
export interface TerminalDirectoryOccupancy {
  readonly terminalId: string;
  readonly workspaceId?: string;
  readonly status: TerminalSessionStatus;
  readonly launchCwd: string;
  readonly observedDirectory: string | null;
  readonly directoryObservationSupported: boolean;
  /** Fresh descendant cwd evidence; never used to assign the Sidebar row. */
  readonly processDirectories: ReadonlyArray<string>;
  /** A live process or the process table could not be inspected safely. */
  readonly hasUnobservedProcesses: boolean;
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyAdapter.PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        ...ownerEventFields(session),
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  readonly cwd: string;
  cols: number;
  rows: number;
}

interface TerminalSessionState {
  /** Stable terminal identity; also the storage and lock key. */
  terminalId: string;
  /** Current, mutable Workspace assignment. Null when unassigned. */
  workspaceId: string | null;
  /** Stable default title assigned from Workspace creation order. */
  defaultTitle: string;
  /** Current display title. Manual titles win over terminal-provided titles. */
  title: string;
  titleSource: "default" | "terminal" | "manual";
  /** Incremental OSC parser state for terminal-provided titles. */
  pendingTitleSequence: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: BoundedTerminalHistory;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  createdAt: string;
  updatedAt: string;
  eventSequence: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** Increments for every newly spawned PTY generation. */
  generation: number;
  /** Normalized child command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  /**
   * Last reliably observed working directory of this Session, or null when the
   * host never confirmed one. Observation never changes launch context; it only
   * projects the Sidebar assignment.
   */
  observedDirectory: string | null;
  runtimeEnv: Record<string, string> | null;
}

interface PersistHistoryRequest {
  history: BoundedTerminalHistory;
  immediate: boolean;
}

type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "title"; title: string }
  | { type: "exit"; event: PtyAdapter.PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      workspaceId?: string;
      terminalId: string;
      sequence: number;
      history: BoundedTerminalHistory | null;
      data: string;
    }
  | {
      type: "title";
      workspaceId?: string;
      terminalId: string;
      sequence: number;
      title: string;
    }
  | {
      type: "exit";
      process: PtyAdapter.PtyProcess | null;
      workspaceId?: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyAdapter.PtyProcess, Fiber.Fiber<void, never>>;
  deletedSessionKeys?: Set<string>;
}

function truncateTerminalWireLabel(value: string): string {
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value;
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH);
}

const RUNTIME_LAUNCHERS = new Set(["node", "bun", "deno", "python", "python3", "npx"]);

export function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  const tokens: string[] = [];
  const tokenRegex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(trimmed)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }

  const firstToken = tokens[0]?.trim();
  if (!firstToken || firstToken.length === 0) return null;
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  const base = firstToken.split(separators).at(-1) ?? firstToken;
  const withoutExe =
    platform === "win32" && base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  if (withoutExe.length === 0) return null;

  if (RUNTIME_LAUNCHERS.has(withoutExe.toLowerCase())) {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i]!.trim();
      if (token.startsWith("-") || (platform === "win32" && /^\/[a-zA-Z0-9?]+$/.test(token))) {
        continue;
      }
      const tokenBase = token
        .replace(/^['"]|['"]$/g, "")
        .split(separators)
        .at(-1);
      if (tokenBase) {
        const tokenWithoutExt =
          platform === "win32" && tokenBase.toLowerCase().endsWith(".exe")
            ? tokenBase.slice(0, -4)
            : tokenBase.replace(/\.(?:[cm]?[jt]sx?|py)$/i, "");
        if (tokenWithoutExt.length > 0) {
          return tokenWithoutExt;
        }
      }
    }
  }

  return withoutExe;
}

function terminalWireLabel(session: TerminalSessionState): string {
  if (session.hasRunningSubprocess && session.childCommandLabel) {
    const trimmed = session.childCommandLabel.trim();
    if (trimmed.length > 0) {
      return truncateTerminalWireLabel(trimmed);
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId));
}

/**
 * The stable identity fields every terminal wire value shares. The Workspace is
 * the current, nullable assignment; it is never part of the identity.
 */
function terminalIdentityFields(
  terminalId: string,
  workspaceId: string | null,
): {
  readonly terminalId: string;
  readonly sessionId: TerminalSessionId;
  readonly kind: "terminal";
  readonly workspaceId?: string;
} {
  return {
    terminalId,
    sessionId: TerminalSessionId.make(terminalId),
    kind: "terminal",
    ...(workspaceId !== null ? { workspaceId } : {}),
  };
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    ...terminalIdentityFields(session.terminalId, session.workspaceId),
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history.value(),
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    title: terminalDisplayTitle(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
    generation: session.generation,
  };
}

function summary(session: TerminalSessionState): TerminalSummary {
  return {
    ...terminalIdentityFields(session.terminalId, session.workspaceId),
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: terminalWireLabel(session),
    title: terminalDisplayTitle(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    generation: session.generation,
  };
}

function ownerEventFields(session: Pick<TerminalSessionState, "workspaceId">) {
  return session.workspaceId !== null ? { workspaceId: session.workspaceId } : {};
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "renamed":
      return true;
    case "assigned":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
    case "renamed":
      return null;
    case "assigned":
      return null;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
) {
  return typeof event.sequence === "number" && typeof initialSnapshot.sequence === "number"
    ? event.sequence <= initialSnapshot.sequence
    : event.type === "started" &&
        event.snapshot.workspaceId === initialSnapshot.workspaceId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt;
}

function advanceEventSequence(session: TerminalSessionState): {
  readonly updatedAt: string;
  readonly sequence: number;
} {
  const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  session.eventSequence += 1;
  session.updatedAt = updatedAt;
  return { updatedAt, sequence: session.eventSequence };
}

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtyAdapter.PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly commandById: ReadonlyMap<number, string>;
}

export function subprocessSnapshotPollDelayMs(
  pollIntervalMs: number,
  failureCount: number,
): number {
  return Math.min(pollIntervalMs * 2 ** failureCount, MAX_SUBPROCESS_POLL_INTERVAL_MS);
}

function parsePosixProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    // `comm=` is the final column and may itself contain spaces, so only the
    // first two tokens are structural.
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, (match[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function processTableSnapshotFromProcesses(
  processes: ReadonlyArray<ResourceMonitorProcessTableEntry>,
): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const process of processes) {
    const { pid, ppid: parentPid, name } = process;
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    commandById.set(pid, name.trim());
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent, commandById };
}

const TRANSPARENT_WRAPPERS = new Set([
  "conhost",
  "openconsole",
  "cmd",
  "powershell",
  "pwsh",
  "wsl",
  "wslhost",
  "sh",
  "bash",
  "zsh",
  "dash",
]);

const KNOWN_AGENT_COMMANDS = new Set(["codex", "claude", "claude-code", "opencode", "cursor"]);

export function deriveSubprocessInspectResult(
  snapshot: TerminalProcessTableSnapshot,
  terminalPid: number,
  platform: NodeJS.Platform,
): TerminalSubprocessInspectResult {
  const directChildren = snapshot.childrenByParent.get(terminalPid) ?? [];
  if (directChildren.length === 0) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }

  const processIds = new Set<number>([terminalPid]);
  const descendantPids: number[] = [];
  const queue = [terminalPid];

  while (queue.length > 0) {
    const parentPid = queue.shift();
    if (parentPid === undefined) continue;
    for (const pid of snapshot.childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(pid)) continue;
      processIds.add(pid);
      descendantPids.push(pid);
      queue.push(pid);
    }
  }

  // Filter out pure console infrastructure processes like conhost from marking running activity
  const substantiveDescendants = descendantPids.filter((pid) => {
    const rawCmd = snapshot.commandById.get(pid) ?? "";
    const name = normalizeChildCommandName(rawCmd, platform);
    return name !== "conhost" && name !== "openconsole";
  });

  if (substantiveDescendants.length === 0) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [...processIds] };
  }

  // Look for any descendant running a known agent command first
  let chosenCommand: string | null = null;
  for (const pid of substantiveDescendants) {
    const rawCmd = snapshot.commandById.get(pid) ?? "";
    const name = normalizeChildCommandName(rawCmd, platform);
    if (name && KNOWN_AGENT_COMMANDS.has(name.toLowerCase())) {
      chosenCommand = name;
      break;
    }
  }

  // If no known agent found, choose the first non-wrapper descendant, or fallback to the direct child
  if (!chosenCommand) {
    for (const pid of substantiveDescendants) {
      const rawCmd = snapshot.commandById.get(pid) ?? "";
      const name = normalizeChildCommandName(rawCmd, platform);
      if (name && !TRANSPARENT_WRAPPERS.has(name.toLowerCase())) {
        chosenCommand = name;
        break;
      }
    }
  }

  if (!chosenCommand && substantiveDescendants.length > 0) {
    const firstSubstantive = substantiveDescendants[0]!;
    const rawCmd = snapshot.commandById.get(firstSubstantive) ?? "";
    chosenCommand = normalizeChildCommandName(rawCmd, platform);
  }

  return {
    hasRunningSubprocess: true,
    childCommand: chosenCommand ? truncateTerminalWireLabel(chosenCommand) : null,
    processIds: [...processIds],
  };
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

// Resolve `ps` to an absolute path once at startup. Spawning by bare name
// walks every PATH entry per spawn (one failed posix_spawn per directory
// until the hit), which is measurable at a 1s poll cadence on long PATHs.
const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

const posixProcessTableSnapshot = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  psCommand: string,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: psCommand,
      args: ["-eo", "pid=,ppid=,args="],
      timeout: "1 second",
      maxOutputBytes: 524_288,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    // Not authoritative: an empty or partial table would mark every terminal
    // idle and clear its registered process ids. Failing skips the tick.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});

const windowsProcessTableSnapshot = Effect.fn("terminal.windowsProcessTableSnapshot")(
  function* (): Effect.fn.Return<
    TerminalProcessTableSnapshot,
    TerminalSubprocessCheckError,
    ProcessRunner.ProcessRunner
  > {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const command =
      'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $cmd = if ($_.CommandLine) { $_.CommandLine.Trim() } else { $_.Name }; Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$cmd" }';
    const result = yield* processRunner
      .run({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        timeout: "1500 millis",
        maxOutputBytes: 262_144,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) => new TerminalSubprocessCheckError({ cause, command: "powershell" }),
        ),
      );
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      return yield* new TerminalSubprocessCheckError({
        command: "powershell",
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
      });
    }
    const processes = result.stdout.split(/\r?\n/g).flatMap((line) => {
      const parts = line.trim().split("|");
      if (parts.length < 3) return [];
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const name = parts.slice(2).join("|").trim();
      return Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid)
        ? [{ pid, ppid, name }]
        : [];
    });
    return processTableSnapshotFromProcesses(processes);
  },
);

interface TerminalHistoryChunk {
  data: string;
  byteLength: number;
  lineBreaks: number;
}

export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private chunks: Array<TerminalHistoryChunk | undefined> = [];
  private start = 0;
  private byteLength = 0;
  private lineBreaks = 0;
  // Reading the old string's tail on each append can force chunk concatenation.
  private lastCodeUnit: number | undefined;
  private cachedValue: string | null = "";

  constructor(maxLines: number, initial: string, maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.append(initial);
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.cachedValue = null;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clear();
      // Preserve the existing zero-line limit's trailing newline behavior.
      if (this.maxBytes > 0 && text.endsWith("\n")) this.appendChunk("\n");
      return;
    }

    let offset = 0;
    const previous = this.chunks.at(-1);
    const lastCode = this.lastCodeUnit;
    const firstCode = text.charCodeAt(0);
    if (
      previous &&
      lastCode !== undefined &&
      lastCode >= 0xd800 &&
      lastCode <= 0xdbff &&
      firstCode >= 0xdc00 &&
      firstCode <= 0xdfff
    ) {
      // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes.
      previous.data += text[0];
      previous.byteLength += 1;
      this.byteLength += 1;
      this.lastCodeUnit = firstCode;
      offset = 1;
      this.trim();
    }

    while (offset < text.length) {
      let end = Math.min(offset + MAX_HISTORY_CHUNK_LENGTH, text.length);
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      const data = text.slice(offset, end);
      // Detach small chunks from large input strings so evicted prefixes can be collected.
      this.appendChunk(
        text.length > MAX_HISTORY_CHUNK_LENGTH
          ? Buffer.from(data, "utf16le").toString("utf16le")
          : data,
      );
      this.trim();
      offset = end;
    }
  }

  private appendChunk(data: string): void {
    const byteLength = Buffer.byteLength(data);
    let lineBreaks = 0;
    for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
      lineBreaks += 1;
    }
    const previous = this.chunks.at(-1);
    if (previous && previous.data.length + data.length <= MAX_HISTORY_CHUNK_LENGTH) {
      previous.data += data;
      previous.byteLength += byteLength;
      previous.lineBreaks += lineBreaks;
    } else {
      this.chunks.push({ data, byteLength, lineBreaks });
    }
    this.byteLength += byteLength;
    this.lineBreaks += lineBreaks;
    this.lastCodeUnit = data.charCodeAt(data.length - 1);
    this.cachedValue = null;
  }

  private discardChunk(): void {
    const first = this.chunks[this.start]!;
    this.byteLength -= first.byteLength;
    this.lineBreaks -= first.lineBreaks;
    this.chunks[this.start++] = undefined;
  }

  private trimChunk(offset: number, byteLength: number, lineBreaks: number): void {
    const first = this.chunks[this.start]!;
    if (offset === first.data.length) {
      this.discardChunk();
      return;
    }
    first.data = first.data.slice(offset);
    first.byteLength -= byteLength;
    first.lineBreaks -= lineBreaks;
    this.byteLength -= byteLength;
    this.lineBreaks -= lineBreaks;
  }

  private trim(): void {
    const trailingNewline = this.lastCodeUnit === 10;
    let linesToDrop = this.lineBreaks + (trailingNewline ? 0 : 1) - this.maxLines;
    while (linesToDrop > 0) {
      const first = this.chunks[this.start]!;
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardChunk();
        continue;
      }
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = first.data.indexOf("\n", offset) + 1;
      }
      this.trimChunk(offset, Buffer.byteLength(first.data.slice(0, offset)), linesToDrop);
      linesToDrop = 0;
    }

    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[this.start]!;
      const bytesToDrop = this.byteLength - this.maxBytes;
      if (first.byteLength <= bytesToDrop) {
        this.discardChunk();
        continue;
      }
      if (first.byteLength === first.data.length && first.lineBreaks === 0) {
        // ASCII without newlines needs no scan to find the byte cutoff.
        this.trimChunk(bytesToDrop, bytesToDrop, 0);
        continue;
      }
      let offset = 0;
      let bytes = 0;
      let lineBreaks = 0;
      // Scan only the discarded prefix of one small chunk, never all history.
      while (bytes < bytesToDrop) {
        const codePoint = first.data.codePointAt(offset)!;
        bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        offset += codePoint <= 0xffff ? 1 : 2;
        if (codePoint === 10) lineBreaks += 1;
      }
      this.trimChunk(offset, bytes, lineBreaks);
    }
    if (
      this.start === this.chunks.length ||
      (this.start > 2_048 && this.start * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
      if (this.chunks.length === 0) this.lastCodeUnit = undefined;
    }
  }

  clear(): void {
    this.chunks = [];
    this.start = 0;
    this.byteLength = 0;
    this.lineBreaks = 0;
    this.lastCodeUnit = undefined;
    this.cachedValue = "";
  }

  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    this.cachedValue = this.chunks
      .slice(this.start)
      .map((chunk) => chunk!.data)
      .join("");
    return this.cachedValue;
  }
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function terminalDisplayTitle(
  session: Pick<TerminalSessionState, "defaultTitle" | "title">,
): string {
  return session.title.trim() || session.defaultTitle;
}

function nextDefaultTerminalTitle(
  sessions: Iterable<{ readonly workspaceId?: string | null; readonly defaultTitle?: string }>,
  workspaceId: string | null,
): string {
  let highest = 0;
  for (const session of sessions) {
    if ((session.workspaceId ?? null) !== workspaceId) continue;
    const match = /^Terminal ([1-9][0-9]*)$/.exec(session.defaultTitle ?? "");
    if (match === null) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  return `Terminal ${highest + 1}`;
}

function restoredTerminalTitles(
  records: ReadonlyArray<PersistedTerminalSessionRecord>,
): ReadonlyMap<
  string,
  { defaultTitle: string; title: string; titleSource: "default" | "terminal" | "manual" }
> {
  const groups = new Map<string, PersistedTerminalSessionRecord[]>();
  for (const record of records) {
    const groupKey = record.workspaceId ?? "";
    const group = groups.get(groupKey);
    if (group) group.push(record);
    else groups.set(groupKey, [record]);
  }

  const result = new Map<
    string,
    { defaultTitle: string; title: string; titleSource: "default" | "terminal" | "manual" }
  >();
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) =>
        (left.createdAt ?? left.updatedAt).localeCompare(right.createdAt ?? right.updatedAt) ||
        left.terminalId.localeCompare(right.terminalId),
    );
    let highest = 0;
    for (const record of ordered) {
      const match = /^Terminal ([1-9][0-9]*)$/.exec(record.defaultTitle ?? "");
      if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
    for (const record of ordered) {
      const defaultTitle = record.defaultTitle?.trim() || `Terminal ${highest + 1}`;
      if (!record.defaultTitle?.trim()) highest += 1;
      const titleSource = record.titleSource ?? (record.title ? "manual" : "default");
      const manualTitle = titleSource === "manual" ? record.title?.trim() : undefined;
      const terminalTitle = titleSource === "terminal" ? record.title?.trim() : undefined;
      result.set(toSessionKey(record.terminalId), {
        defaultTitle,
        title: manualTitle || terminalTitle || defaultTitle,
        titleSource: manualTitle ? "manual" : terminalTitle ? "terminal" : "default",
      });
    }
  }
  return result;
}

function parseTerminalTitleUpdates(
  pending: string,
  data: string,
): { readonly pending: string; readonly title: string | null } {
  const input = `${pending}${data}`;
  let cursor = 0;
  let title: string | null = null;

  while (cursor < input.length) {
    const escapeOsc = input.indexOf("\u001b]", cursor);
    const c1Osc = input.indexOf("\u009d", cursor);
    const osc = escapeOsc < 0 ? c1Osc : c1Osc < 0 ? escapeOsc : Math.min(escapeOsc, c1Osc);
    if (osc < 0) {
      return {
        pending: input.endsWith("\u001b") ? "\u001b" : "",
        title,
      };
    }

    const contentStart = input.charCodeAt(osc) === 0x9d ? osc + 1 : osc + 2;
    const terminator = findStringTerminatorIndex(input, contentStart);
    if (terminator === null) {
      return {
        pending: input.slice(osc).slice(-MAX_PENDING_TERMINAL_TITLE_SEQUENCE),
        title,
      };
    }

    const content = stripStringTerminator(input.slice(contentStart, terminator));
    const separator = content.indexOf(";");
    const command = separator < 0 ? content : content.slice(0, separator);
    if (separator >= 0 && (command === "0" || command === "1" || command === "2")) {
      title = truncateTerminalWireLabel(content.slice(separator + 1).trim());
    }
    cursor = terminator;
  }

  return { pending: "", title };
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(terminalId: string): string {
  return terminalId;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("AWEN_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

// Marker variables the AppImage runtime injects into the process it launches.
// They describe the AppImage itself, not the user's session, so terminals must
// not inherit them.
const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// Colon-separated search-path variables the AppImage runtime points at its
// temporary mount (e.g. /tmp/.mount_Awen-XXXX/usr/bin, the bundled glib schemas,
// and an $APPDIR/usr/share XDG data entry). Only the mount segments are
// dropped; the user's real entries are preserved. When nothing but mount
// segments remain the variable is removed entirely so consumers fall back to
// their platform default (e.g. gsettings finds the host schemas instead of
// reporting "No schemas installed"). See issues #1699 and #5059.
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// On Linux AppImage builds the runtime mounts the app under a temporary dir and
// injects APPIMAGE/APPDIR/ARGV0/OWD plus mount entries on PATH/LD_LIBRARY_PATH.
// The integrated terminal inherits the server process environment, so without
// this scrub those leak into the PTY and tools resolve against the AppImage
// mount instead of the user's real environment (e.g. `php` reporting
// PHP_BINARY as the AppImage path). See issue #1699. The scrub is gated on an
// actual AppImage launch so non-AppImage environments are left untouched.
function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    // The daemon cannot know the renderer's appearance, so an inherited
    // COLORFGBG only ever guesses at a theme it does not control — the stale
    // light-background value that made CLIs paint black text on a dark pane.
    // The renderer answers OSC 10/11/12 from its real theme instead.
    if (key === "COLORFGBG") continue;
    spawnEnv[key] = value;
  }
  // A child of this PTY talks to the renderer, not to the terminal the daemon
  // itself was launched from, so its identity is ours to declare. An explicit
  // per-session value from the client still wins, because the overrides are
  // applied below.
  spawnEnv.TERM = "xterm-256color";
  spawnEnv.TERM_PROGRAM = "awen";
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] =
        key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR" ? expandHomePath(value) : value;
    }
  }
  // Both PTY backends feed truecolor-capable terminal clients.
  if (spawnEnv.COLORTERM === undefined || spawnEnv.COLORTERM === "") {
    spawnEnv.COLORTERM = "truecolor";
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  historyByteLimit?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: TerminalSubprocessInspector;
  /**
   * Resolves a PTY process's real working directory. Defaults to the current
   * host's observer (see DirectoryObservation.ts); tests and other platforms
   * inject a deterministic one.
   */
  directoryObserver?: TerminalDirectoryObserver;
  /**
   * Lists the Workspace directories this Environment has already registered.
   *
   * A reliable shell directory maps to the nearest registered ancestor without
   * implicitly registering a Project. Absent in tests that do not exercise
   * assignment following.
   */
  listRegisteredWorkspaceDirectories?: () => Effect.Effect<
    ReadonlyArray<RegisteredWorkspaceDirectory>,
    TerminalDirectoryRegistryError
  >;
  processTable?: Effect.Effect<
    ReadonlyArray<ResourceMonitorProcessTableEntry>,
    TerminalSubprocessCheckError
  >;
  subprocessPollIntervalMs?: number;
  /**
   * How often to observe each running shell's working directory. Independent of
   * subprocess polling so its backoff cannot delay Sidebar reassignment.
   */
  directoryPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  registerTerminalProcesses?: (input: {
    readonly workspaceId?: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  unregisterTerminal?: (input: {
    readonly workspaceId?: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  resolveProviderInstanceEnvironment?: (
    providerInstanceId: string,
    env: Record<string, string> | undefined,
  ) => Effect.Effect<
    Record<string, string>,
    TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
  >;
  /** Resolves the authoritative Workspace root for new Awen terminal opens. */
  resolveWorkspaceRoot?: (
    workspaceId: string,
  ) => Effect.Effect<string, TerminalWorkspaceNotFoundError>;
}

interface PersistedTerminalSessionRecord {
  readonly workspaceId?: string;
  readonly terminalId: string;
  readonly defaultTitle?: string;
  readonly title?: string;
  readonly titleSource?: "default" | "terminal" | "manual";
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly status: TerminalSessionStatus;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly createdAt?: string;
  readonly updatedAt: string;
  readonly eventSequence: number;
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
  readonly runtimeEnv: Record<string, string> | null;
}

const PersistedTerminalSessionRecordSchema = Schema.Struct({
  workspaceId: Schema.optional(Schema.String),
  terminalId: Schema.String,
  defaultTitle: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  titleSource: Schema.optional(Schema.Literals(["default", "terminal", "manual"])),
  cwd: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  status: TerminalSessionStatus,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.String,
  eventSequence: Schema.Int,
  generation: Schema.Int,
  cols: Schema.Int,
  rows: Schema.Int,
  runtimeEnv: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
});
const decodePersistedTerminalSessionIndex = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(PersistedTerminalSessionRecordSchema)),
);
const encodePersistedTerminalSessionIndex = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(PersistedTerminalSessionRecordSchema)),
);

function persistedTerminalSessionRecord(
  session: TerminalSessionState,
): PersistedTerminalSessionRecord {
  return {
    ...(session.workspaceId !== null ? { workspaceId: session.workspaceId } : {}),
    terminalId: session.terminalId,
    defaultTitle: session.defaultTitle,
    title: session.title,
    titleSource: session.titleSource,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    eventSequence: session.eventSequence,
    generation: session.generation,
    cols: session.cols,
    rows: session.rows,
    runtimeEnv: session.runtimeEnv,
  };
}

export const resolveProviderInstanceTerminalEnvironment = Effect.fn(
  "terminal.resolveProviderInstanceTerminalEnvironment",
)(function* (input: {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly path: Path.Path;
  readonly rawProviderInstanceId: string;
  readonly env: Record<string, string> | undefined;
}) {
  const providerInstanceId = ProviderInstanceId.make(input.rawProviderInstanceId);
  const settings = yield* input.serverSettings.getSettings.pipe(
    Effect.mapError((cause) => new TerminalProviderEnvironmentError({ providerInstanceId, cause })),
  );
  const instance = deriveProviderInstanceConfigMap(settings)[providerInstanceId];
  if (instance === undefined) {
    return yield* new TerminalProviderInstanceNotFoundError({ providerInstanceId });
  }

  let resolved = mergeProviderInstanceEnvironment(instance.environment, input.env ?? {});
  if (instance.driver === "codex") {
    const config = decodeCodexSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      const layout = yield* resolveCodexHomeLayout(config.value).pipe(
        Effect.provideService(Path.Path, input.path),
      );
      if (layout.effectiveHomePath)
        resolved = { ...resolved, CODEX_HOME: layout.effectiveHomePath };
    }
  } else if (instance.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      resolved = yield* makeClaudeEnvironment(config.value, resolved).pipe(
        Effect.provideService(Path.Path, input.path),
      );
    }
  }

  return Object.fromEntries(
    Object.entries(resolved).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const projectionQuery = yield* Effect.serviceOption(
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  );
  const resolveProviderInstanceEnvironment = Effect.fn(
    "terminal.resolveProviderInstanceEnvironment",
  )((rawProviderInstanceId: string, env: Record<string, string> | undefined) =>
    resolveProviderInstanceTerminalEnvironment({
      serverSettings,
      path,
      rawProviderInstanceId,
      env,
    }),
  );
  const workspaceResolver = Option.isSome(projectionQuery)
    ? projectionQuery.value.getAwenWorkspaceById
    : undefined;
  if (workspaceResolver === undefined) {
    yield* Effect.logWarning(
      "TerminalManager built without workspace-root resolution: workspace-owned terminal open/attach/restart will fail with TerminalWorkspaceResolutionUnavailableError. ProjectionSnapshotQuery is absent from the layer context or lacks getAwenWorkspaceById.",
    );
  }
  const listAwenProjects = Option.isSome(projectionQuery)
    ? projectionQuery.value.listAwenProjects
    : undefined;
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    processTable: nativeTelemetry.processTable.pipe(
      Effect.mapError(
        (cause) => new TerminalSubprocessCheckError({ cause, command: "resource-monitor" }),
      ),
    ),
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
    resolveProviderInstanceEnvironment,
    ...(workspaceResolver
      ? {
          resolveWorkspaceRoot: (workspaceId: string) =>
            workspaceResolver(WorkspaceId.make(workspaceId)).pipe(
              Effect.mapError(() => new TerminalWorkspaceNotFoundError({ workspaceId })),
              Effect.flatMap((workspace) =>
                Option.match(workspace, {
                  onNone: () => Effect.fail(new TerminalWorkspaceNotFoundError({ workspaceId })),
                  onSome: (value) => Effect.succeed(value.workspaceRoot),
                }),
              ),
            ),
        }
      : {}),
    ...(listAwenProjects
      ? {
          listRegisteredWorkspaceDirectories: () =>
            listAwenProjects().pipe(
              Effect.map((projects) =>
                projects.flatMap((project) =>
                  project.workspaces.map((workspace) => ({
                    workspaceId: workspace.id,
                    workspaceRoot: workspace.workspaceRoot,
                  })),
                ),
              ),
              Effect.mapError((cause) => new TerminalDirectoryRegistryError({ cause })),
            ),
        }
      : {}),
  });
});

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const logsDir = options.logsDir;
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
  const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
  const platform = yield* HostProcessPlatform;
  // Terminals must inherit the user's full environment (minus the blocklist
  // applied in createTerminalSpawnEnv) — an allowlist here silently strips
  // things like PSModulePath, DISPLAY, proxies, and toolchain variables.
  // `options.env` is the test seam.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const resolveWorkspaceCwd = <
    Input extends TerminalOpenInput | TerminalAttachInput | TerminalRestartInput,
  >(
    input: Input,
  ): Effect.Effect<
    Input & { readonly cwd: string },
    TerminalWorkspaceNotFoundError | TerminalWorkspaceResolutionUnavailableError
  > =>
    Effect.gen(function* () {
      if (input.workspaceId !== undefined) {
        const resolver = options.resolveWorkspaceRoot;
        if (resolver === undefined) {
          if (input.cwd !== undefined) {
            return input as Input & { readonly cwd: string };
          }
          // Distinct from "workspace not found": the manager was built without
          // workspace-root resolution, so NO workspace can ever resolve. The
          // construction-time warning in `make` explains why.
          return yield* new TerminalWorkspaceResolutionUnavailableError({
            workspaceId: WorkspaceId.make(input.workspaceId),
          });
        }
        const cwd = yield* resolver(input.workspaceId);
        // The Workspace is authoritative. A caller cannot redirect a new
        // terminal to an unrelated cwd by sending both fields.
        return { ...input, cwd } as Input & { readonly cwd: string };
      }
      if (input.cwd !== undefined) {
        return input as Input & { readonly cwd: string };
      }
      return yield* new TerminalWorkspaceNotFoundError({
        workspaceId: WorkspaceId.make("missing-workspace"),
      });
    });
  const resolveLaunchInputEnvironment = <
    Input extends TerminalOpenInput | TerminalAttachInput | TerminalRestartInput,
  >(
    input: Input,
  ): Effect.Effect<
    Input & { readonly cwd: string },
    | TerminalWorkspaceNotFoundError
    | TerminalWorkspaceResolutionUnavailableError
    | TerminalProviderInstanceNotFoundError
    | TerminalProviderEnvironmentError
  > =>
    Effect.gen(function* () {
      const workspaceResolved = yield* resolveWorkspaceCwd(input);
      if (workspaceResolved.providerInstanceId === undefined) return workspaceResolved;
      const resolver = options.resolveProviderInstanceEnvironment;
      if (resolver === undefined) {
        return yield* new TerminalProviderInstanceNotFoundError({
          providerInstanceId: ProviderInstanceId.make(workspaceResolved.providerInstanceId),
        });
      }
      const env = yield* resolver(workspaceResolved.providerInstanceId, workspaceResolved.env);
      return { ...workspaceResolved, env };
    });
  // One process-table snapshot per poll tick, shared across every terminal.
  // Per-terminal `pgrep`/`ps` calls multiply spawn load by terminal count and
  // can exhaust the PID space on hosts with many sessions (#6332).
  const fallbackProcessTableSnapshot = (
    platform === "win32"
      ? windowsProcessTableSnapshot()
      : posixProcessTableSnapshot(yield* resolvePosixPsCommand())
  ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
  const fetchProcessTableSnapshot: Effect.Effect<
    {
      readonly snapshot: TerminalProcessTableSnapshot;
      /**
       * False when the sidecar snapshot failed and this table came from the
       * spawned fallback. The data is still applied, but the tick counts as
       * a failure so polling backs off instead of hot-looping the fallback.
       */
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > = options.processTable
    ? options.processTable.pipe(
        Effect.map((entries) => ({
          snapshot: processTableSnapshotFromProcesses(entries),
          snapshotSucceeded: true,
        })),
        Effect.catch(() =>
          fallbackProcessTableSnapshot.pipe(
            Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: false })),
          ),
        ),
      )
    : fallbackProcessTableSnapshot.pipe(
        Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: true })),
      );
  const customSubprocessInspector = options.subprocessInspector;
  const acquireSubprocessInspector: Effect.Effect<
    {
      readonly inspector: TerminalSubprocessInspector;
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > =
    customSubprocessInspector !== undefined
      ? Effect.succeed({ inspector: customSubprocessInspector, snapshotSucceeded: true })
      : Effect.map(
          fetchProcessTableSnapshot,
          ({
            snapshot,
            snapshotSucceeded,
          }): {
            readonly inspector: TerminalSubprocessInspector;
            readonly snapshotSucceeded: boolean;
          } => ({
            inspector: (terminalPid) =>
              Effect.succeed(deriveSubprocessInspectResult(snapshot, terminalPid, platform)),
            snapshotSucceeded,
          }),
        );
  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
  const directoryPollIntervalMs =
    options.directoryPollIntervalMs ?? DEFAULT_DIRECTORY_POLL_INTERVAL_MS;
  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);
  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);
  // One observer for the host. Unsupported platforms always report `unknown`,
  // so assignment following is a no-op there rather than a guess.
  const directoryObserver =
    options.directoryObserver ??
    makeTerminalDirectoryObserver({ platform, fileSystem, processRunner });
  const directoryObservationSupported = directoryObserver.capability.supported;
  // macOS spawns lsof; cap busy-terminal probes at four per second.
  const directoryActivityWindowMs = directoryObserver.capability.mechanism === "lsof" ? 250 : 50;
  // A single wake-up covers a burst; the set retains every affected terminal.
  const directoryWakeups = yield* Effect.acquireRelease(Queue.sliding<void>(1), Queue.shutdown);
  const pendingDirectorySessions = new Set<string>();
  let refreshAllDirectories = false;
  const requestDirectoryObservation = (terminalId: string) => {
    if (!directoryObservationSupported) return;
    pendingDirectorySessions.add(terminalId);
    Queue.offerUnsafe(directoryWakeups, undefined);
  };

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    sessions: new Map(),
    killFibers: new Map(),
  });
  const terminalLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const publishEvent = (event: TerminalEvent) =>
    Effect.gen(function* () {
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const historyPath = (terminalId: string) =>
    path.join(logsDir, `${toSafeTerminalId(terminalId)}.log`);

  const sessionIndexPath = path.join(logsDir, "sessions.json");

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  function reconcileDiskTerminalRecords(
    diskRecords: ReadonlyArray<PersistedTerminalSessionRecord>,
    activeKeys: ReadonlySet<string>,
    deletedKeys: ReadonlySet<string>,
  ): ReadonlyArray<PersistedTerminalSessionRecord> {
    return diskRecords.filter((record) => {
      const key = toSessionKey(record.terminalId);
      return !activeKeys.has(key) && !deletedKeys.has(key);
    });
  }

  const sessionIndexWriteLock = yield* Semaphore.make(1);
  const persistSessionIndex: Effect.Effect<void, never, never> = sessionIndexWriteLock.withPermit(
    Effect.gen(function* () {
      const state = yield* readManagerState;
      const activeRecords = [...state.sessions.values()].map(persistedTerminalSessionRecord);
      const activeKeys = new Set(activeRecords.map((r) => toSessionKey(r.terminalId)));
      const deletedKeys = state.deletedSessionKeys ?? new Set<string>();

      const diskRecords = yield* readPersistedSessionIndex;
      const preservedDiskRecords = reconcileDiskTerminalRecords(
        diskRecords,
        activeKeys,
        deletedKeys,
      );

      const combined = [...activeRecords, ...preservedDiskRecords].sort((left, right) =>
        left.terminalId.localeCompare(right.terminalId),
      );

      yield* fileSystem
        .writeFileString(sessionIndexPath, encodePersistedTerminalSessionIndex(combined))
        .pipe(Effect.orElseSucceed(() => undefined));
    }),
  );

  const readPersistedSessionIndex: Effect.Effect<
    ReadonlyArray<PersistedTerminalSessionRecord>,
    never,
    never
  > = Effect.gen(function* () {
    const raw = yield* fileSystem
      .readFileString(sessionIndexPath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) return [] as ReadonlyArray<PersistedTerminalSessionRecord>;
    const decoded = decodePersistedTerminalSessionIndex(raw);
    return Option.isSome(decoded)
      ? (decoded.value as ReadonlyArray<PersistedTerminalSessionRecord>)
      : [];
  });

  const getTerminalSemaphore = (terminalId: string) =>
    SynchronizedRef.modifyEffect(terminalLocksRef, (current) => {
      const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
        current.get(terminalId),
      );
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(terminalId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  const withTerminalLock = <A, E, R>(
    terminalId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getTerminalSemaphore(terminalId), (semaphore) => semaphore.withPermit(effect));

  const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
    process: PtyAdapter.PtyProcess | null,
  ) {
    if (!process) return;
    const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
      Option.Option<Fiber.Fiber<void, never>>
    >((state) => {
      const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
        state.killFibers.get(process),
      );
      if (Option.isNone(existing)) {
        return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.delete(process);
      return [existing, { ...state, killFibers }] as const;
    });
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  });

  const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
    fiber: Fiber.Fiber<void, never>,
  ) {
    yield* modifyManagerState((state) => {
      const killFibers = new Map(state.killFibers);
      killFibers.set(process, fiber);
      return [undefined, { ...state, killFibers }] as const;
    });
  });

  const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    terminalId: string,
  ) {
    const terminated = yield* Effect.try({
      try: () => process.kill("SIGTERM"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          cause,
          signal: "SIGTERM",
          terminalPid: process.pid,
        }),
    }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("failed to kill terminal process", {
          terminalId,
          signal: "SIGTERM",
          cause: error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!terminated) {
      return;
    }

    yield* Effect.sleep(processKillGraceMs);

    yield* Effect.try({
      try: () => process.kill("SIGKILL"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          cause,
          signal: "SIGKILL",
          terminalPid: process.pid,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to force-kill terminal process", {
          terminalId,
          signal: "SIGKILL",
          cause: error,
        }),
      ),
    );
  });

  const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    terminalId: string,
  ) {
    const fiber = yield* runKillEscalation(process, terminalId).pipe(
      Effect.ensuring(
        modifyManagerState((state) => {
          if (!state.killFibers.has(process)) {
            return [undefined, state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [undefined, { ...state, killFibers }] as const;
        }),
      ),
      Effect.forkIn(workerScope),
    );

    yield* registerKillFiber(process, fiber);
  });

  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      if (sessionKey.length === 0) {
        return;
      }

      yield* fileSystem.writeFileString(historyPath(sessionKey), request.history.value()).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to persist terminal history", {
            terminalId: sessionKey,
            error,
          }),
        ),
      );
    }),
  }).pipe(Effect.provideService(Scope.Scope, workerScope));

  const queuePersist = Effect.fn("terminal.queuePersist")(function* (
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(terminalId), {
      history,
      immediate: false,
    });
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (terminalId: string) {
    yield* persistWorker.drainKey(toSessionKey(terminalId));
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    terminalId: string,
    history: BoundedTerminalHistory,
  ) {
    yield* persistWorker.enqueue(toSessionKey(terminalId), {
      history,
      immediate: true,
    });
    yield* flushPersist(terminalId);
  });

  const readHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (filePath: string) {
    const file = yield* fileSystem.open(filePath, { flag: "r" });
    const info = yield* file.stat;
    const limit = BigInt(historyByteLimit);
    const offset = info.size > limit ? info.size - limit : 0n;
    yield* file.seek(offset, "start");
    const bytes = new Uint8Array(Number(info.size - offset));
    let length = 0;
    while (length < bytes.length) {
      const read = Number(yield* file.read(bytes.subarray(length)));
      if (read === 0) break;
      length += read;
    }
    let start = 0;
    if (offset > 0n) {
      // A tail read can start inside a UTF-8 code point. Skip its remaining bytes.
      while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    }
    return {
      history: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, length)),
      truncated: offset > 0n,
    };
  });

  const readHistory = Effect.fn("terminal.readHistory")(function* (terminalId: string) {
    const nextPath = historyPath(terminalId);
    if (
      yield* fileSystem
        .exists(nextPath)
        .pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation: "read", terminalId, cause }),
          ),
        )
    ) {
      const { history: raw, truncated } = yield* readHistoryTail(nextPath).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) => new TerminalHistoryError({ operation: "read", terminalId, cause }),
        ),
      );
      const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
      const capped = history.value();
      if (truncated || capped !== raw) {
        yield* fileSystem
          .writeFileString(nextPath, capped)
          .pipe(
            Effect.mapError(
              (cause) => new TerminalHistoryError({ operation: "truncate", terminalId, cause }),
            ),
          );
      }
      return history;
    }

    return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
  });

  // The PTY itself is deliberately not restored after a daemon restart. The
  // durable Session identity and history are restored as exited so a client
  // can render the truthful state and an explicit open starts a new generation.
  const persistedSessions = yield* readPersistedSessionIndex;
  if (persistedSessions.length > 0) {
    const restored = new Map<string, TerminalSessionState>();
    const restoredTitles = restoredTerminalTitles(persistedSessions);
    for (const record of persistedSessions) {
      const history = yield* readHistory(record.terminalId).pipe(
        Effect.orElseSucceed(
          () => new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit),
        ),
      );
      const restoredTitle = restoredTitles.get(toSessionKey(record.terminalId));
      restored.set(toSessionKey(record.terminalId), {
        workspaceId: record.workspaceId ?? null,
        terminalId: record.terminalId,
        defaultTitle: restoredTitle?.defaultTitle ?? `Terminal ${restored.size + 1}`,
        title: restoredTitle?.title ?? restoredTitle?.defaultTitle ?? "Terminal",
        titleSource: restoredTitle?.titleSource ?? "default",
        pendingTitleSequence: "",
        cwd: record.cwd,
        worktreePath: record.worktreePath,
        status:
          record.status === "running" || record.status === "starting" ? "exited" : record.status,
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: record.exitCode,
        exitSignal: record.exitSignal,
        createdAt: record.createdAt ?? record.updatedAt,
        updatedAt: record.updatedAt,
        eventSequence: record.eventSequence,
        cols: record.cols,
        rows: record.rows,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        generation: record.generation,
        childCommandLabel: null,
        observedDirectory: null,
        runtimeEnv: record.runtimeEnv,
      });
    }
    yield* SynchronizedRef.set(managerStateRef, { sessions: restored, killFibers: new Map() });
    yield* persistSessionIndex;
  }

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (terminalId: string) {
    yield* fileSystem.remove(historyPath(terminalId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal history", {
          terminalId,
          error,
        }),
      ),
    );
  });

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    const state = yield* readManagerState;
    const key = toSessionKey(terminalId);
    const existing = state.sessions.get(key);
    if (existing) return Option.some(existing);
    if (state.deletedSessionKeys?.has(key)) return Option.none();

    const diskRecords = yield* readPersistedSessionIndex;
    const record = diskRecords.find((r) => r.terminalId === terminalId);
    if (!record) return Option.none();

    const history = yield* readHistory(record.terminalId).pipe(
      Effect.orElseSucceed(
        () => new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit),
      ),
    );
    const restoredTitle = restoredTerminalTitles(diskRecords).get(toSessionKey(record.terminalId));
    const restoredSession: TerminalSessionState = {
      workspaceId: record.workspaceId ?? null,
      terminalId: record.terminalId,
      defaultTitle: restoredTitle?.defaultTitle ?? "Terminal 1",
      title: restoredTitle?.title ?? restoredTitle?.defaultTitle ?? "Terminal 1",
      titleSource: restoredTitle?.titleSource ?? "default",
      pendingTitleSequence: "",
      cwd: record.cwd,
      worktreePath: record.worktreePath,
      status:
        record.status === "running" || record.status === "starting" ? "exited" : record.status,
      pid: null,
      history,
      pendingHistoryControlSequence: "",
      pendingProcessEvents: [],
      pendingProcessEventIndex: 0,
      processEventDrainRunning: false,
      exitCode: record.exitCode,
      exitSignal: record.exitSignal,
      createdAt: record.createdAt ?? record.updatedAt,
      updatedAt: record.updatedAt,
      eventSequence: record.eventSequence,
      cols: record.cols,
      rows: record.rows,
      process: null,
      unsubscribeData: null,
      unsubscribeExit: null,
      hasRunningSubprocess: false,
      generation: record.generation,
      childCommandLabel: null,
      observedDirectory: null,
      runtimeEnv: record.runtimeEnv,
    };

    yield* modifyManagerState((currentState) => {
      const sessions = new Map(currentState.sessions);
      sessions.set(key, restoredSession);
      return [undefined, { ...currentState, sessions }] as const;
    });

    return Option.some(restoredSession);
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(terminalId), (session) =>
      Option.match(session, {
        onNone: () => Effect.fail(new TerminalSessionLookupError({ terminalId })),
        onSome: Effect.succeed,
      }),
    );
  });

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      yield* modifyManagerState((state) => {
        const inactiveSessions = [...state.sessions.values()].filter(
          // Assigned Workspace Session metadata survives runtime retention limits.
          (session) => session.workspaceId === null && session.status !== "running",
        );
        if (inactiveSessions.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          sessions.delete(toSessionKey(session.terminalId));
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            nextEvent.data,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history.append(sanitized.visibleText);
          }
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            ...(session.workspaceId !== null ? { workspaceId: session.workspaceId } : {}),
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            history: sanitized.visibleText.length > 0 ? session.history : null,
            data: nextEvent.data,
          } as const;
        }

        if (nextEvent.type === "title") {
          if (session.titleSource !== "manual") {
            session.title = nextEvent.title;
            session.titleSource = "terminal";
          }
          const eventStamp = advanceEventSequence(session);
          return {
            type: "title",
            ...(session.workspaceId !== null ? { workspaceId: session.workspaceId } : {}),
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            title: terminalDisplayTitle(session),
          } as const;
        }

        const process = session.process;
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.pendingTitleSequence = "";
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return {
          type: "exit",
          process,
          ...(session.workspaceId !== null ? { workspaceId: session.workspaceId } : {}),
          terminalId: session.terminalId,
          sequence: eventStamp.sequence,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* queuePersist(action.terminalId, action.history);
        }

        yield* publishEvent({
          type: "output",
          ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}),
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        continue;
      }

      if (action.type === "title") {
        yield* persistSessionIndex;
        yield* publishEvent({
          type: "renamed",
          ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}),
          terminalId: action.terminalId,
          sequence: action.sequence,
          title: action.title,
        });
        continue;
      }

      yield* clearKillFiber(action.process);
      yield* unregisterTerminal({
        ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}),
        terminalId: action.terminalId,
      });
      yield* flushPersist(action.terminalId);
      yield* persistSessionIndex;
      yield* publishEvent({
        type: "exited",
        ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}),
        terminalId: action.terminalId,
        sequence: action.sequence,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* evictInactiveSessionsIfNeeded();
      return;
    }
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    const process = session.process;
    if (!process) return;

    const updatedAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.pendingTitleSequence = "";
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = updatedAt;
      return [undefined, state] as const;
    });
    yield* clearKillFiber(process);
    yield* unregisterTerminal({
      ...ownerEventFields(session),
      terminalId: session.terminalId,
    });
    yield* startKillEscalation(process, session.terminalId);
    yield* evictInactiveSessionsIfNeeded();
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* (
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    { process: PtyAdapter.PtyProcess; shellLabel: string },
    PtyAdapter.PtySpawnError
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: candidate.shell,
        ...(candidate.args ? { args: candidate.args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
  });

  const startSession = Effect.fn("terminal.startSession")(function* (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ) {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    const startingAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      // A new PTY generation has no confirmed directory yet.
      session.observedDirectory = null;
      session.pendingTitleSequence = "";
      session.generation += 1;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });
    yield* persistSessionIndex;

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = resolveShellCandidates(shellResolver, platform, baseEnv);
            const terminalEnv = createTerminalSpawnEnv(baseEnv, session.runtimeEnv);
            const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            const unsubscribeData = ptyProcess.onData((data) => {
              requestDirectoryObservation(session.terminalId);
              const scannedTitle = parseTerminalTitleUpdates(session.pendingTitleSequence, data);
              session.pendingTitleSequence = scannedTitle.pending;
              const nextTitle =
                scannedTitle.title === null ? null : scannedTitle.title || session.defaultTitle;
              const titleStartedDrain =
                nextTitle !== null &&
                session.titleSource !== "manual" &&
                enqueueProcessEvent(session, processPid, { type: "title", title: nextTitle });
              const outputStartedDrain = enqueueProcessEvent(session, processPid, {
                type: "output",
                data,
              });
              if (!titleStartedDrain && !outputStartedDrain) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
            });

            let eventStamp: ReturnType<typeof advanceEventSequence> = {
              updatedAt: session.updatedAt,
              sequence: session.eventSequence,
            };
            yield* modifyManagerState((state) => {
              session.process = ptyProcess;
              session.pid = processPid;
              session.status = "running";
              session.unsubscribeData = unsubscribeData;
              session.unsubscribeExit = unsubscribeExit;
              eventStamp = advanceEventSequence(session);
              return [undefined, state] as const;
            });

            yield* publishEvent({
              type: eventType,
              ...ownerEventFields(session),
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
              snapshot: snapshot(session),
            });
            yield* persistSessionIndex;
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      if (ptyProcess) {
        yield* startKillEscalation(ptyProcess, session.terminalId);
      }

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.pendingTitleSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      yield* unregisterTerminal({
        ...ownerEventFields(session),
        terminalId: session.terminalId,
      });

      yield* evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* publishEvent({
        type: "error",
        ...ownerEventFields(session),
        terminalId: session.terminalId,
        sequence: session.eventSequence,
        message,
      });
      yield* persistSessionIndex;
      yield* Effect.logError("failed to start terminal", {
        ...ownerEventFields(session),
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  });

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const key = toSessionKey(terminalId);
    const session = yield* getSession(terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;
    const closedFields = Option.isSome(session) ? ownerEventFields(session.value) : {};

    if (Option.isSome(session)) {
      yield* stopProcess(session.value);
      yield* unregisterTerminal({ ...ownerEventFields(session.value), terminalId });
      yield* persistHistory(terminalId, session.value.history);
    }

    yield* flushPersist(terminalId);
    const closedAt = yield* nowIso;

    if (!deleteHistoryOnClose) {
      // Retain the durable Session metadata as closed so a Pane or deep link
      // can reopen the same identity.
      const updated = yield* modifyManagerState((state) => {
        const existing = state.sessions.get(key);
        if (!existing) return [null, state] as const;
        const next: TerminalSessionState = {
          ...existing,
          status: "closed",
          pid: null,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          childCommandLabel: null,
          exitCode: existing.exitCode ?? 0,
          exitSignal: null,
          updatedAt: closedAt,
          eventSequence: closedEventSequence,
        };
        const sessions = new Map(state.sessions);
        sessions.set(key, next);
        return [next, { ...state, sessions }] as const;
      });

      if (updated) {
        yield* publishEvent({
          type: "closed",
          ...closedFields,
          terminalId,
          sequence: closedEventSequence,
        });
        yield* persistSessionIndex;
      }
      return;
    }

    const removed = yield* modifyManagerState((state) => {
      if (!state.sessions.has(key)) {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      const deletedKeys = new Set(state.deletedSessionKeys ?? []);
      deletedKeys.add(key);
      return [true, { ...state, sessions, deletedSessionKeys: deletedKeys }] as const;
    });

    if (removed) {
      yield* publishEvent({
        type: "closed",
        ...closedFields,
        terminalId,
        sequence: closedEventSequence,
      });
      yield* persistSessionIndex;
    }

    yield* deleteHistory(terminalId);
  });

  const applyDirectoryObservation = Effect.fn("terminal.applyDirectoryObservation")(function* (
    terminalId: string,
    expectedPid: number,
    observation: TerminalDirectoryObservation,
    workspaceDirectories: Option.Option<ReadonlyArray<RegisteredWorkspaceDirectory>>,
  ) {
    if (observation.kind !== "known") {
      return;
    }

    // No registry list means the caller cannot map directories; the raw
    // observation is still recorded so destructive deletion can use it.
    const nextWorkspaceId = Option.isSome(workspaceDirectories)
      ? resolveWorkspaceAssignmentForDirectory(
          workspaceDirectories.value,
          observation.directory,
          path,
        )
      : undefined;

    const event = yield* modifyManagerState((state) => {
      const liveSession = state.sessions.get(toSessionKey(terminalId));
      if (!liveSession || liveSession.status !== "running" || liveSession.pid !== expectedPid) {
        return [Option.none(), state] as const;
      }
      liveSession.observedDirectory = observation.directory;
      if (nextWorkspaceId === undefined || liveSession.workspaceId === nextWorkspaceId) {
        return [Option.none(), state] as const;
      }
      // Assignment is projection metadata: the PTY, launch cwd, history, and
      // event stream are untouched.
      liveSession.workspaceId = nextWorkspaceId;
      const eventStamp = advanceEventSequence(liveSession);
      return [
        Option.some({
          type: "assigned" as const,
          ...ownerEventFields(liveSession),
          terminalId: liveSession.terminalId,
          sequence: eventStamp.sequence,
        }),
        state,
      ] as const;
    });

    if (Option.isSome(event)) {
      yield* persistSessionIndex;
      yield* publishEvent(event.value);
    }
  });

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );

    if (runningSessions.length === 0) {
      return true;
    }

    const inspectorOption = yield* acquireSubprocessInspector.pipe(
      Effect.map(Option.some),
      Effect.catch((reason) =>
        Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
          reason,
        }).pipe(
          Effect.as(
            Option.none<{
              readonly inspector: TerminalSubprocessInspector;
              readonly snapshotSucceeded: boolean;
            }>(),
          ),
        ),
      ),
    );

    if (Option.isNone(inspectorOption)) {
      return false;
    }

    const { inspector: subprocessInspector, snapshotSucceeded } = inspectorOption.value;

    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      session: TerminalSessionState & { pid: number },
    ) {
      const terminalPid = session.pid;
      const inspectResult = yield* subprocessInspector(terminalPid).pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (Option.isNone(inspectResult)) {
        return;
      }

      const next = inspectResult.value;
      yield* registerTerminalProcesses({
        ...ownerEventFields(session),
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);

        return [
          Option.some({
            type: "activity" as const,
            ...ownerEventFields(liveSession.value),
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });
    return snapshotSucceeded;
  });

  const runningSessionPids = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].flatMap((session) =>
        session.status === "running" && Number.isInteger(session.pid)
          ? [{ terminalId: session.terminalId, pid: session.pid as number }]
          : [],
      ),
    ),
  );

  /**
   * Observe every running shell's directory and reproject its assignment.
   *
   * This runs on its own loop, separate from subprocess polling: that poll
   * backs off to a minute when the resource-monitor snapshot is unavailable,
   * and Sidebar reassignment must not inherit that delay.
   */
  const directoryObservationLock = yield* Semaphore.make(1);
  const pollDirectoryAssignments = Effect.fn("terminal.pollDirectoryAssignments")(function* (
    terminalIds?: ReadonlySet<string>,
  ) {
    const sessions = (yield* runningSessionPids).filter(
      (session) => terminalIds === undefined || terminalIds.has(session.terminalId),
    );
    if (sessions.length === 0) return new Map<string, TerminalDirectoryObservation>();

    // One registry read per tick, reused by every terminal. A failure keeps the
    // last confirmed assignment instead of unassigning terminals.
    const listWorkspaceDirectories = options.listRegisteredWorkspaceDirectories;
    const workspaceDirectories: Option.Option<ReadonlyArray<RegisteredWorkspaceDirectory>> =
      listWorkspaceDirectories !== undefined
        ? yield* listWorkspaceDirectories().pipe(
            Effect.map(Option.some),
            Effect.catch((reason) =>
              Effect.logWarning(
                "failed to list registered Workspace directories for terminal directory observation",
                { reason },
              ).pipe(Effect.as(Option.none<ReadonlyArray<RegisteredWorkspaceDirectory>>())),
            ),
          )
        : Option.none<ReadonlyArray<RegisteredWorkspaceDirectory>>();

    const observations = yield* Effect.forEach(
      sessions,
      (session) =>
        Effect.gen(function* () {
          const observation = yield* directoryObserver.observe(session.pid);
          yield* applyDirectoryObservation(
            session.terminalId,
            session.pid,
            observation,
            workspaceDirectories,
          );
          return [session.terminalId, observation] as const;
        }),
      { concurrency: "unbounded" },
    );
    return new Map(observations);
  });

  if (directoryObservationSupported) {
    // The fallback has its own clock, so continuous output from one terminal
    // cannot starve silent terminals. Both triggers feed the same serial worker.
    yield* Effect.forever(
      Effect.sync(() => {
        refreshAllDirectories = true;
        Queue.offerUnsafe(directoryWakeups, undefined);
      }).pipe(Effect.andThen(Effect.sleep(directoryPollIntervalMs))),
    ).pipe(Effect.forkIn(workerScope));

    yield* Effect.forever(
      Queue.take(directoryWakeups).pipe(
        // Fixed coalescing window, not trailing debounce: continuous output
        // cannot postpone observation indefinitely or spawn a probe per chunk.
        Effect.andThen(Effect.sleep(directoryActivityWindowMs)),
        Effect.flatMap(() => {
          const terminalIds = refreshAllDirectories ? undefined : new Set(pendingDirectorySessions);
          refreshAllDirectories = false;
          pendingDirectorySessions.clear();
          return directoryObservationLock.withPermit(pollDirectoryAssignments(terminalIds));
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("terminal directory observation tick failed", { cause }),
        ),
      ),
    ).pipe(Effect.forkIn(workerScope));
  }

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  let subprocessSnapshotFailureCount = 0;
  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap((snapshotSucceeded) => {
                subprocessSnapshotFailureCount = snapshotSucceeded
                  ? 0
                  : Math.min(subprocessSnapshotFailureCount + 1, 30);
                const delayMs = subprocessSnapshotPollDelayMs(
                  subprocessPollIntervalMs,
                  subprocessSnapshotFailureCount,
                );
                return Effect.sleep(delayMs);
              }),
            )
          : Effect.sync(() => {
              subprocessSnapshotFailureCount = 0;
            }).pipe(Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs))),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* modifyManagerState(
        (state) =>
          [
            [...state.sessions.values()],
            {
              ...state,
              sessions: new Map(),
            },
          ] as const,
      );

      // Stop the debounced writer before the final write, including when a
      // virtual clock has a pending debounce. No older write can race it.
      for (const session of sessions) cleanupProcessHandles(session);
      if (sessions.some((session) => session.workspaceId !== null)) {
        yield* Scope.close(workerScope, Exit.void);
      }

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        cleanupProcessHandles(session);
        if (session.workspaceId !== null) {
          yield* fileSystem
            .writeFileString(historyPath(session.terminalId), session.history.value())
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("failed to persist terminal history on shutdown", {
                  cause,
                  terminalId: session.terminalId,
                }),
              ),
            );
        }
        if (!session.process) return;
        yield* clearKillFiber(session.process);
        yield* runKillEscalation(session.process, session.terminalId);
      });

      yield* Effect.forEach(sessions, cleanupSession, {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const openLocked = Effect.fn("terminal.openLocked")(function* (
    input: TerminalOpenInput & { readonly cwd: string },
  ) {
    const terminalId = input.terminalId;
    yield* assertValidCwd(input.cwd);

    const sessionKey = toSessionKey(terminalId);
    const existing = yield* getSession(terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(terminalId);
      const history = yield* readHistory(terminalId);
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const managerState = yield* readManagerState;
      const persistedSessions = yield* readPersistedSessionIndex;
      const defaultTitle = nextDefaultTerminalTitle(
        [...managerState.sessions.values(), ...persistedSessions],
        input.workspaceId ?? null,
      );
      const session: TerminalSessionState = {
        workspaceId: input.workspaceId ?? null,
        terminalId,
        defaultTitle,
        title: defaultTitle,
        titleSource: "default",
        pendingTitleSequence: "",
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        createdAt: yield* nowIso,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        cols,
        rows,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        generation: 0,
        childCommandLabel: null,
        observedDirectory: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
      };

      const createdSession = session;
      yield* modifyManagerState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        return [undefined, { ...state, sessions }] as const;
      });

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return snapshot(session);
    }

    const liveSession = existing.value;
    // A supplied Workspace updates the current assignment. It is mutable
    // metadata, not identity: the key stays the stable terminal id.
    const assignmentChanged =
      input.workspaceId !== undefined && input.workspaceId !== liveSession.workspaceId;
    if (assignmentChanged) liveSession.workspaceId = input.workspaceId ?? null;
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols = input.cols ?? liveSession.cols;
    const targetRows = input.rows ?? liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    const nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath;

    if (launchContextChanged) {
      yield* stopProcess(liveSession);
      liveSession.cwd = input.cwd;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.terminalId, liveSession.history);
    } else if (liveSession.status === "exited" || liveSession.status === "error") {
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.terminalId, liveSession.history);
    }

    if (!liveSession.process) {
      yield* startSession(
        liveSession,
        {
          ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          terminalId,
          cwd: input.cwd,
          worktreePath: liveSession.worktreePath,
          cols: targetCols,
          rows: targetRows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return snapshot(liveSession);
    }

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      yield* resizePtyProcess(liveSession, liveSession.process, targetCols, targetRows);
      liveSession.cols = targetCols;
      liveSession.rows = targetRows;
      liveSession.updatedAt = yield* nowIso;
    }
    if (assignmentChanged) yield* persistSessionIndex;

    return snapshot(liveSession);
  });

  const open: TerminalManager["Service"]["open"] = (input) =>
    withTerminalLock(
      input.terminalId,
      resolveLaunchInputEnvironment(input).pipe(Effect.flatMap(openLocked)),
    );

  const openOrAttachForStream = (input: TerminalAttachInput) =>
    withTerminalLock(
      input.terminalId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const existing = yield* getSession(terminalId);

        if (Option.isNone(existing)) {
          if (input.cwd === undefined && input.workspaceId === undefined) {
            return yield* new TerminalSessionLookupError({ terminalId });
          }

          const resolvedInput = yield* resolveLaunchInputEnvironment({
            ...input,
            terminalId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          });
          return yield* openLocked(resolvedInput);
        }

        const session = existing.value;
        const targetCols = input.cols ?? session.cols;
        const targetRows = input.rows ?? session.rows;

        if (
          session.status !== "closed" &&
          !session.process &&
          input.cwd &&
          input.restartIfNotRunning === true
        ) {
          const resolvedInput = yield* resolveLaunchInputEnvironment({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
          return yield* openLocked(resolvedInput);
        }

        if (
          session.process &&
          session.status === "running" &&
          (session.cols !== targetCols || session.rows !== targetRows)
        ) {
          const process = session.process;
          yield* resizePtyProcess(session, process, targetCols, targetRows);
          session.cols = targetCols;
          session.rows = targetRows;
          session.updatedAt = yield* nowIso;
        }

        return snapshot(session);
      }),
    );

  const readAllTerminalMetadata = () =>
    Effect.gen(function* () {
      const state = yield* readManagerState;
      const memorySummaries = [...state.sessions.values()].map(summary);
      const memoryKeys = new Set(memorySummaries.map((s) => toSessionKey(s.terminalId)));
      const deletedKeys = state.deletedSessionKeys ?? new Set<string>();

      const diskRecords = yield* readPersistedSessionIndex;
      const restoredTitles = restoredTerminalTitles(diskRecords);
      const diskSummaries = reconcileDiskTerminalRecords(diskRecords, memoryKeys, deletedKeys).map(
        (record) => {
          const restoredTitle = restoredTitles.get(toSessionKey(record.terminalId));
          return {
            ...terminalIdentityFields(record.terminalId, record.workspaceId ?? null),
            createdAt: record.createdAt,
            cwd: record.cwd,
            worktreePath: record.worktreePath,
            status: record.status,
            pid: null,
            exitCode: record.exitCode,
            exitSignal: record.exitSignal,
            hasRunningSubprocess: false,
            label: "terminal",
            title: restoredTitle?.title ?? record.title ?? "Terminal",
            updatedAt: record.updatedAt,
            generation: record.generation,
          };
        },
      );

      return [...memorySummaries, ...diskSummaries].sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          (left.workspaceId ?? "").localeCompare(right.workspaceId ?? "") ||
          left.terminalId.localeCompare(right.terminalId),
      );
    });

  const readTerminalMetadata = (input: {
    readonly workspaceId?: string | undefined;
    readonly terminalId: string;
  }) =>
    getSession(input.terminalId).pipe(
      Effect.map((session) => (Option.isSome(session) ? summary(session.value) : null)),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      return () => {
        terminalEventListeners.delete(listener);
      };
    });

  const attachStream: TerminalManager["Service"]["attachStream"] = (input, listener) => {
    let unsubscribe: (() => void) | null = null;
    const terminalId = input.terminalId;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;
      let needsResync = false;

      unsubscribe = yield* subscribe((event) => {
        if (event.terminalId !== terminalId) {
          return Effect.void;
        }

        if (!deliverLive) {
          if (bufferedEvents.length >= MAX_PENDING_ATTACH_EVENTS) {
            // The client is still receiving its first snapshot. Drop the
            // handshake backlog; a snapshot taken after the drop covers it, so
            // the daemon never buffers output without bound for one client.
            bufferedEvents.length = 0;
            needsResync = true;
            return Effect.void;
          }
          bufferedEvents.push(event);
          return Effect.void;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        return attachEvent ? listener(attachEvent) : Effect.void;
      });

      let initialSnapshot = yield* openOrAttachForStream(input);

      yield* listener({
        type: "snapshot",
        snapshot: initialSnapshot,
      });

      while (needsResync) {
        needsResync = false;
        bufferedEvents.length = 0;
        initialSnapshot = yield* openOrAttachForStream(input);
        yield* listener({
          type: "snapshot",
          snapshot: initialSnapshot,
        });
      }

      for (const event of bufferedEvents) {
        if (isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const metadataEventFromTerminalEvent = (
    event: TerminalEvent,
  ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
    if (!shouldPublishTerminalMetadataEvent(event)) {
      return Effect.succeed(null);
    }

    if (event.type === "closed") {
      return readTerminalMetadata({
        ...(event.workspaceId !== undefined ? { workspaceId: event.workspaceId } : {}),
        terminalId: event.terminalId,
      }).pipe(
        Effect.map((terminal) => {
          if (terminal && terminal.status === "closed") {
            return {
              type: "upsert" as const,
              terminal,
            };
          }
          return {
            type: "remove" as const,
            terminalId: event.terminalId,
          };
        }),
      );
    }

    return readTerminalMetadata({
      ...(event.workspaceId !== undefined ? { workspaceId: event.workspaceId } : {}),
      terminalId: event.terminalId,
    }).pipe(
      Effect.map((terminal) =>
        terminal
          ? {
              type: "upsert" as const,
              terminal,
            }
          : null,
      ),
    );
  };

  const offerMetadataEvent = (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    event: TerminalEvent,
  ) =>
    metadataEventFromTerminalEvent(event).pipe(
      Effect.flatMap((metadataEvent) => (metadataEvent ? listener(metadataEvent) : Effect.void)),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        return offerMetadataEvent(listener, event);
      });

      const terminals = yield* readAllTerminalMetadata();
      yield* listener({
        type: "snapshot",
        terminals,
      });

      for (const event of bufferedEvents) {
        yield* offerMetadataEvent(listener, event);
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const write: TerminalManager["Service"]["write"] = Effect.fn("terminal.write")(function* (input) {
    const terminalId = input.terminalId;
    const session = yield* requireSession(terminalId);
    const process = session.process;
    if (!process || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({ terminalId });
    }
    yield* Effect.try({
      try: () => process.write(input.data),
      catch: (cause) =>
        new TerminalWriteError({
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
    requestDirectoryObservation(terminalId);
  });

  const resizeLocked = Effect.fn("terminal.resize")(function* (input: TerminalResizeInput) {
    const session = yield* getSession(input.terminalId);
    // ResizeObserver traffic can already be in flight when the UI closes the session.
    if (Option.isNone(session)) {
      return;
    }
    const process = session.value.process;
    if (!process || session.value.status !== "running") {
      return;
    }
    yield* resizePtyProcess(session.value, process, input.cols, input.rows);
    session.value.cols = input.cols;
    session.value.rows = input.rows;
    session.value.updatedAt = yield* nowIso;
  });

  const resize: TerminalManager["Service"]["resize"] = (input) =>
    withTerminalLock(input.terminalId, resizeLocked(input));

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withTerminalLock(
      input.terminalId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const session = yield* requireSession(terminalId);
        session.history.clear();
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        const eventStamp = advanceEventSequence(session);
        yield* persistHistory(terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          ...ownerEventFields(session),
          terminalId,
          sequence: eventStamp.sequence,
        });
      }),
    );

  const rename: TerminalManager["Service"]["rename"] = (input) =>
    withTerminalLock(
      input.terminalId,
      Effect.gen(function* () {
        const session = yield* requireSession(input.terminalId);
        const title = input.title.trim();
        const eventStamp = yield* Effect.sync(() => {
          session.title = title;
          session.titleSource = "manual";
          return advanceEventSequence(session);
        });
        yield* persistSessionIndex;
        yield* publishEvent({
          type: "renamed",
          ...ownerEventFields(session),
          terminalId: session.terminalId,
          sequence: eventStamp.sequence,
          title,
        });
        return summary(session);
      }),
    );

  const restartResolved = (input: TerminalRestartInput & { readonly cwd: string }) =>
    Effect.gen(function* () {
      yield* increment(terminalRestartsTotal, { scope: "terminal" });
      const terminalId = input.terminalId;
      yield* assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(terminalId);
      const existingSession = yield* getSession(terminalId);
      let session: TerminalSessionState;
      if (Option.isNone(existingSession)) {
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        const managerState = yield* readManagerState;
        const persistedSessions = yield* readPersistedSessionIndex;
        const defaultTitle = nextDefaultTerminalTitle(
          [...managerState.sessions.values(), ...persistedSessions],
          input.workspaceId ?? null,
        );
        session = {
          workspaceId: input.workspaceId ?? null,
          terminalId,
          defaultTitle,
          title: defaultTitle,
          titleSource: "default",
          pendingTitleSequence: "",
          cwd: input.cwd,
          worktreePath: input.worktreePath ?? null,
          status: "starting",
          pid: null,
          history:
            input.workspaceId !== undefined
              ? yield* readHistory(terminalId)
              : new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit),
          pendingHistoryControlSequence: "",
          pendingProcessEvents: [],
          pendingProcessEventIndex: 0,
          processEventDrainRunning: false,
          exitCode: null,
          exitSignal: null,
          createdAt: yield* nowIso,
          updatedAt: yield* nowIso,
          eventSequence: 0,
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          generation: 0,
          childCommandLabel: null,
          observedDirectory: null,
          runtimeEnv: normalizedRuntimeEnv(input.env),
        };
        const createdSession = session;
        yield* modifyManagerState((state) => {
          const sessions = new Map(state.sessions);
          sessions.set(sessionKey, createdSession);
          return [undefined, { ...state, sessions }] as const;
        });
        yield* evictInactiveSessionsIfNeeded();
      } else {
        session = existingSession.value;
        yield* stopProcess(session);
        session.cwd = input.cwd;
        session.worktreePath = input.worktreePath ?? null;
        session.runtimeEnv = normalizedRuntimeEnv(input.env);
        session.pendingTitleSequence = "";
      }

      const cols = input.cols ?? session.cols;
      const rows = input.rows ?? session.rows;

      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      yield* persistHistory(terminalId, session.history);
      yield* startSession(
        session,
        {
          ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "restarted",
      );
      return snapshot(session);
    });

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    withTerminalLock(
      input.terminalId,
      resolveLaunchInputEnvironment(input).pipe(Effect.flatMap(restartResolved)),
    );

  const close: TerminalManager["Service"]["close"] = (input) =>
    withTerminalLock(
      input.terminalId,
      closeSession(input.terminalId, input.deleteHistory === true),
    );

  const getDirectoryOccupancy: TerminalManager["Service"]["getDirectoryOccupancy"] = () =>
    directoryObservationLock.withPermit(
      Effect.gen(function* () {
        // Destructive operations must not trust a snapshot from before a recent cd.
        const shellObservations = directoryObservationSupported
          ? yield* pollDirectoryAssignments()
          : new Map<string, TerminalDirectoryObservation>();
        const state = yield* readManagerState;
        const sessions = [...state.sessions.values()];
        const inspector = sessions.some((session) => session.status === "running")
          ? yield* acquireSubprocessInspector.pipe(Effect.option)
          : Option.none();
        return yield* Effect.forEach(sessions, (session) =>
          Effect.gen(function* () {
            const processDirectories: string[] = [];
            let hasUnobservedProcesses =
              session.status === "running" &&
              shellObservations.get(session.terminalId)?.kind !== "known";
            if (session.status === "running" && session.pid !== null) {
              const children = Option.isSome(inspector)
                ? yield* inspector.value.inspector(session.pid).pipe(Effect.option)
                : Option.none();
              if (Option.isNone(children)) {
                hasUnobservedProcesses = true;
              } else {
                const childPids = [...new Set(children.value.processIds)].filter(
                  (pid) => pid !== session.pid,
                );
                hasUnobservedProcesses ||=
                  children.value.hasRunningSubprocess && childPids.length === 0;
                const observations = yield* Effect.forEach(
                  childPids,
                  (pid) => directoryObserver.observe(pid),
                  { concurrency: 8 },
                );
                for (const observation of observations) {
                  if (observation.kind === "known") processDirectories.push(observation.directory);
                  else hasUnobservedProcesses = true;
                }
              }
            }
            return {
              terminalId: session.terminalId,
              ...(session.workspaceId !== null ? { workspaceId: session.workspaceId } : {}),
              status: session.status,
              launchCwd: session.cwd,
              observedDirectory: session.observedDirectory,
              directoryObservationSupported,
              processDirectories,
              hasUnobservedProcesses,
            } satisfies TerminalDirectoryOccupancy;
          }),
        );
      }),
    );

  const releaseWorkspaceAssignment: TerminalManager["Service"]["releaseWorkspaceAssignment"] = (
    workspaceId,
  ) =>
    directoryObservationLock.withPermit(
      Effect.gen(function* () {
        const events = yield* modifyManagerState((state) => {
          const released: TerminalEvent[] = [];
          for (const session of state.sessions.values()) {
            if (session.workspaceId !== workspaceId) continue;
            session.workspaceId = null;
            const eventStamp = advanceEventSequence(session);
            released.push({
              type: "assigned",
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
            });
          }
          return [released, state] as const;
        });
        if (events.length === 0) return;
        yield* persistSessionIndex;
        for (const event of events) {
          yield* publishEvent(event);
        }
      }),
    );

  return TerminalManager.of({
    open,
    attachStream,
    write,
    resize,
    clear,
    rename,
    restart,
    close,
    getDirectoryOccupancy,
    releaseWorkspaceAssignment,
    subscribe,
    subscribeMetadata,
    getMetadata: readAllTerminalMetadata,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));
