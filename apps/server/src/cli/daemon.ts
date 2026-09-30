// @effect-diagnostics preferSchemaOverJson:off -- The CLI emits a deliberately small machine-readable envelope.
// @effect-diagnostics nodeBuiltinImport:off -- The daemon command resolves its own data-root path before the server runtime starts.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import {
  deriveLocalDaemonPaths,
  inspectAndFormatLocalDaemon,
  LocalDaemonError,
  localDaemonDescriptorForJson,
  localDaemonErrorForJson,
  startLocalDaemon,
  stopLocalDaemon,
  type LocalDaemonInspection,
} from "../localDaemon.ts";
import { baseDirFlag } from "./config.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print a machine-readable result."),
  Flag.withDefault(false),
);

const confirmFlag = Flag.boolean("confirm").pipe(
  Flag.withDescription("Confirm an explicit daemon stop request."),
  Flag.withDefault(false),
);

const resolveDaemonBaseDir = (baseDir: Option.Option<string>) =>
  Effect.sync(() => {
    const configured = Option.getOrUndefined(baseDir)?.trim() || process.env.AWEN_HOME?.trim();
    if (!configured) {
      const awenHome = NodePath.join(NodeOS.homedir(), ".awen");
      if (NodeFS.existsSync(awenHome)) return awenHome;
      return awenHome;
    }
    const expanded =
      configured === "~"
        ? NodeOS.homedir()
        : configured.startsWith("~/") || configured.startsWith("~\\")
          ? NodePath.join(NodeOS.homedir(), configured.slice(2))
          : configured;
    return NodePath.resolve(expanded);
  });

const tryDaemonOperation = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof LocalDaemonError
        ? cause
        : new LocalDaemonError(
            "daemon-operation-failed",
            cause instanceof Error ? cause.message : "The local daemon operation failed.",
          ),
  });

const formatInspection = (inspection: LocalDaemonInspection): string => {
  switch (inspection.status) {
    case "absent":
      return "Local daemon: not running";
    case "ready":
      return `Local daemon: running (pid ${String(inspection.state.pid)}, ${inspection.state.origin})`;
    case "stale":
      return `Local daemon: stale discovery record (pid ${String(inspection.state.pid)})`;
    case "invalid":
      return `Local daemon: invalid discovery record (${inspection.detail})`;
    case "unreachable":
      return `Local daemon: endpoint unreachable (${inspection.detail})`;
    case "foreign":
      return `Local daemon: ownership mismatch (${inspection.detail})`;
    case "auth-missing":
      return "Local daemon: credential missing";
    case "auth-invalid":
      return "Local daemon: credential rejected";
    case "auth-unavailable":
      return `Local daemon: authentication check unavailable (${inspection.detail})`;
  }
};

const runStart = (flags: {
  readonly baseDir: Option.Option<string>;
  readonly json: boolean;
  readonly expectedServerVersion: Option.Option<string>;
  readonly bindHost: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const baseDir = yield* resolveDaemonBaseDir(flags.baseDir);
    return yield* tryDaemonOperation(() =>
      startLocalDaemon({
        baseDir,
        ...Option.match(flags.bindHost, {
          onNone: () => ({}),
          onSome: (bindHost) => ({ bindHost }),
        }),
        ...Option.match(flags.expectedServerVersion, {
          onNone: () => ({}),
          onSome: (expectedServerVersion) => ({ expectedServerVersion }),
        }),
      }),
    ).pipe(
      Effect.matchEffect({
        onSuccess: (descriptor) =>
          flags.json
            ? Console.log(localDaemonDescriptorForJson(descriptor))
            : Console.log(
                `Local daemon ready (pid ${String(descriptor.pid)}, ${descriptor.origin}).`,
              ),
        onFailure: (cause) =>
          flags.json ? Console.log(localDaemonErrorForJson(cause)) : Effect.fail(cause),
      }),
    );
  });

const runStatus = (flags: { readonly baseDir: Option.Option<string>; readonly json: boolean }) =>
  Effect.gen(function* () {
    const baseDir = yield* resolveDaemonBaseDir(flags.baseDir);
    const inspection = yield* tryDaemonOperation(() => inspectAndFormatLocalDaemon(baseDir));
    if (flags.json) {
      yield* Console.log(JSON.stringify({ ok: true, ...inspection }));
    } else {
      yield* Console.log(formatInspection(inspection));
    }
  });

const runStop = (flags: {
  readonly baseDir: Option.Option<string>;
  readonly json: boolean;
  readonly confirm: boolean;
}) =>
  Effect.gen(function* () {
    const baseDir = yield* resolveDaemonBaseDir(flags.baseDir);
    return yield* tryDaemonOperation(() =>
      stopLocalDaemon({ baseDir, confirm: flags.confirm }),
    ).pipe(
      Effect.matchEffect({
        onSuccess: (result) =>
          flags.json
            ? Console.log(JSON.stringify({ ok: true, ...result }))
            : Console.log(
                result.status === "confirmation-required"
                  ? `Local daemon is still running (pid ${String(result.pid)}; active work: ${String(result.activeWork)}). Re-run with --confirm to stop it.`
                  : `Local daemon stop result: ${result.status}.`,
              ),
        onFailure: (cause) =>
          flags.json ? Console.log(localDaemonErrorForJson(cause)) : Effect.fail(cause),
      }),
    );
  });

const startCommand = Command.make("start", {
  bindHost: Flag.string("host").pipe(
    Flag.optional,
    Flag.withDescription("Bind address for a managed desktop daemon."),
  ),
  expectedServerVersion: Flag.string("expected-server-version").pipe(
    Flag.optional,
    Flag.withDescription("Replace an owned daemon when synchronizing a desktop upgrade."),
  ),
  baseDir: baseDirFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start or attach to the local Awen daemon for a data root."),
  Command.withHandler(runStart),
);

const statusCommand = Command.make("status", {
  baseDir: baseDirFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Inspect the local daemon without starting or stopping it."),
  Command.withHandler(runStatus),
);

const stopCommand = Command.make("stop", {
  baseDir: baseDirFlag,
  json: jsonFlag,
  confirm: confirmFlag,
}).pipe(
  Command.withDescription("Explicitly stop the local daemon after confirmation."),
  Command.withHandler(runStop),
);

const readToken = (baseDir: string) =>
  Effect.tryPromise({
    try: async () => {
      const paths = deriveLocalDaemonPaths(baseDir);
      const token = (await NodeFSP.readFile(paths.credentialPath, "utf8")).trim();
      if (token.length === 0) {
        throw new LocalDaemonError(
          "credential-missing",
          "No daemon credential found. Start with `awen daemon start`.",
        );
      }
      return token;
    },
    catch: (cause) =>
      cause instanceof LocalDaemonError
        ? cause
        : new LocalDaemonError(
            "credential-missing",
            "No daemon credential found. Start with `awen daemon start`.",
          ),
  });

const runToken = (flags: { readonly baseDir: Option.Option<string>; readonly json: boolean }) =>
  Effect.gen(function* () {
    const baseDir = yield* resolveDaemonBaseDir(flags.baseDir);
    return yield* readToken(baseDir).pipe(
      Effect.matchEffect({
        onSuccess: (token) =>
          flags.json
            ? Console.log(JSON.stringify({ ok: true, token }))
            : Console.log(`Awen daemon bootstrap token: ${token}`),
        onFailure: (cause) =>
          flags.json ? Console.log(localDaemonErrorForJson(cause)) : Effect.fail(cause),
      }),
    );
  });

const tokenCommand = Command.make("token", {
  baseDir: baseDirFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Read the local daemon bootstrap credential for client authentication."),
  Command.withHandler(runToken),
);

export const daemonCommand = Command.make("daemon").pipe(
  Command.withDescription("Manage the Awen local daemon."),
  Command.withSubcommands([startCommand, statusCommand, stopCommand, tokenCommand]),
);
