#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off preferSchemaOverJson:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_TERMINAL_ID, type TerminalAttachStreamEvent } from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import * as NodePtyAdapter from "../src/terminal/NodePtyAdapter.ts";
import * as PtyAdapter from "../src/terminal/PtyAdapter.ts";
import { terminalDirectoryObservationCapability } from "../src/terminal/DirectoryObservation.ts";
import * as TerminalManager from "../src/terminal/Manager.ts";
import * as ProcessRunner from "../src/processRunner.ts";

const TERMINAL_ID = DEFAULT_TERMINAL_ID;
const RESIZED_COLS = 100;
const RESIZED_ROWS = 32;
const WAIT_TIMEOUT_MS = 8_000;

const runtimeLayer = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  NodePtyAdapter.layer.pipe(Layer.provide(NodeServices.layer)),
);

function currentShell(): string {
  return (
    NodeProcess.env.SHELL?.trim() ||
    (NodeProcess.platform === "win32" ? (NodeProcess.env.ComSpec ?? "pwsh.exe") : "/bin/sh")
  );
}

function nodeCommand(code: string): string {
  const encoded = Buffer.from(code, "utf8").toString("base64");
  if (NodeProcess.platform === "win32") {
    return `node -e "eval(Buffer.from('${encoded}','base64').toString())"\r\n`;
  }
  return `node -e 'eval(Buffer.from("${encoded}","base64").toString())'\n`;
}

function outputText(events: ReadonlyArray<TerminalAttachStreamEvent>): string {
  return events
    .filter((event): event is Extract<TerminalAttachStreamEvent, { type: "output" }> => {
      return event.type === "output";
    })
    .map((event) => event.data)
    .join("");
}

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "awen-c04-terminal-"));
  const logsDir = NodePath.join(baseDir, "userdata", "logs", "terminals");
  const followDir = NodePath.join(baseDir, "follow-target");
  await NodeFSP.mkdir(followDir, { recursive: true });
  const shell = currentShell();
  const directoryObservationSupported = terminalDirectoryObservationCapability(
    NodeProcess.platform,
  ).supported;
  const runtime = ManagedRuntime.make(runtimeLayer);
  const events: TerminalAttachStreamEvent[] = [];

  try {
    const result = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ptyAdapter = yield* PtyAdapter.PtyAdapter;
          const manager = yield* TerminalManager.makeWithOptions({
            logsDir,
            ptyAdapter,
            shellResolver: () => shell,
            processKillGraceMs: 100,
            // The smoke is about the PTY lifecycle. Avoid making process-table
            // discovery a second host prerequisite for the validation.
            subprocessInspector: () =>
              Effect.succeed({
                hasRunningSubprocess: false,
                childCommand: null,
                processIds: [],
              }),
            // Registered Workspaces for the real-shell directory-following
            // scenario; harmless where directory observation is unsupported.
            listRegisteredWorkspaceDirectories: () =>
              Effect.succeed([
                { workspaceId: "smoke-origin", workspaceRoot: baseDir },
                { workspaceId: "smoke-target", workspaceRoot: followDir },
              ]),
          });

          const openInput = {
            terminalId: TERMINAL_ID,
            workspaceId: "smoke-origin",
            cwd: baseDir,
            cols: 80,
            rows: 24,
          } as const;

          const unsubscribe = yield* manager.attachStream(openInput, (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

          const firstSnapshot = events.find((event) => event.type === "snapshot")?.snapshot;
          assert(firstSnapshot?.status === "running", "The real PTY did not enter running state.");
          assert(
            typeof firstSnapshot.pid === "number",
            "The running terminal did not expose a process id.",
          );
          const firstPid = firstSnapshot.pid;

          const visualPayload =
            "\u001b[31mAWEN_RED\u001b[0m\n中文\n" +
            "\u001b[?1049h\u001b[2J\u001b[HAWEN_ALT\u001b[?1049l\n";
          yield* manager.write({
            terminalId: TERMINAL_ID,
            data: nodeCommand(
              `process.stdout.write(Buffer.from(${JSON.stringify(
                Buffer.from(visualPayload, "utf8").toString("base64"),
              )}, "base64"))`,
            ),
          });
          yield* Effect.promise(() =>
            waitFor("ANSI, alternate-screen, and Unicode output", () => {
              const output = outputText(events);
              return (
                output.includes("AWEN_RED") &&
                output.includes("中文") &&
                output.includes("AWEN_ALT") &&
                output.includes("\u001b[31m") &&
                output.includes("\u001b[?1049h") &&
                output.includes("\u001b[2J") &&
                output.includes("\u001b[H") &&
                output.includes("\u001b[?1049l")
              );
            }),
          );

          const fullScreenProgram = [
            "process.stdin.setRawMode?.(true)",
            "process.stdin.resume()",
            "process.stdout.write('\\u001b[?1049h\\u001b[2J\\u001b[HAWEN_FULL_SCREEN\\n')",
            "process.stdin.once('data',()=>{process.stdout.write('\\u001b[?1049l\\u001b[2J\\u001b[HAWEN_FULL_SCREEN_RESTORED\\n');process.exit(0)})",
          ].join(";");
          yield* manager.write({
            terminalId: TERMINAL_ID,
            data: nodeCommand(fullScreenProgram),
          });
          yield* Effect.promise(() =>
            waitFor("interactive full-screen program startup", () => {
              const output = outputText(events);
              return output.includes("AWEN_FULL_SCREEN") && output.includes("\u001b[?1049h");
            }),
          );
          yield* manager.write({
            terminalId: TERMINAL_ID,
            data: "x",
          });
          yield* Effect.promise(() =>
            waitFor("interactive full-screen program exit and screen restore", () => {
              const output = outputText(events);
              return (
                output.includes("AWEN_FULL_SCREEN_RESTORED") && output.includes("\u001b[?1049l")
              );
            }),
          );
          yield* manager.write({
            terminalId: TERMINAL_ID,
            data: nodeCommand("process.stdout.write('AWEN_AFTER_FULLSCREEN\\n')"),
          });
          yield* Effect.promise(() =>
            waitFor("shell output after full-screen program", () =>
              outputText(events).includes("AWEN_AFTER_FULLSCREEN"),
            ),
          );

          yield* manager.resize({
            terminalId: TERMINAL_ID,
            cols: RESIZED_COLS,
            rows: RESIZED_ROWS,
          });
          yield* manager.write({
            terminalId: TERMINAL_ID,
            data: nodeCommand(
              "process.stdout.write(`AWEN_SIZE:${process.stdout.rows} ${process.stdout.columns}:AWEN_SIZE_END\\n`)",
            ),
          });
          yield* Effect.promise(() =>
            waitFor("shell-visible PTY resize", () =>
              outputText(events).includes(
                `AWEN_SIZE:${RESIZED_ROWS} ${RESIZED_COLS}:AWEN_SIZE_END`,
              ),
            ),
          );

          unsubscribe();
          const detachedMarker = "AWEN_DETACHED_OUTPUT";

          // Real-shell directory following: `cd` reprojects the assignment while
          // the PTY and its output stream stay intact.
          let followedDirectory = false;
          if (directoryObservationSupported) {
            const readAssignment = () =>
              Effect.map(manager.getMetadata(), (metadata) =>
                metadata.find((summary) => summary.terminalId === TERMINAL_ID),
              );
            const waitForAssignment = (workspaceId: string, action: string) =>
              Effect.gen(function* () {
                for (let attempt = 0; attempt < WAIT_TIMEOUT_MS / 50; attempt += 1) {
                  const summary = yield* readAssignment();
                  if (summary?.workspaceId === workspaceId) return summary;
                  yield* Effect.sleep("50 millis");
                }
                return yield* Effect.die(
                  new Error(`The real shell did not ${action} the terminal to ${workspaceId}.`),
                );
              });

            yield* manager.write({
              terminalId: TERMINAL_ID,
              data: `cd ${JSON.stringify(followDir)}\n`,
            });
            const moved = yield* waitForAssignment("smoke-target", "move");
            assert(moved.pid === firstPid, "Following the shell directory restarted the PTY.");

            yield* manager.write({
              terminalId: TERMINAL_ID,
              data: nodeCommand("process.stdout.write('AWEN_AFTER_CD\\n')"),
            });
            yield* Effect.promise(() =>
              waitFor("output continuity after the shell moved", () =>
                outputText(events).includes("AWEN_AFTER_CD"),
              ),
            );

            yield* manager.write({
              terminalId: TERMINAL_ID,
              data: `cd ${JSON.stringify(baseDir)}\n`,
            });
            const returned = yield* waitForAssignment("smoke-origin", "return");
            assert(returned.pid === firstPid, "Returning the shell directory restarted the PTY.");
            followedDirectory = true;
          }

          yield* manager.write({
            terminalId: TERMINAL_ID,
            data: nodeCommand(`process.stdout.write(${JSON.stringify(`${detachedMarker}\n`)})`),
          });
          const detachedSnapshot = yield* Effect.gen(function* () {
            for (let attempt = 0; attempt < WAIT_TIMEOUT_MS / 25; attempt += 1) {
              const snapshot = yield* manager.open(openInput);
              if (snapshot.history.includes(detachedMarker)) return snapshot;
              yield* Effect.sleep("25 millis");
            }
            return yield* Effect.die(new Error("Detached terminal output did not reach history."));
          });
          assert(detachedSnapshot.pid === firstPid, "Opening while detached spawned a new PTY.");

          const reattachedEvents: TerminalAttachStreamEvent[] = [];
          const reattach = yield* manager.attachStream(openInput, (event) =>
            Effect.sync(() => {
              reattachedEvents.push(event);
            }),
          );
          yield* Effect.addFinalizer(() => Effect.sync(reattach));
          const reattachedSnapshot = reattachedEvents.find((event) => event.type === "snapshot");
          assert(
            reattachedSnapshot?.snapshot.pid === firstPid,
            "Attaching after disconnect did not reuse the same PTY.",
          );
          assert(
            reattachedSnapshot.snapshot.history.includes(detachedMarker),
            "Attaching after disconnect did not restore retained history.",
          );

          yield* manager.write({
            terminalId: TERMINAL_ID,
            data: nodeCommand("process.stdout.write('AWEN_LIVE_AFTER_ATTACH\\n')"),
          });
          yield* Effect.promise(() =>
            waitFor("live output after reattach", () =>
              outputText(reattachedEvents).includes("AWEN_LIVE_AFTER_ATTACH"),
            ),
          );

          yield* manager.write({
            terminalId: TERMINAL_ID,
            data: "exit 7\n",
          });
          yield* Effect.promise(() =>
            waitFor("the shell exit event", () =>
              reattachedEvents.some((event) => event.type === "exited" && event.exitCode === 7),
            ),
          );
          const exitEvent = reattachedEvents.find((event) => event.type === "exited");
          assert(
            exitEvent?.type === "exited" && exitEvent.exitCode === 7,
            "Shell exit code was lost.",
          );

          yield* manager.close({
            terminalId: TERMINAL_ID,
            deleteHistory: true,
          });

          const invalidError = yield* Effect.flip(
            manager.open({
              terminalId: "invalid-cwd",
              cwd: NodePath.join(baseDir, "missing-cwd"),
            }),
          );
          assert(
            invalidError._tag === "TerminalCwdNotFoundError",
            "Invalid cwd did not produce a structured cwd error.",
          );

          return { firstPid, followedDirectory, invalidError: invalidError.message };
        }),
      ).pipe(Effect.provide(runtimeLayer)),
    );

    console.log(`C04 terminal smoke passed on ${NodeProcess.platform} using ${shell}.`);
    console.log(
      `Verified: real PTY pid ${result.firstPid}, resize ${RESIZED_COLS}x${RESIZED_ROWS}, shell exit 7.`,
    );
    console.log(
      "Verified: ANSI color, alternate screen, Chinese output, detach/attach history, and invalid cwd error.",
    );
    console.log(
      result.followedDirectory
        ? "Verified: a real shell `cd` reprojected the Workspace assignment without restarting the PTY or interrupting output."
        : `Skipped: directory following is unsupported on ${NodeProcess.platform}; the assignment is retained.`,
    );
  } finally {
    await runtime.dispose();
    await NodeFSP.rm(baseDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    NodeProcess.exit(1);
  });
}
