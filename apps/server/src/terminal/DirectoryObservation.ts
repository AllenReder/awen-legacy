import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type * as ProcessRunner from "../processRunner.ts";

/**
 * How this host can learn a process's working directory.
 *
 * The daemon never infers a directory from terminal output. It asks the OS for
 * the target process's real current directory, so unrelated output text or
 * background chat cannot move a terminal. When the host cannot answer, the
 * observation is `unknown` and the caller keeps the last confirmed assignment.
 */
export type TerminalDirectoryObservationMechanism = "procfs" | "lsof" | "none";

export interface TerminalDirectoryObservationCapability {
  readonly supported: boolean;
  readonly mechanism: TerminalDirectoryObservationMechanism;
}

/**
 * The explicit platform support matrix for shell directory observation.
 *
 * - Linux reads `/proc/<pid>/cwd`, which is exact for the shell and any child.
 * - macOS runs `lsof -a -p <pid> -d cwd`; the shell must be owned by the same
 *   user, which local daemon terminals are.
 * - Every other platform (including Windows) is unsupported and always reports
 *   `unknown`, so the terminal keeps its launch assignment instead of guessing.
 */
export function terminalDirectoryObservationCapability(
  platform: NodeJS.Platform,
): TerminalDirectoryObservationCapability {
  switch (platform) {
    case "linux":
      return { supported: true, mechanism: "procfs" };
    case "darwin":
      return { supported: true, mechanism: "lsof" };
    default:
      return { supported: false, mechanism: "none" };
  }
}

export type TerminalDirectoryObservation =
  | { readonly kind: "known"; readonly directory: string }
  | { readonly kind: "unknown"; readonly reason: "unsupported" | "unavailable" };

export interface TerminalDirectoryObserver {
  readonly capability: TerminalDirectoryObservationCapability;
  /** Resolve one process's working directory. Uncertainty never fails. */
  readonly observe: (processId: number) => Effect.Effect<TerminalDirectoryObservation>;
}

export const unsupportedTerminalDirectoryObserver = (
  platform: NodeJS.Platform,
): TerminalDirectoryObserver => ({
  capability: terminalDirectoryObservationCapability(platform),
  observe: () => Effect.succeed({ kind: "unknown", reason: "unsupported" }),
});

const DELETED_CWD_SUFFIX = " (deleted)";

/**
 * `/proc/<pid>/cwd` for a directory that has been removed resolves to
 * `"<path> (deleted)"`. That is not a usable working directory, so treat it as
 * unavailable rather than moving the terminal to a path that no longer exists.
 */
function cleanProcfsDirectory(target: string): string | null {
  if (target.endsWith(DELETED_CWD_SUFFIX)) return null;
  return target.length > 0 ? target : null;
}

function parseLsofDirectory(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const value = line.slice(1);
    if (value.length > 0) return value;
  }
  return null;
}

/**
 * Build the platform observer for the current host.
 *
 * `lsofCommand` exists so a test can inject a deterministic process; production
 * callers omit it and use the system `lsof`.
 */
export function makeTerminalDirectoryObserver(input: {
  readonly platform: NodeJS.Platform;
  readonly fileSystem: FileSystem.FileSystem;
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  readonly lsofCommand?: string;
}): TerminalDirectoryObserver {
  const capability = terminalDirectoryObservationCapability(input.platform);
  if (!capability.supported) return unsupportedTerminalDirectoryObserver(input.platform);

  if (capability.mechanism === "procfs") {
    return {
      capability,
      observe: (processId) =>
        input.fileSystem.readLink(`/proc/${processId}/cwd`).pipe(
          Effect.map((target): TerminalDirectoryObservation => {
            const directory = cleanProcfsDirectory(target);
            return directory === null
              ? { kind: "unknown", reason: "unavailable" }
              : { kind: "known", directory };
          }),
          Effect.orElseSucceed((): TerminalDirectoryObservation => ({
            kind: "unknown",
            reason: "unavailable",
          })),
        ),
    };
  }

  const lsofCommand = input.lsofCommand ?? "lsof";
  return {
    capability,
    observe: (processId) =>
      input.processRunner
        .run({
          command: lsofCommand,
          args: ["-a", "-p", String(processId), "-d", "cwd", "-Fn"],
          timeout: "1 second",
          maxOutputBytes: 65_536,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.map((result): TerminalDirectoryObservation => {
            if (result.timedOut || result.stdoutTruncated) {
              return { kind: "unknown", reason: "unavailable" };
            }
            const directory = parseLsofDirectory(result.stdout);
            return directory === null
              ? { kind: "unknown", reason: "unavailable" }
              : { kind: "known", directory };
          }),
          Effect.orElseSucceed((): TerminalDirectoryObservation => ({
            kind: "unknown",
            reason: "unavailable",
          })),
        ),
  };
}

/** One registered Workspace directory in the terminal's own Environment. */
export interface RegisteredWorkspaceDirectory {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
}

/**
 * True when `candidate` is `parent` or a descendant of it, using path
 * boundaries rather than naive string prefixes.
 */
export function isPathInsideOrEqual(
  pathService: Path.Path,
  parent: string,
  candidate: string,
): boolean {
  const relative = pathService.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathService.sep}`) &&
      !pathService.isAbsolute(relative))
  );
}

/**
 * Map an observed directory to a registered Workspace assignment.
 *
 * The nearest ancestor Workspace wins, so a subdirectory of a checkout keeps
 * that checkout's assignment. A directory outside every registered Workspace
 * resolves to `null` — the Environment's unassigned group — without implicitly
 * registering a Project. Matching is confined to the Workspaces this Environment
 * already knows, so a `cd` can assign across Projects but never create one.
 */
export function resolveWorkspaceAssignmentForDirectory(
  workspaces: ReadonlyArray<RegisteredWorkspaceDirectory>,
  directory: string,
  pathService: Path.Path,
): string | null {
  let best: RegisteredWorkspaceDirectory | null = null;
  for (const workspace of workspaces) {
    if (!isPathInsideOrEqual(pathService, workspace.workspaceRoot, directory)) continue;
    if (best === null || workspace.workspaceRoot.length > best.workspaceRoot.length) {
      best = workspace;
    }
  }
  return best?.workspaceId ?? null;
}
