import * as Schema from "effect/Schema";
import { TerminalSessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SessionKind } from "./session.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Conventional id for the first shell opened in a scope. Ids are uniformly
 * `term-N` for sequential callers and UUID-shaped for callers that need a
 * globally unique terminal, so there is no "default" intrinsic. Kept as a named
 * constant so callers that want "the primary shell" don't hardcode `"term-1"`.
 */
export const DEFAULT_TERMINAL_ID = "term-1";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalEnvSchema = Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
);

/**
 * Terminal operations address a terminal by its stable Awen identity. The
 * client always chooses the id; the server never allocates one.
 *
 * `workspaceId` is the terminal's current Workspace assignment. It is optional
 * and mutable: it names the launch directory only when a terminal is created,
 * and never acts as a lookup key. A terminal keeps its PTY, history, event
 * stream, and deep link when the assignment changes or disappears.
 */
const TerminalSessionInput = Schema.Struct({
  terminalId: TerminalIdSchema,
  workspaceId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  /** Launch directory. Resolved from workspaceId when a Workspace is assigned. */
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type TerminalOpenInput = typeof TerminalOpenInput.Type;

export const TerminalAttachInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  restartIfNotRunning: Schema.optional(Schema.Boolean),
});
export type TerminalAttachInput = typeof TerminalAttachInput.Type;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRenameInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  title: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128)),
});
export type TerminalRenameInput = typeof TerminalRenameInput.Type;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type TerminalRestartInput = typeof TerminalRestartInput.Type;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = typeof TerminalCloseInput.Type;

export const TerminalSessionStatus = Schema.Literals([
  "starting",
  "running",
  "exited",
  "error",
  "closed",
]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

/**
 * Durable, workspace-independent identity for one terminal work context.
 *
 * The `terminalId` is chosen by the client at creation and survives PTY
 * restarts, Workspace reassignment, and reconnect. `workspaceId` is the
 * terminal's current assignment and may be absent. `cwd` is launch context,
 * not the lookup key.
 */
export const TerminalSessionSnapshot = Schema.Struct({
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  sessionId: TerminalSessionId,
  kind: Schema.Literal("terminal"),
  workspaceId: Schema.optional(TrimmedNonEmptyStringSchema),
  createdAt: Schema.optional(Schema.String),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  /** Persistent user-visible Session title. */
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  updatedAt: Schema.String,
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Increments whenever a new PTY is spawned for this Session. */
  generation: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

export const TerminalSummary = Schema.Struct({
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  sessionId: TerminalSessionId,
  kind: SessionKind,
  workspaceId: Schema.optional(TrimmedNonEmptyStringSchema),
  createdAt: Schema.optional(Schema.String),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  hasRunningSubprocess: Schema.Boolean,
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  /** Persistent user-visible Session title. */
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  updatedAt: Schema.String,
  /** Increments whenever a new PTY is spawned for this Session. */
  generation: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type TerminalSummary = typeof TerminalSummary.Type;

const TerminalMetadataSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  terminals: Schema.Array(TerminalSummary),
});

const TerminalMetadataUpsertEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  terminal: TerminalSummary,
});

const TerminalMetadataRemoveEvent = Schema.Struct({
  type: Schema.Literal("remove"),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
});

export const TerminalMetadataStreamEvent = Schema.Union([
  TerminalMetadataSnapshotEvent,
  TerminalMetadataUpsertEvent,
  TerminalMetadataRemoveEvent,
]);
export type TerminalMetadataStreamEvent = typeof TerminalMetadataStreamEvent.Type;

const TerminalEventBaseSchema = Schema.Struct({
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  /** Current assignment at the time of the event; absent when unassigned. */
  workspaceId: Schema.optional(TrimmedNonEmptyStringSchema),
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalClosedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  label: Schema.String.check(Schema.isMaxLength(128)),
});

const TerminalRenamedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("renamed"),
  title: TrimmedNonEmptyString,
});

/**
 * The Session's Workspace assignment changed without a PTY restart.
 *
 * A reliable directory observation moved the terminal into another registered
 * Workspace, into the unassigned group, or back; its identity, PTY, history,
 * and event stream are unchanged. Clients refresh the metadata projection
 * rather than re-opening the terminal.
 */
const TerminalAssignedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("assigned"),
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
  TerminalRenamedEvent,
  TerminalAssignedEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

const TerminalAttachSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: TerminalSessionSnapshot,
});

export const TerminalAttachStreamEvent = Schema.Union([
  TerminalAttachSnapshotEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalAttachStreamEvent = typeof TerminalAttachStreamEvent.Type;

export class TerminalCwdNotFoundError extends Schema.TaggedError<TerminalCwdNotFoundError>()(
  "TerminalCwdNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd does not exist: ${this.cwd}`;
  }
}

export class TerminalCwdNotDirectoryError extends Schema.TaggedError<TerminalCwdNotDirectoryError>()(
  "TerminalCwdNotDirectoryError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd is not a directory: ${this.cwd}`;
  }
}

export class TerminalCwdStatError extends Schema.TaggedError<TerminalCwdStatError>()(
  "TerminalCwdStatError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export const TerminalCwdError = Schema.Union([
  TerminalCwdNotFoundError,
  TerminalCwdNotDirectoryError,
  TerminalCwdStatError,
]);
export type TerminalCwdError = typeof TerminalCwdError.Type;

export class TerminalHistoryError extends Schema.TaggedError<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate"]),
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for terminal: ${this.terminalId}`;
  }
}

export class TerminalWorkspaceNotFoundError extends Schema.TaggedError<TerminalWorkspaceNotFoundError>()(
  "TerminalWorkspaceNotFoundError",
  {
    workspaceId: TrimmedNonEmptyStringSchema,
  },
) {
  override get message() {
    return `Unknown terminal workspace: ${this.workspaceId}`;
  }
}

/**
 * The daemon has no workspace-root resolver wired, so workspace-owned
 * terminals cannot be opened at all. Distinct from
 * `TerminalWorkspaceNotFoundError`: the workspace may exist — the daemon
 * itself is degraded.
 */
export class TerminalWorkspaceResolutionUnavailableError extends Schema.TaggedError<TerminalWorkspaceResolutionUnavailableError>()(
  "TerminalWorkspaceResolutionUnavailableError",
  {
    workspaceId: TrimmedNonEmptyStringSchema,
  },
) {
  override get message() {
    return `Terminal workspace resolution is unavailable for workspace: ${this.workspaceId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedError<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal: ${this.terminalId}`;
  }
}

export class TerminalProviderInstanceNotFoundError extends Schema.TaggedError<TerminalProviderInstanceNotFoundError>()(
  "TerminalProviderInstanceNotFoundError",
  {
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message() {
    return `Provider instance is not available: ${this.providerInstanceId}`;
  }
}

export class TerminalProviderEnvironmentError extends Schema.TaggedError<TerminalProviderEnvironmentError>()(
  "TerminalProviderEnvironmentError",
  {
    providerInstanceId: ProviderInstanceId,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not prepare the terminal environment for provider instance: ${this.providerInstanceId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedError<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running: ${this.terminalId}`;
  }
}

export class TerminalWriteError extends Schema.TaggedError<TerminalWriteError>()(
  "TerminalWriteError",
  {
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to write to terminal: ${this.terminalId}, PID: ${this.terminalPid}`;
  }
}

export class TerminalResizeError extends Schema.TaggedError<TerminalResizeError>()(
  "TerminalResizeError",
  {
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cols: TerminalColsSchema,
    rows: TerminalRowsSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to resize terminal: ${this.terminalId}, PID: ${this.terminalPid} to ${this.cols}x${this.rows}`;
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalWorkspaceNotFoundError,
  TerminalWorkspaceResolutionUnavailableError,
  TerminalSessionLookupError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalNotRunningError,
  TerminalWriteError,
  TerminalResizeError,
]);
export type TerminalError = typeof TerminalError.Type;
