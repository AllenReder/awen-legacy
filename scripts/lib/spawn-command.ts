// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone dev and bootstrap launchers run before an Effect runtime exists and report on the inherited terminal.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

/** The package manager declared by the root `packageManager` field. */
const PACKAGE_MANAGER = "pnpm";

/**
 * A JavaScript entry point for a package manager, as published by
 * `npm_execpath` when a manager runs one of its own lifecycle scripts.
 */
const JAVASCRIPT_ENTRY = /\.(?:cjs|mjs|js)$/i;

/**
 * Arguments that survive a platform shell untouched. The shell fallback below
 * joins its argument vector into a single command line, so anything a shell or
 * `CommandLineToArgvW` would reinterpret has to be rejected instead of quoted:
 * quoting differs between `cmd.exe` and POSIX shells.
 */
const SHELL_UNQUOTED_ARGUMENT = /^[A-Za-z0-9@%+=:,._/-]+$/;

/**
 * A resolved command line: the program to spawn, its argument vector, and
 * whether a shell has to interpret it.
 *
 * This mirrors `ResolvedSpawnCommand` in `packages/shared/src/shell.ts`, which
 * is the repo-wide policy for running a command whose Windows form is a `.cmd`
 * shim. Standalone launchers cannot import that module - they run before
 * workspace dependencies are installed, and it needs an Effect runtime.
 */
export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

export interface CommandInvocationOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Run a Node entry point with the Node executable that is running this process.
 *
 * Reaching a CLI under `node_modules` by package-manager name is not portable:
 * Windows exposes `pnpm` and `.bin` entries as `.cmd` shims, and Node neither
 * resolves a bare name through `PATHEXT` (it fails with `ENOENT`) nor accepts
 * the shim without a shell (`EINVAL`, since Node 20.13). Spawning the entry
 * point with `process.execPath` needs no shell anywhere, so arguments stay a
 * real argument vector and are never re-parsed or re-quoted.
 */
export function nodeEntryInvocation(
  entryPath: string,
  args: readonly string[] = [],
): CommandInvocation {
  return { command: process.execPath, args: [entryPath, ...args], shell: false };
}

/**
 * Resolve an installed entry point such as `electron/cli.js` from the
 * package that depends on it.
 */
export function resolvePackageEntry(specifier: string, packageDirectory: string): string {
  const require = NodeModule.createRequire(NodePath.join(packageDirectory, "package.json"));
  try {
    return require.resolve(specifier);
  } catch {
    throw new Error(
      `Could not resolve ${specifier} from ${packageDirectory}. Run \`${PACKAGE_MANAGER} install\` first.`,
    );
  }
}

/**
 * Resolve how to run the package manager that owns this checkout.
 *
 * `npm_execpath` is the shell-free path: package managers set it to their own
 * JavaScript entry when they run a lifecycle script, so the manager runs under
 * this Node executable with a real argument vector.
 *
 * The fallback runs the manager for a caller that has no such environment and
 * no workspace yet, such as the Codex worktree bootstrap. There the Windows
 * form is a `.cmd` shim, which cannot be spawned without a shell at all, so the
 * command line goes through the platform shell as one pre-joined string - the
 * same trade-off `resolveSpawnCommand` makes. Arguments must be literals for
 * that to be safe, so anything a shell would reinterpret is rejected.
 */
export function packageManagerInvocation(
  args: readonly string[],
  options: CommandInvocationOptions = {},
): CommandInvocation {
  const environment = options.environment ?? process.env;
  const execPath = environment.npm_execpath?.trim();
  if (execPath !== undefined && JAVASCRIPT_ENTRY.test(execPath) && NodeFS.existsSync(execPath)) {
    return nodeEntryInvocation(execPath, args);
  }

  for (const arg of args) {
    if (!SHELL_UNQUOTED_ARGUMENT.test(arg)) {
      throw new Error(
        `Refusing to pass ${JSON.stringify(arg)} to ${PACKAGE_MANAGER} through a shell. Set npm_execpath or spawn the command's Node entry point with nodeEntryInvocation instead.`,
      );
    }
  }
  return { command: [PACKAGE_MANAGER, ...args].join(" "), args: [], shell: true };
}

/**
 * Prepend the `node_modules/.bin` directories of `packageDirectories` to the
 * `PATH` of an inherited environment.
 *
 * A package-manager script run adds exactly this to `PATH`: workspace CLIs such
 * as `vp` exist only in a local `.bin`, never on the machine `PATH`. Launchers
 * that spawn `scripts/dev-runner.ts` directly would otherwise resolve `vp` from
 * a `PATH` that does not contain it.
 */
export function withNodeModulesBin(
  environment: Readonly<Record<string, string | undefined>>,
  packageDirectories: readonly string[],
): Record<string, string | undefined> {
  const binDirectories = packageDirectories.map((directory) =>
    NodePath.join(directory, "node_modules", ".bin"),
  );
  // Windows environment blocks are case-insensitive; Node upper-cases `Path`.
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const inheritedPath = environment[pathKey]?.trim();
  const inheritedEntries = inheritedPath ? inheritedPath.split(NodePath.delimiter) : [];
  return {
    ...environment,
    [pathKey]: [...new Set([...binDirectories, ...inheritedEntries])].join(NodePath.delimiter),
  };
}

export interface InheritedSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Prefix for the failure line printed when the process cannot start. */
  readonly failureLabel: string;
}

/**
 * Spawn a command that shares this terminal, and adopt its exit status: the
 * launcher process reports the child's exit code, or dies by the signal that
 * terminated the child.
 */
export function spawnInherited(
  invocation: CommandInvocation,
  options: InheritedSpawnOptions,
): NodeChildProcess.ChildProcess {
  const child = NodeChildProcess.spawn(invocation.command, [...invocation.args], {
    cwd: options.cwd,
    env: options.env,
    shell: invocation.shell,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`${options.failureLabel}: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });

  return child;
}
