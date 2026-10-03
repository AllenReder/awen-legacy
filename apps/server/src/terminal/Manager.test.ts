import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  TerminalProviderInstanceNotFoundError,
} from "@awen/contracts";
import { HostProcessPlatform } from "@awen/shared/hostProcess";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import type {
  TerminalDirectoryObservation,
  TerminalDirectoryObserver,
} from "./DirectoryObservation.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  writeFailure: unknown | undefined;
  resizeFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  killed = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure;
    }
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeFailure !== undefined) {
      throw this.resizeFailure;
    }
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({
          adapter: "fake",
          shell: input.shell,
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

const historyLogPath = (logsDir: string, terminalId = DEFAULT_TERMINAL_ID) =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => join(logsDir, `${Encoding.encodeBase64Url(terminalId)}.log`)),
  );

interface CreateManagerOptions {
  logsDir?: string;
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["subprocessInspector"];
  directoryObserver?: Parameters<typeof TerminalManager.makeWithOptions>[0]["directoryObserver"];
  listRegisteredWorkspaceDirectories?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["listRegisteredWorkspaceDirectories"];
  processTable?: Effect.Effect<
    ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly name: string }>,
    never
  >;
  subprocessPollIntervalMs?: number;
  directoryPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  historyByteLimit?: number;
  ptyAdapter?: FakePtyAdapter;
  resolveProviderInstanceEnvironment?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["resolveProviderInstanceEnvironment"];
  resolveWorkspaceRoot?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["resolveWorkspaceRoot"];
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProcessRunner.ProcessRunner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "awen-terminal-" });
      const logsDir = options.logsDir ?? join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.historyByteLimit !== undefined
          ? { historyByteLimit: options.historyByteLimit }
          : {}),
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.directoryObserver !== undefined
          ? { directoryObserver: options.directoryObserver }
          : {}),
        ...(options.listRegisteredWorkspaceDirectories !== undefined
          ? { listRegisteredWorkspaceDirectories: options.listRegisteredWorkspaceDirectories }
          : {}),
        ...(options.processTable !== undefined ? { processTable: options.processTable } : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        ...(options.directoryPollIntervalMs !== undefined
          ? { directoryPollIntervalMs: options.directoryPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.resolveProviderInstanceEnvironment !== undefined
          ? { resolveProviderInstanceEnvironment: options.resolveProviderInstanceEnvironment }
          : {}),
        ...(options.resolveWorkspaceRoot !== undefined
          ? { resolveWorkspaceRoot: options.resolveWorkspaceRoot }
          : {}),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

const idleInspect = () =>
  Effect.succeed({
    hasRunningSubprocess: false,
    childCommand: null,
    processIds: [],
  });

const fakeDirectoryObserver = (read: () => string | null): TerminalDirectoryObserver => ({
  capability: { supported: true, mechanism: "procfs" },
  observe: (): Effect.Effect<TerminalDirectoryObservation> => {
    const directory = read();
    return Effect.succeed(
      directory === null
        ? { kind: "unknown", reason: "unavailable" }
        : { kind: "known", directory },
    );
  },
});

const withHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

// Apply the existing line policy, then find the longest code-point-aligned byte tail.
function retainedHistory(text: string, maxLines: number, maxBytes = Infinity): string {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const retained = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  const capped = terminated ? `${retained}\n` : retained;
  if (Buffer.byteLength(capped) <= maxBytes) return capped;
  const points = Array.from(capped);
  let start = points.length;
  let bytes = 0;
  while (start > 0) {
    const next = Buffer.byteLength(points[start - 1]!);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  return points.slice(start).join("");
}

it("preserves line and byte limits across arbitrary chunks, Unicode, ANSI sequences, and clear", () => {
  let randomSeed = 0x20260904;
  const fragments = [
    "",
    "a",
    "\n",
    "\n\n",
    "\r",
    "\r\n",
    "café",
    "名",
    "🚀",
    "\u001b[31m",
    "\u001b[0m",
    "\u001b]8;;url\u0007",
    "\ud83d",
    "\ude80",
  ];
  const nextFragment = () => {
    randomSeed = (Math.imul(randomSeed, 1_664_525) + 1_013_904_223) >>> 0;
    return fragments[randomSeed % fragments.length]!;
  };

  for (const maxBytes of [0, 3, 8, 64, Infinity]) {
    for (const maxLines of [0, 1, 3, 5, 5_000]) {
      let expected = retainedHistory("before\ninitial\n", maxLines, maxBytes);
      const history = new TerminalManager.BoundedTerminalHistory(
        maxLines,
        "before\ninitial\n",
        maxBytes,
      );
      expect(history.value()).toBe(expected);

      for (let step = 0; step < 300; step += 1) {
        if (step % 73 === 0) {
          history.clear();
          expected = "";
          expect(history.value()).toBe(expected);
        }
        const chunk = nextFragment() + nextFragment();
        history.append(chunk);
        expected = retainedHistory(expected + chunk, maxLines, maxBytes);
        expect(history.value()).toBe(expected);
      }
    }
  }
});

it("bounds long partial lines and joins surrogate pairs across chunk boundaries", () => {
  const maxBytes = 65_539;
  let expected = "";
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", maxBytes);
  const writes = [
    "a".repeat(16_383) + "😀" + "b".repeat(70_000),
    "\r" + "c".repeat(70_000) + "\ud83d",
    "\ude80" + "d".repeat(100),
    "\uFEFF" + "名".repeat(30_000),
  ];
  for (const text of writes) {
    history.append(text);
    expected = retainedHistory(expected + text, 5_000, maxBytes);
    expect(history.value()).toBe(expected);
    expect(Buffer.byteLength(history.value())).toBeLessThanOrEqual(maxBytes);
  }
});

it("preserves retained lines as older storage is compacted", () => {
  for (const maxLines of [3, 5_000]) {
    let expected = "";
    const history = new TerminalManager.BoundedTerminalHistory(maxLines, expected);
    for (let batch = 0; batch < 40; batch += 1) {
      const chunk = Array.from({ length: 300 }, (_, line) => `${batch}:${line}\n`).join("");
      history.append(chunk);
      expected = retainedHistory(expected + chunk, maxLines);
      expect(history.value()).toBe(expected);
    }
  }
});

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());
      assert.equal(first.terminalId, DEFAULT_TERMINAL_ID);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("creates a terminal for a Workspace without an Agent owner", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });

      const opened = yield* manager.open({
        workspaceId: "workspace-zero-agent",
        terminalId: "term-1",
      });

      expect(opened.workspaceId).toBe("workspace-zero-agent");
      expect(opened.kind).toBe("terminal");
      expect(opened.generation).toBe(1);
      expect(opened.cwd).toBe(process.cwd());
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.spawnInputs[0]?.cwd).toBe(process.cwd());
    }),
  );

  it.effect("attaches Workspace terminals without creating a second PTY", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });
      yield* manager.open({ workspaceId: "workspace-attach", terminalId: "term-1" });

      const events = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        { workspaceId: "workspace-attach", terminalId: "term-1", cols: 100, rows: 24 },
        (event) => Ref.update(events, (current) => [...current, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(events)).find((event) => event.type === "snapshot");
      expect(snapshot?.type).toBe("snapshot");
      if (snapshot?.type === "snapshot") {
        expect(snapshot.snapshot.workspaceId).toBe("workspace-attach");
        expect(snapshot.snapshot.generation).toBe(1);
      }
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("fails workspace open distinctly when no workspace resolver is wired", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();

      const error = yield* Effect.flip(
        manager.open({ workspaceId: "workspace-no-resolver", terminalId: "term-1" }),
      );

      // Must not be confused with TerminalWorkspaceNotFoundError: the
      // workspace may exist — this manager cannot resolve any workspace.
      expect(error).toMatchObject({
        _tag: "TerminalWorkspaceResolutionUnavailableError",
        workspaceId: "workspace-no-resolver",
      });
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("keeps two Workspace terminal sessions independent", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });
      yield* manager.open({ workspaceId: "workspace-a", terminalId: "term-a" });
      yield* manager.open({ workspaceId: "workspace-b", terminalId: "term-b" });

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ workspaceId: "workspace-a", terminalId: "term-a", data: "a" });
      yield* manager.write({ workspaceId: "workspace-b", terminalId: "term-b", data: "b" });
      expect(first.writes).toEqual(["a"]);
      expect(second.writes).toEqual(["b"]);

      yield* manager.close({ workspaceId: "workspace-a", terminalId: "term-a" });
      expect(second.killed).toBe(false);
    }),
  );

  it.effect("addresses one terminal by its stable id across Workspace assignments", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });
      const first = yield* manager.open({ workspaceId: "workspace-a", terminalId: "term-1" });
      const second = yield* manager.open({ workspaceId: "workspace-b", terminalId: "term-1" });

      // The Workspace is a mutable assignment, not a lookup key: the same
      // terminal id resolves to the same Session and never spawns a second PTY.
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.terminalId).toBe(first.terminalId);
      expect(second.workspaceId).toBe("workspace-b");
      expect(second.pid).toBe(first.pid);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("keeps the PTY running with no subscribers and reattaches the same instance", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const opened = yield* manager.open(openInput());

      const firstEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(firstEvents, (events) => [...events, event]),
      );
      unsubscribe();

      // With no listeners the daemon still owns the live PTY and accepts input.
      yield* manager.write({ terminalId: DEFAULT_TERMINAL_ID, data: "still alive\n" });

      const reattachedEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const reattach = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(reattachedEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(reattach));

      const snapshot = (yield* Ref.get(reattachedEvents)).find(
        (event) => event.type === "snapshot",
      );
      expect(snapshot?.type).toBe("snapshot");
      if (snapshot?.type === "snapshot") {
        expect(snapshot.snapshot.pid).toBe(opened.pid);
        expect(snapshot.snapshot.status).toBe("running");
      }
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("keeps Workspace Terminal Session identity and history when restarting its PTY", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });
      const input = { workspaceId: "workspace-restart", terminalId: "term-1" };
      const opened = yield* manager.open(input);
      ptyAdapter.processes[0]!.emitData("retained work\r\n");
      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "output")),
      );
      const restarted = yield* manager.restart({ ...input, cols: 80, rows: 24 });
      expect(restarted.sessionId).toBe("term-1");
      expect(restarted.sessionId).toBe(opened.sessionId);
      expect(restarted.history).toContain("retained work");
      expect(restarted.generation).toBe(2);
      expect(restarted.pid).not.toBe(opened.pid);
    }),
  );

  it.effect("still terminates Workspace PTYs when the shutdown history write fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ptyAdapter = new FakePtyAdapter();
      let failWrites = false;
      const failingFs = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (path, contents, options) =>
          failWrites && path.endsWith(".log")
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "writeFileString",
                    description: "Disk full",
                  }),
                ),
              )
            : fs.writeFileString(path, contents, options),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { manager } = yield* createManager(5, {
            ptyAdapter,
            resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
          });
          yield* manager.open({ workspaceId: "workspace", terminalId: "terminal" });
          failWrites = true;
        }).pipe(Effect.provideService(FileSystem.FileSystem, failingFs)),
      );
      expect(ptyAdapter.processes[0]?.killSignals).toContain("SIGKILL");
    }),
  );

  it.effect(
    "retains stopped Workspace Sessions beyond the runtime cache limit across reconnect",
    () =>
      Effect.gen(function* () {
        const first = yield* createManager(5, {
          maxRetainedInactiveSessions: 1,
          resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
        });
        for (const terminalId of ["one", "two"]) {
          yield* first.manager.open({ workspaceId: "workspace", terminalId });
          first.ptyAdapter.processes.at(-1)!.emitExit({ exitCode: 0, signal: 0 });
          yield* waitFor(
            Effect.map(first.getEvents, (events) =>
              events.some((event) => event.type === "exited" && event.terminalId === terminalId),
            ),
          );
        }
        yield* first.manager.open({ workspaceId: "workspace", terminalId: "three" });
        expect(
          (yield* first.manager.getMetadata()).map((session) => session.terminalId).sort(),
        ).toEqual(["one", "three", "two"]);
        const second = yield* createManager(5, {
          logsDir: first.logsDir,
          resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
        });
        expect(
          (yield* second.manager.getMetadata()).map((session) => session.terminalId).sort(),
        ).toEqual(["one", "three", "two"]);
      }),
  );

  it.effect("flushes active Workspace terminal history on daemon shutdown before reconnect", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "awen-terminal-reconnect-" });
      const input = { workspaceId: "workspace-live", terminalId: "session-unique" };
      const opened = yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* createManager(5, {
            logsDir,
            resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
          });
          const opened = yield* first.manager.open(input);
          first.ptyAdapter.processes[0]!.emitData("last output before shutdown\r\n");
          yield* waitFor(
            Effect.map(first.getEvents, (events) =>
              events.some((event) => event.type === "output"),
            ),
          );
          return opened;
        }),
      );
      const second = yield* createManager(5, {
        logsDir,
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });
      const resumed = yield* second.manager.open(input);
      expect(resumed.sessionId).toBe(opened.sessionId);
      expect(resumed.createdAt).toBe(opened.createdAt);
      expect(resumed.history).toContain("last output before shutdown");
    }),
  );

  it.effect("persists Workspace identity and marks an old PTY exited after daemon restart", () =>
    Effect.gen(function* () {
      const first = yield* createManager(5, {
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });
      const opened = yield* first.manager.open({
        workspaceId: "workspace-restart",
        terminalId: "term-1",
      });
      expect(opened.createdAt).toBeDefined();
      const ptyProcess = first.ptyAdapter.processes[0];
      expect(ptyProcess).toBeDefined();
      if (!ptyProcess) return;
      ptyProcess.emitData("work before reconnect\r\n");
      yield* waitFor(
        Effect.map(first.getEvents, (events) => events.some((event) => event.type === "output")),
      );
      ptyProcess.emitExit({ exitCode: 0, signal: 0 });
      yield* waitFor(
        Effect.map(first.getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      yield* Effect.sleep("25 millis");

      const second = yield* createManager(5, {
        logsDir: first.logsDir,
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });
      const attached = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* second.manager.attachStream(
        { workspaceId: "workspace-restart", terminalId: "term-1" },
        (event) => Ref.update(attached, (current) => [...current, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const snapshot = (yield* Ref.get(attached)).find((event) => event.type === "snapshot");
      expect(snapshot?.type).toBe("snapshot");
      if (snapshot?.type === "snapshot") {
        expect(snapshot.snapshot.sessionId).toBe(opened.sessionId);
        expect(snapshot.snapshot.createdAt).toBe(opened.createdAt);
        expect(snapshot.snapshot.history).toContain("work before reconnect");
        expect(snapshot.snapshot.status).toBe("exited");
        expect(snapshot.snapshot.generation).toBe(1);
        expect(snapshot.snapshot.workspaceId).toBe("workspace-restart");
      }
      expect(second.ptyAdapter.spawnInputs).toHaveLength(0);

      const restarted = yield* second.manager.open({
        workspaceId: "workspace-restart",
        terminalId: "term-1",
      });
      expect(restarted.sessionId).toBe(opened.sessionId);
      expect(restarted.createdAt).toBe(opened.createdAt);
      expect(restarted.history).toContain("work before reconnect");
      expect(restarted.status).toBe("running");
      expect(restarted.generation).toBe(2);
      expect(second.ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("attaches to running sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();

      yield* manager.open(openInput());
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 100,
          rows: 40,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.terminalId, DEFAULT_TERMINAL_ID);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("keeps attach streams live when a terminal id is closed and reopened", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.close({
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.open(openInput());

      const events = yield* Ref.get(attachEvents);
      expect(events.map((event) => event.type)).toEqual(["snapshot", "closed", "snapshot"]);
      expect(
        events.filter((event) => event.type === "snapshot").map((event) => event.snapshot.status),
      ).toEqual(["running", "running"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("attaches to exited sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        openInput({
          env: {
            AWEN_WORKTREE_PATH: "/tmp/should-not-restart",
          },
          worktreePath: "/tmp/should-not-restart",
        }),
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "exited");
      assert.equal(snapshot.snapshot.worktreePath, null);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("restarts inactive sessions from attach only when requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          ...openInput({
            env: {
              AWEN_WORKTREE_PATH: "/tmp/restart-requested",
            },
            worktreePath: "/tmp/restart-requested",
          }),
          restartIfNotRunning: true,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "running");
      assert.equal(snapshot.snapshot.worktreePath, "/tmp/restart-requested");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  it.effect("reports a missing cwd without an artificial cause", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "missing-cwd");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotFoundError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("reports a cwd that is not a directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "cwd-file");
      yield* writeFileString(cwd, "not a directory");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotDirectoryError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      if (typeof process.getuid === "function" && process.getuid() === 0) return;

      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdStatError",
        cwd: blockedCwd,
        cause: {
          _tag: "PlatformError",
        },
      });
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("preserves structured context and causes for PTY I/O failures", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const writeCause = new Error("PTY input handle is unavailable");
      process.writeFailure = writeCause;
      const writeError = yield* Effect.flip(
        manager.write({
          terminalId: DEFAULT_TERMINAL_ID,
          data: "secret input that must not be attached to the error",
        }),
      );

      expect(writeError).toMatchObject({
        _tag: "TerminalWriteError",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
      });
      expect(writeError.cause).toBe(writeCause);
      expect(writeError).not.toHaveProperty("data");

      const resizeCause = new Error("PTY resize handle is unavailable");
      process.resizeFailure = resizeCause;
      const resizeError = yield* Effect.flip(
        manager.resize({
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 132,
          rows: 40,
        }),
      );

      expect(resizeError).toMatchObject({
        _tag: "TerminalResizeError",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
        cols: 132,
        rows: 40,
      });
      expect(resizeError.cause).toBe(resizeCause);

      process.resizeFailure = undefined;
      yield* manager.open(openInput({ cols: 132, rows: 40 }));
      expect(process.resizeCalls).toEqual([{ cols: 132, rows: 40 }]);
    }),
  );

  it.effect("ignores delayed resize requests after a terminal closes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.close({
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.resize({
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.resizeCalls).toEqual([]);
    }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ terminalId: "default", data: "pwd\n" });
      yield* manager.write({ terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* manager.clear({ terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) => event.type === "cleared" && event.terminalId === DEFAULT_TERMINAL_ID,
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts terminal while preserving its durable history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "before restart\n");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === "before restart\n"),
        ),
      );
    }),
  );

  it.effect("restarts a running session when open is called with a different cwd", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const originalCwd = path.join(baseDir, "original");
      const differentCwd = path.join(baseDir, "different");
      yield* makeDirectory(originalCwd);
      yield* makeDirectory(differentCwd);

      yield* manager.open(openInput({ cwd: originalCwd }));
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;

      firstProcess.emitData("before reopen\n");
      const logPath = yield* historyLogPath(logsDir);
      yield* waitFor(pathExists(logPath));

      const reopened = yield* manager.open(openInput({ cwd: differentCwd }));

      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      assert.equal(firstProcess.killed, true);
      assert.equal(reopened.cwd, differentCwd);
      assert.equal(reopened.history, "before reopen\n");
      yield* waitFor(Effect.map(readFileString(logPath), (text) => text === "before reopen\n"));
    }),
  );

  it.effect("propagates explicit worktree metadata through snapshots and lifecycle events", () =>
    Effect.gen(function* () {
      const { manager, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const firstWorktreePath = path.join(baseDir, "worktrees", "feature-a");
      const secondWorktreePath = path.join(baseDir, "worktrees", "feature-b");
      yield* makeDirectory(firstWorktreePath);
      yield* makeDirectory(secondWorktreePath);
      const startedSnapshot = yield* manager.open(
        openInput({
          cwd: firstWorktreePath,
          worktreePath: firstWorktreePath,
        }),
      );
      const restartedSnapshot = yield* manager.restart(
        restartInput({
          cwd: secondWorktreePath,
          worktreePath: secondWorktreePath,
        }),
      );

      assert.equal(startedSnapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedSnapshot.worktreePath, secondWorktreePath);

      const events = yield* getEvents;
      const startedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
      );
      const restartedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "restarted" }> =>
          event.type === "restarted",
      );

      assert.equal(startedEvent?.snapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedEvent?.snapshot.worktreePath, secondWorktreePath);
    }),
  );

  it.effect("preserves worktree metadata when reopening an exited session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const worktreePath = path.join(baseDir, "worktrees", "feature-a");
      yield* makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const reopenedSnapshot = yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      assert.equal(reopenedSnapshot.worktreePath, worktreePath);

      const events = yield* getEvents;
      const reopenedEvent = events
        .toReversed()
        .find(
          (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
        );

      assert.equal(reopenedEvent?.snapshot.worktreePath, worktreePath);
    }),
  );

  it.effect("emits exited event and reopens with retained transcript after exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput());

      assert.equal(reopened.history, "old data\n");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
        ),
      ).toBe("old data\n");
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      const { manager, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

      inspect = { hasRunningSubprocess: true, childCommand: "vim", processIds: [100, 101] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      inspect = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === false &&
              event.label === "Terminal 1",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager } = yield* createManager(5, {
        subprocessInspector: () => {
          checks += 1;
          return Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          });
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => checks > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("derives subprocess activity for every terminal from one shared process snapshot", () =>
    Effect.gen(function* () {
      const runCalls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      // FakePtyAdapter assigns pids starting at 9000, so the two terminals
      // opened below run as pids 9000 and 9001.
      const psStdout = ["  100  9000 vim", "  101   100 git", "  200  9001 /usr/bin/python3"].join(
        "\n",
      );
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.sync(() => {
            runCalls.push({ command: input.command, args: input.args });
            return {
              stdout: psStdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(withHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* manager.open(openInput({ terminalId: "term-2" }));

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) =>
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "vim",
            ) &&
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "python3",
            ),
        ),
        "1200 millis",
      );
      yield* waitFor(
        Effect.sync(() => runCalls.length >= 3),
        "1200 millis",
      );

      // Every spawn is the shared table snapshot — no per-terminal `pgrep`
      // or per-child `ps -p` invocations.
      expect(runCalls.every((call) => call.args.join(" ") === "-eo pid=,ppid=,args=")).toBe(true);
    }),
  );

  it.effect("keeps last known subprocess state when the process snapshot fails", () =>
    Effect.gen(function* () {
      let failSnapshots = false;
      let failedCalls = 0;
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Effect.sync(() => {
            if (failSnapshots) failedCalls += 1;
            return {
              stdout: failSnapshots ? "" : "  100  9000 vim",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(failSnapshots ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(withHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      failSnapshots = true;
      yield* waitFor(
        Effect.sync(() => failedCalls >= 3),
        "1200 millis",
      );

      // A failed snapshot is not authoritative: no terminal flips to idle.
      const activityEvents = (yield* getEvents).filter((event) => event.type === "activity");
      expect(activityEvents.length).toBeGreaterThan(0);
      expect(activityEvents.every((event) => event.hasRunningSubprocess === true)).toBe(true);
    }),
  );

  it("calculates snapshot failure backoff and success reset delays", () => {
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 0), 1_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 1), 2_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 2), 4_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 30), 60_000);
  });

  it.effect("uses process snapshots from the resource monitor", () =>
    Effect.gen(function* () {
      let snapshotCalls = 0;
      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.sync(() => {
          snapshotCalls += 1;
          return [{ pid: 100, ppid: 9000, name: "ping.exe" }];
        }),
      }).pipe(Effect.provide(withHostPlatform("win32")));

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" && event.hasRunningSubprocess && event.label === "ping",
          ),
        ),
        "1200 millis",
      );
      expect(snapshotCalls).toBeGreaterThan(0);
    }),
  );

  it.effect("backs off the spawned fallback when the resource monitor snapshot fails", () =>
    Effect.gen(function* () {
      const fallbackCalls: Array<number> = [];
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              fallbackCalls.push(now);
              return {
                stdout: "  100  9000 vim",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrInvalidUtf8: false,
                stdoutInvalidUtf8: false,
                stderrTruncated: false,
              };
            }),
          ),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.fail("sidecar unavailable").pipe(
          Effect.mapError((cause) => cause as never),
        ),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(withHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      // The fallback data is still applied while the sidecar is down.
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      yield* waitFor(
        Effect.sync(() => fallbackCalls.length >= 4),
        "2000 millis",
      );
      // Four snapshots at the 20 ms base cadence would span ~60 ms. Backoff
      // (40 + 80 + 160 ms) stretches the same four snapshots past 150 ms, so
      // a stalled sidecar no longer hot-loops the spawned fallback.
      const spanMs = fallbackCalls[3]! - fallbackCalls[0]!;
      expect(spanMs).toBeGreaterThan(150);
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
    }),
  );

  it.effect("caps incrementally appended history without losing partial or empty lines", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\n");
      process.emitData("\n");
      process.emitData("line3");
      process.emitData("-continued\nline4");
      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history).toBe("\nline3-continued\nline4");
    }),
  );

  it.effect("bounds persisted and attached history without truncating live output", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(5, { historyByteLimit: 10 });
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const writes = ["a".repeat(32), "😀\rEND"];
      const process = ptyAdapter.processes[0]!;
      for (const text of writes) process.emitData(text);
      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });
      expect(yield* readFileString(yield* historyLogPath(logsDir))).toBe("aa😀\rEND");

      const reopened = yield* manager.open(openInput());
      const events = yield* Ref.get(attachEvents);
      expect(events.filter((event) => event.type === "output").map((event) => event.data)).toEqual(
        writes,
      );
      const snapshot = events.filter((event) => event.type === "snapshot").at(-1)?.snapshot;
      expect(snapshot?.history).toBe("aa😀\rEND");
      expect(snapshot?.sequence).toBe(reopened.sequence);
    }),
  );

  it.effect("reads only a Unicode-safe tail from oversized history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let sourcePath: string | undefined;
      let closedReads = 0;
      const readRequests: number[] = [];
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (candidate, encoding) =>
          candidate === sourcePath
            ? Effect.die("History restoration must not read the whole file")
            : fs.readFileString(candidate, encoding),
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate !== sourcePath) return yield* fs.open(candidate, options);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closedReads += 1;
              }),
            );
            const file = yield* fs.open(candidate, options);
            return new Proxy(file, {
              get(target, key) {
                if (key === "read") {
                  return (buffer: Uint8Array) => {
                    readRequests.push(buffer.byteLength);
                    return target.read(buffer.subarray(0, 5));
                  };
                }
                return Reflect.get(target, key, target);
              },
            });
          }),
      });
      const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 15 }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );
      const nextPath = yield* historyLogPath(logsDir);
      sourcePath = nextPath;
      yield* fs.writeFileString(sourcePath, "old".repeat(32_768) + "😀\uFEFFnewest\ré");

      const snapshot = yield* manager.open(openInput());
      expect(snapshot.history).toBe("\uFEFFnewest\ré");
      expect(readRequests).toEqual([15, 10, 5]);
      expect(closedReads).toBe(1);
      expect(Buffer.from(yield* fs.readFile(nextPath)).toString()).toBe("\uFEFFnewest\ré");
      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });
      expect((yield* manager.open(openInput())).history).toBe("\uFEFFnewest\ré");
    }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
    }),
  );

  it.effect("strips replayable CSI and DCS traffic while preserving setters", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      // DECRQM/DECRPM, XTVERSION, and kitty-keyboard CSI query/reply traffic.
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u");
      // DECRQSS and XTGETTCAP query/reply traffic in 7-bit DCS form.
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      // The same DCS traffic in 8-bit form.
      process.emitData("\u0090$q m\u009c\u00901$r0m\u009c");
      process.emitData("\u0090+q544e\u009c\u00901+r544e=1b\u009c");
      // Setters and cursor movement share final bytes with query families but
      // have visible terminal-state value and must survive replay.
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u');
      process.emitData("done\n");

      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, 'prompt \u001b[!p\u001b["p\u001b[4 q\u001b[udone\n');
    }),
  );

  it.effect("handles CSI and DCS query sequences split across output chunks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b[?2026$");
      process.emitData("pafter ");
      process.emitData("\u001bP$q ");
      process.emitData("m\u001b");
      process.emitData("\\after ");
      process.emitData("\u009b?3");
      process.emitData("1uafter ");
      process.emitData("\u0090+q544e");
      process.emitData("\u009cafter\n");

      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before after after after after\n");
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID, deleteHistory: true });
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("closes each addressed terminal and deletes its history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir, "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* waitFor(
        historyLogPath(logsDir, "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ terminalId: "default", deleteHistory: true });
      yield* manager.close({ terminalId: "sidecar", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(
        yield* historyLogPath(logsDir, "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
      expect(
        yield* historyLogPath(logsDir, "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeFiber = yield* manager
        .close({ terminalId: DEFAULT_TERMINAL_ID })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("publishes closed events when terminals are explicitly closed", () =>
    Effect.gen(function* () {
      const { manager, getEvents } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));

      yield* manager.close({ terminalId: "default" });
      yield* manager.close({ terminalId: "sidecar" });

      const closedEvents = (yield* getEvents).filter(
        (event): event is Extract<TerminalEvent, { type: "closed" }> => event.type === "closed",
      );
      expect(closedEvents.map((event) => event.terminalId).sort()).toEqual(["default", "sidecar"]);
    }),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput());
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir, DEFAULT_TERMINAL_ID).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      first.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      const reopenedSecond = yield* manager.open(openInput({ terminalId: "term-2" }));
      const reopenedFirst = yield* manager.open(openInput());

      // An evicted terminal reloads its durable history; the retained one keeps
      // it in memory. Neither is re-keyed by its (absent) Workspace assignment.
      assert.equal(reopenedFirst.history, "first-history\n");
      assert.equal(reopenedSecond.history, "second-history\n");
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const missingShell =
        platform === "win32" ? "C:\\definitely\\missing-shell.exe" : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("reports every attempted shell when terminal startup cannot succeed", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const missingShell =
        platform === "win32" ? "C:\\definitely\\missing-shell.exe" : "/definitely/missing-shell";
      const ptyAdapter = new FakePtyAdapter();
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(
        ...Array.from({ length: 32 }, () => new Error("shell executable not found")),
      );

      const snapshot = yield* manager.open(openInput());
      const errorEvent = (yield* getEvents).find((event) => event.type === "error");

      expect(snapshot.status).toBe("error");
      expect(errorEvent).toMatchObject({
        type: "error",
        message: expect.stringContaining("Tried shells:"),
      });
    }),
  );

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(withHostPlatform("win32")));

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: ["-NoLogo"],
        }),
      );
    }),
  );

  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "C:\\missing\\custom-shell.exe",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(withHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-NoLogo"]);
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(["-NoLogo"]);
    }),
  );

  it.effect.each(["linux", "darwin", "win32"] as const)(
    "advertises truecolor before the PTY backend on %s without replacing explicit values",
    (platform) =>
      Effect.gen(function* () {
        for (const [parentColor, runtimeColor, expected] of [
          [undefined, undefined, "truecolor"],
          ["", undefined, "truecolor"],
          ["24bit", undefined, "24bit"],
          ["24bit", "", "truecolor"],
          ["24bit", "custom", "custom"],
        ] as const) {
          const env = Object.freeze({ COLORTERM: parentColor });
          const { manager, ptyAdapter } = yield* createManager(5, {
            shellResolver: () => "/bin/sh",
            env,
          }).pipe(Effect.provide(withHostPlatform(platform)));
          yield* manager.open(
            openInput({ env: runtimeColor === undefined ? {} : { COLORTERM: runtimeColor } }),
          );
          expect(ptyAdapter.spawnInputs[0]?.env.COLORTERM).toBe(expected);
          expect(env.COLORTERM).toBe(parentColor);
        }
      }),
  );

  it.effect("declares the PTY identity and drops an inherited COLORFGBG", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          // A stale host value is what made CLIs choose the wrong theme; the
          // renderer answers OSC 10/11/12 from the theme it actually paints.
          COLORFGBG: "0;15",
          TERM: "xterm-ghostty",
          TERM_PROGRAM: "ghostty",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      assert.ok(spawnInput);
      expect(spawnInput.env.COLORFGBG).toBeUndefined();
      expect(spawnInput.env.TERM).toBe("xterm-256color");
      expect(spawnInput.env.TERM_PROGRAM).toBe("awen");
    }),
  );

  it.effect("does not fabricate terminal protocol replies in the daemon", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      assert.ok(process);
      // The renderer owns these replies: only it knows the painted theme and
      // the real cursor. A daemon reply here would be a second, wrong answer.
      process.emitData("\x1b]11;?\x1b\\");
      process.emitData("\x1b[5n");
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PORT: "5173",
          AWEN_PORT: "3773",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.AWEN_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      // Arbitrary host env vars must pass through — terminals inherit the
      // user's environment apart from the explicit blocklist.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("expands provider home paths passed to setup terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5);

      yield* manager.open({
        ...openInput(),
        env: {
          CODEX_HOME: "~/.codex-work",
          CLAUDE_CONFIG_DIR: "~/.claude-work",
          CUSTOM_ACCOUNT: "~/leave-this-value-alone",
        },
      });

      const environment = ptyAdapter.spawnInputs[0]?.env;
      expect(environment?.CODEX_HOME).toMatch(/[\\/][.]codex-work$/);
      expect(environment?.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-work$/);
      expect(environment?.CUSTOM_ACCOUNT).toBe("~/leave-this-value-alone");
    }),
  );

  it.effect("strips AppImage runtime env from terminal sessions", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_Awenabc123";
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          APPIMAGE: "/home/user/Awen-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/user/Awen-Code.AppImage",
          OWD: "/home/user/project",
          PATH: `${appDir}/usr/bin:${appDir}:/usr/local/bin:/usr/bin:/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib:/home/user/.local/lib`,
          XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      // AppImage runtime markers must never reach the PTY — tools inside the
      // terminal otherwise resolve against the AppImage mount (e.g. PHP_BINARY
      // reporting the AppImage path instead of the real binary).
      expect(spawnInput.env.APPIMAGE).toBeUndefined();
      expect(spawnInput.env.APPDIR).toBeUndefined();
      expect(spawnInput.env.ARGV0).toBeUndefined();
      expect(spawnInput.env.OWD).toBeUndefined();
      // PATH/LD_LIBRARY_PATH keep the user's real entries but drop the AppImage
      // mount segments that the runtime prepended.
      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      // XDG_DATA_DIRS keeps the host entries but drops the AppImage share dir.
      expect(spawnInput.env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
      // GSETTINGS_SCHEMA_DIR pointed only at the mount, so it is removed and
      // gsettings falls back to the host schema location.
      expect(spawnInput.env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
      // Unrelated host vars still pass through untouched.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("leaves the environment untouched when not launched from an AppImage", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LD_LIBRARY_PATH: "/home/user/.local/lib",
          // Without APPIMAGE/APPDIR set, OWD is an ordinary variable and must
          // not be stripped — only an AppImage launch gives it special meaning.
          OWD: "/home/user/keep-this",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      expect(spawnInput.env.OWD).toBe("/home/user/keep-this");
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { env: { FORCE_COLOR: "3" } });
      yield* manager.open(
        openInput({
          env: {
            AWEN_PROJECT_ROOT: "/repo",
            AWEN_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.AWEN_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.AWEN_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
      assert.equal(spawnInput.env.NO_COLOR, "1");
      assert.equal(spawnInput.env.FORCE_COLOR, "0");
    }),
  );

  it.effect("resolves a provider instance environment before spawning", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { AWEN_SECRET: "server-only" },
        resolveProviderInstanceEnvironment: (requestedId, env) =>
          Effect.succeed({
            ...env,
            PROVIDER_SECRET: requestedId === providerInstanceId ? "secret-value" : "wrong",
            CODEX_HOME: "/accounts/codex-work",
          }),
      });

      const snapshot = yield* manager.open(
        openInput({ providerInstanceId, env: { CLIENT_FLAG: "1" } }),
      );

      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("secret-value");
      expect(ptyAdapter.spawnInputs[0]?.env.CODEX_HOME).toBe("/accounts/codex-work");
      expect(ptyAdapter.spawnInputs[0]?.env.CLIENT_FLAG).toBe("1");
      expect(ptyAdapter.spawnInputs[0]?.env.AWEN_SECRET).toBeUndefined();
      expect(snapshot).not.toHaveProperty("env");
      expect(snapshot).not.toHaveProperty("providerInstanceId");
    }),
  );

  it.effect("fails closed when a provider instance is missing", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager.open(openInput({ providerInstanceId })).pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("preserves the settings failure when provider environment resolution fails", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const settingsCause = new Error("secret store read failed");
      const settingsError = new ServerSettingsError({
        settingsPath: "/test/settings.json",
        operation: "read-secret",
        providerInstanceId,
        environmentVariable: "OPENROUTER_API_KEY",
        cause: settingsCause,
      });
      const serverSettings = ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.fail(settingsError),
        updateSettings: () => Effect.fail(settingsError),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      });

      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: providerInstanceId,
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderEnvironmentError",
        providerInstanceId,
      });
      expect(error.cause).toBe(settingsError);
      expect(error.message).not.toContain(settingsError.message);
      expect(error.message).not.toContain("OPENROUTER_API_KEY");
    }),
  );

  it.effect.each([
    {
      name: "Codex home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex" },
      expectedHome: "/configured/codex",
    },
    {
      name: "Codex shadow home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex", shadowHomePath: "/configured/codex-shadow" },
      expectedHome: "/configured/codex-shadow",
    },
    {
      name: "Claude home",
      driver: "claudeAgent",
      variable: "CLAUDE_CONFIG_DIR",
      config: { homePath: "/configured/claude" },
      expectedHome: "/configured/claude",
    },
  ])("prefers $name over the instance environment", ({ driver, variable, config, expectedHome }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "configured_home",
        env: undefined,
      });

      expect(environment[variable]).toBe(path.resolve(expectedHome));
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("configured_home")]: {
              driver: ProviderDriverKind.make(driver),
              environment: [{ name: variable, value: "~/.environment-account", sensitive: false }],
              config,
            },
          },
        }),
      ),
    ),
  );

  it.effect("resolves the legacy Codex default instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: undefined,
      });

      expect(environment.CODEX_HOME).toMatch(/[\\/][.]codex-legacy$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {},
          providers: { codex: { homePath: "~/.codex-legacy" } },
        }),
      ),
    ),
  );

  it.effect("resolves the legacy Claude default instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "claudeAgent",
        env: undefined,
      });

      expect(environment.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-legacy$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {},
          providers: { claudeAgent: { homePath: "~/.claude-legacy" } },
        }),
      ),
    ),
  );

  it.effect("prefers an explicit default instance over legacy provider settings", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: undefined,
      });

      expect(environment.CODEX_HOME).toMatch(/[\\/][.]codex-explicit$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providers: { codex: { homePath: "~/.codex-legacy" } },
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: "codex",
              config: { homePath: "~/.codex-explicit" },
            },
          },
        }),
      ),
    ),
  );

  it.effect("keeps unknown provider instance ids unavailable after legacy hydration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex_unknown",
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderInstanceNotFoundError",
        providerInstanceId: "codex_unknown",
      });
    }).pipe(Effect.provide(ServerSettings.ServerSettingsService.layerTest())),
  );

  it.effect("restarts a running terminal when the resolved provider environment changes", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerSecret = "first-secret";
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: () =>
          Effect.succeed({ PROVIDER_SECRET: providerSecret }),
      });

      yield* manager.open(openInput({ providerInstanceId }));
      providerSecret = "second-secret";
      yield* manager.open(openInput({ providerInstanceId }));

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env.PROVIDER_SECRET).toBe("second-secret");
    }),
  );

  it.effect("restarts with current provider secrets while preserving bounded history", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_restart");
      const { manager, ptyAdapter, logsDir } = yield* createManager(2, {
        historyByteLimit: 8,
        resolveProviderInstanceEnvironment: (rawProviderInstanceId, env) =>
          TerminalManager.resolveProviderInstanceTerminalEnvironment({
            serverSettings,
            path,
            rawProviderInstanceId,
            env,
          }),
      });
      const homePath = path.join(logsDir, "codex");
      const updateSecret = (value: string) =>
        serverSettings.updateSettings({
          providerInstances: {
            [providerInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath },
              environment: [{ name: "PROVIDER_SECRET", value, sensitive: true }],
            },
          },
        });
      const input = {
        providerInstanceId,
        env: { CLIENT_FLAG: "1", PROVIDER_SECRET: "client-value" },
      };
      const outputProcessed = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(outputProcessed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* updateSecret("first-secret");
      yield* manager.restart(restartInput(input));
      const firstProcess = ptyAdapter.processes[0]!;
      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("first-secret");
      firstProcess.emitData("discarded\nold-one\nold-two\n");
      yield* Deferred.await(outputProcessed);
      expect((yield* manager.open(openInput(input))).history).toBe("old-two\n");

      yield* updateSecret("second-secret");
      const restarted = yield* manager.restart(restartInput(input));

      expect(firstProcess.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env).toMatchObject({
        PROVIDER_SECRET: "second-secret",
        CODEX_HOME: homePath,
        CLIENT_FLAG: "1",
      });
      expect(restarted.history).toBe("old-two\n");
      expect(restarted.status).toBe("running");
      expect(restarted).not.toHaveProperty("env");
      expect(restarted).not.toHaveProperty("providerInstanceId");
      const logPath = yield* historyLogPath(logsDir);
      expect(yield* readFileString(logPath)).toBe("old-two\n");

      ptyAdapter.processes[1]!.emitData("discarded again\nnew-one\nnew-two\n");
      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID });
      expect(yield* readFileString(logPath)).toBe("new-two\n");
    }).pipe(
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(SqlitePersistenceMemory),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "awen-terminal-provider-restart-" }),
          ),
        ),
      ),
    ),
  );

  it.effect("attaches to a running provider terminal without resolving the provider again", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerAvailable = true;
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          providerAvailable
            ? Effect.succeed({ PROVIDER_SECRET: "secret-value" })
            : Effect.fail(
                new TerminalProviderInstanceNotFoundError({
                  providerInstanceId: ProviderInstanceId.make(requestedId),
                }),
              ),
      });
      yield* manager.open(openInput({ providerInstanceId }));
      providerAvailable = false;
      const events: TerminalAttachStreamEvent[] = [];

      const unsubscribe = yield* manager.attachStream(
        { ...openInput({ providerInstanceId }), restartIfNotRunning: true },
        (event) => Effect.sync(() => events.push(event)),
      );
      unsubscribe();

      expect(events[0]?.type).toBe("snapshot");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes[0]?.killed).toBe(false);
    }),
  );

  it.effect("fails closed when attaching would create a missing provider terminal", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager
        .attachStream(openInput({ providerInstanceId }), () => Effect.void)
        .pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(["-o", "nopromptsp"]);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("subscribes terminal metadata with an initial snapshot and live deltas", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput());

      const metadataEvents = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadataEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const initialEvents = yield* Ref.get(metadataEvents);
      expect(initialEvents[0]).toMatchObject({
        type: "snapshot",
        terminals: [
          {
            terminalId: DEFAULT_TERMINAL_ID,
          },
        ],
      });

      yield* manager.open(openInput({ terminalId: "term-2" }));

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some((event) => event.type === "upsert" && event.terminal.terminalId === "term-2"),
        ),
        "1200 millis",
      );

      yield* manager.close({ terminalId: DEFAULT_TERMINAL_ID, deleteHistory: true });

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) => event.type === "remove" && event.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect(
    "assigns sequential Workspace titles and lets OSC titles update until manual rename",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          ptyAdapter: new FakePtyAdapter("async"),
          resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
        });
        const workspaceId = "workspace-titles";
        const first = yield* manager.open(openInput({ workspaceId, terminalId: "term-title-1" }));
        const second = yield* manager.open(openInput({ workspaceId, terminalId: "term-title-2" }));

        expect(first.title).toBe("Terminal 1");
        expect(second.title).toBe("Terminal 2");

        const firstProcess = ptyAdapter.processes[0];
        expect(firstProcess).toBeDefined();
        firstProcess?.emitData("\u001b]0;Shell from OSC\u0007");
        yield* waitFor(
          Effect.map(manager.getMetadata(), (terminals) =>
            terminals.some(
              (terminal) =>
                terminal.terminalId === "term-title-1" && terminal.title === "Shell from OSC",
            ),
          ),
          "1200 millis",
        );

        const renamed = yield* manager.rename({
          workspaceId,
          terminalId: "term-title-2",
          title: "Build watcher",
        });
        expect(renamed.title).toBe("Build watcher");

        const secondProcess = ptyAdapter.processes[1];
        expect(secondProcess).toBeDefined();
        secondProcess?.emitData("\u001b]2;Ignored by manual title\u0007");
        yield* Effect.sleep("50 millis");
        expect(
          (yield* manager.getMetadata()).find((terminal) => terminal.terminalId === "term-title-2")
            ?.title,
        ).toBe("Build watcher");
      }),
  );

  it.effect("preserves the last OSC title when queued updates return to the current title", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });
      const input = { workspaceId: "workspace-title-burst", terminalId: "term-title-burst" };
      yield* manager.open(input);
      const pty = ptyAdapter.processes[0]!;
      pty.emitData(String.fromCharCode(27) + "]2;Temporary title" + String.fromCharCode(7));
      pty.emitData(String.fromCharCode(27) + "]2;Intermediate title" + String.fromCharCode(7));
      pty.emitData(String.fromCharCode(27) + "]1;Temporary title" + String.fromCharCode(27));
      pty.emitData(String.fromCharCode(92) + "after-title-burst");
      yield* waitFor(
        Effect.map(manager.open(input), (snapshot) =>
          snapshot.history.includes("after-title-burst"),
        ),
        "1200 millis",
      );
      expect((yield* manager.open(input)).title).toBe("Temporary title");
    }),
  );

  it.effect(
    "accepts split OSC title updates and preserves terminal and manual titles across manager restarts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "term-title-restore-" });
        const logsDir = join(tempDir, "logs");
        const resolveWorkspaceRoot = () => Effect.succeed(process.cwd());
        const workspaceId = "workspace-title-restore";
        const manualInput = { workspaceId, terminalId: "term-manual-title" };
        const shellInput = { workspaceId, terminalId: "term-shell-title" };

        const first = yield* createManager(5, { logsDir, resolveWorkspaceRoot });
        yield* first.manager.open(manualInput);
        yield* first.manager.open(shellInput);
        const shellProcess = first.ptyAdapter.processes[1];
        expect(shellProcess).toBeDefined();
        shellProcess?.emitData("\u001b]2;Split shell title");
        shellProcess?.emitData("\u0007after");

        yield* waitFor(
          Effect.map(first.manager.getMetadata(), (terminals) =>
            terminals.some(
              (terminal) =>
                terminal.terminalId === shellInput.terminalId &&
                terminal.title === "Split shell title",
            ),
          ),
          "1200 millis",
        );
        yield* first.manager.rename({
          ...manualInput,
          title: "Pinned title",
        });
        yield* first.manager.close(manualInput);
        yield* first.manager.close(shellInput);

        const second = yield* createManager(5, { logsDir, resolveWorkspaceRoot });
        const restored = yield* second.manager.getMetadata();
        expect(
          restored.find((terminal) => terminal.terminalId === manualInput.terminalId)?.title,
        ).toBe("Pinned title");
        expect(
          restored.find((terminal) => terminal.terminalId === shellInput.terminalId)?.title,
        ).toBe("Split shell title");
      }),
  );

  it.effect("removes terminal metadata subscriptions when initial delivery fails", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput());

      const leakedLiveEvents = yield* Ref.make(0);
      const exit = yield* Effect.exit(
        manager.subscribeMetadata((event) =>
          event.type === "snapshot"
            ? Effect.die("snapshot listener failed")
            : Ref.update(leakedLiveEvents, (count) => count + 1),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      yield* manager.open(openInput({ terminalId: "term-2" }));
      expect(yield* Ref.get(leakedLiveEvents)).toBe(0);
    }),
  );

  it.effect(
    "streams attach snapshots followed by live events without duplicate start snapshots",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          ptyAdapter: new FakePtyAdapter("async"),
        });
        const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
        const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
          Ref.update(attachEvents, (events) => [...events, event]),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        expect(yield* Ref.get(attachEvents)).toMatchObject([
          {
            type: "snapshot",
            snapshot: {
              terminalId: DEFAULT_TERMINAL_ID,
            },
          },
        ]);

        process.emitData("hello from attach\n");

        yield* waitFor(
          Effect.map(Ref.get(attachEvents), (events) =>
            events.some((event) => event.type === "output" && event.data === "hello from attach\n"),
          ),
          "1200 millis",
        );

        const events = yield* Ref.get(attachEvents);
        expect(events.filter((event) => event.type === "snapshot")).toHaveLength(1);
      }),
  );

  it.effect("buffers attach output delivered during the initial snapshot callback", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      yield* manager.open(openInput());

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Effect.gen(function* () {
          yield* Ref.update(attachEvents, (events) => [...events, event]);
          if (event.type === "snapshot") {
            yield* Effect.sync(() => process.emitData("during snapshot\n"));
            yield* Effect.yieldNow;
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* waitFor(
        Effect.map(Ref.get(attachEvents), (events) =>
          events.some((event) => event.type === "output" && event.data === "during snapshot\n"),
        ),
        "1200 millis",
      );

      expect(yield* Ref.get(attachEvents)).toMatchObject([
        { type: "snapshot" },
        { type: "output", data: "during snapshot\n" },
      ]);
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n", sequence: 2 }),
        expect.objectContaining({ type: "output", data: "second\n", sequence: 3 }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0, sequence: 4 }),
      ]);

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          terminalId: DEFAULT_TERMINAL_ID,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      expect(snapshot.snapshot.sequence).toBe(4);
    }),
  );

  it.effect("keeps the new generation's queued output when a stale drain resumes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5);
      const releaseFirstDrain = yield* Deferred.make<void>();
      const releaseSecondDrain = yield* Deferred.make<void>();
      const listenerEntries = yield* Ref.make<ReadonlyArray<string>>([]);
      const unsubscribe = yield* manager.subscribe((event) => {
        if (event.type !== "output") return Effect.void;
        const gate = event.data.includes("first")
          ? releaseFirstDrain
          : event.data.includes("second")
            ? releaseSecondDrain
            : null;
        return Ref.update(listenerEntries, (current) => [...current, event.data]).pipe(
          Effect.andThen(gate === null ? Effect.void : Deferred.await(gate)),
        );
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const firstGeneration = ptyAdapter.processes[0];
      expect(firstGeneration).toBeDefined();
      if (!firstGeneration) return;

      // Park the first generation's drain inside its event delivery...
      firstGeneration.emitData("first\n");
      yield* waitFor(
        Effect.map(Ref.get(listenerEntries), (values) =>
          values.some((value) => value.includes("first")),
        ),
      );

      // ...replace it with a new generation, and park that drain too so its
      // queue still holds output when the stale drain resumes.
      yield* manager.restart(restartInput());
      const secondGeneration = ptyAdapter.processes[1];
      expect(secondGeneration).toBeDefined();
      if (!secondGeneration) return;
      secondGeneration.emitData("second\n");
      yield* waitFor(
        Effect.map(Ref.get(listenerEntries), (values) =>
          values.some((value) => value.includes("second")),
        ),
      );
      secondGeneration.emitData("third\n");

      yield* Deferred.succeed(releaseFirstDrain, undefined);
      yield* Deferred.succeed(releaseSecondDrain, undefined);

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data.includes("third")),
        ),
      );
      expect((yield* manager.open(openInput())).history).toContain("third");
    }),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect(
    "Workspace Terminal close preserves session identity and history across manager recreation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "term-close-persist-" });
        const logsDir = join(tempDir, "logs");
        const resolveWorkspaceRoot = () => Effect.succeed(process.cwd());

        const first = yield* createManager(5, { logsDir, resolveWorkspaceRoot });
        const input = { workspaceId: "workspace-history-persist", terminalId: "term-1" };
        const opened = yield* first.manager.open(input);
        const pty = first.ptyAdapter.processes[0]!;
        pty.emitData("marker-text-to-preserve\r\n");

        yield* waitFor(
          Effect.map(first.getEvents, (events) =>
            events.some(
              (event) => event.type === "output" && event.data.includes("marker-text-to-preserve"),
            ),
          ),
        );

        // Close session without deleting history
        yield* first.manager.close(input);

        // Metadata in the first manager instance should still list the session with status "closed"
        const metadataBeforeReboot = yield* first.manager.getMetadata();
        const closedSummary = metadataBeforeReboot.find(
          (m) => m.workspaceId === input.workspaceId && m.terminalId === input.terminalId,
        );
        expect(closedSummary).toBeDefined();
        expect(closedSummary?.status).toBe("closed");

        // Recreate manager with the same logsDir (simulating daemon restart)
        const second = yield* createManager(5, { logsDir, resolveWorkspaceRoot });
        const metadataAfterReboot = yield* second.manager.getMetadata();
        const restoredSummary = metadataAfterReboot.find(
          (m) => m.workspaceId === input.workspaceId && m.terminalId === input.terminalId,
        );
        expect(restoredSummary).toBeDefined();
        expect(restoredSummary?.status).toBe("closed");
        expect(restoredSummary?.sessionId).toBe(opened.sessionId);

        // Attaching to the closed session returns snapshot with preserved history without spawning a PTY
        let attachSnapshot: TerminalSessionSnapshot | null = null;
        yield* second.manager.attachStream(input, (event) =>
          Effect.sync(() => {
            if (event.type === "snapshot") {
              attachSnapshot = event.snapshot;
            }
          }),
        );
        expect(attachSnapshot).not.toBeNull();
        const receivedSnapshot = attachSnapshot as unknown as TerminalSessionSnapshot;
        expect(receivedSnapshot.status).toBe("closed");
        expect(receivedSnapshot.history).toContain("marker-text-to-preserve");
        expect(second.ptyAdapter.processes.length).toBe(0);

        // Explicit delete removes it completely
        yield* second.manager.close({ ...input, deleteHistory: true });
        const metadataAfterDelete = yield* second.manager.getMetadata();
        expect(
          metadataAfterDelete.find(
            (m) => m.workspaceId === input.workspaceId && m.terminalId === input.terminalId,
          ),
        ).toBeUndefined();
      }),
  );

  it.effect(
    "evicting inactive Workspace sessions retains metadata and index without losing history",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "term-evict-ws-" });
        const logsDir = join(tempDir, "logs");
        const resolveWorkspaceRoot = () => Effect.succeed(process.cwd());

        const fixture = yield* createManager(5, {
          logsDir,
          resolveWorkspaceRoot,
          maxRetainedInactiveSessions: 1,
        });

        const input1 = { workspaceId: "ws-evict", terminalId: "term-1" };
        const input2 = { workspaceId: "ws-evict", terminalId: "term-2" };

        yield* fixture.manager.open(input1);
        yield* fixture.manager.open(input2);

        fixture.ptyAdapter.processes[0]!.emitData("history-1\r\n");
        fixture.ptyAdapter.processes[1]!.emitData("history-2\r\n");

        yield* fixture.manager.close(input1);
        yield* fixture.manager.close(input2);

        const metadata = yield* fixture.manager.getMetadata();
        expect(metadata.filter((m) => m.workspaceId === "ws-evict")).toHaveLength(2);

        // Recreate manager
        const second = yield* createManager(5, {
          logsDir,
          resolveWorkspaceRoot,
          maxRetainedInactiveSessions: 1,
        });
        const secondMetadata = yield* second.manager.getMetadata();
        expect(secondMetadata.filter((m) => m.workspaceId === "ws-evict")).toHaveLength(2);
      }),
  );

  it.effect(
    "reassigns promptly after shell output when entering another Workspace subdirectory",
    () =>
      Effect.gen(function* () {
        let directory = process.cwd();
        const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
          directoryPollIntervalMs: 60_000,
          directoryObserver: fakeDirectoryObserver(() => directory),
          listRegisteredWorkspaceDirectories: () =>
            Effect.succeed([{ workspaceId: "workspace:a", workspaceRoot: "/workspace-a" }]),
        });
        yield* manager.open({ terminalId: "term-prompt", cwd: process.cwd(), cols: 80, rows: 24 });
        // Let the initial observation complete; the fallback tick is a minute away.
        yield* Effect.sleep("50 millis");
        directory = "/workspace-a/src/deep";
        ptyAdapter.processes[0]!.emitData("$ ");
        yield* waitFor(
          Effect.map(getEvents, (events) =>
            events.some(
              (event) => event.type === "assigned" && event.workspaceId === "workspace:a",
            ),
          ),
          "500 millis",
        );
        expect(ptyAdapter.processes).toHaveLength(1);
        expect((yield* manager.getMetadata())[0]?.workspaceId).toBe("workspace:a");
      }),
  );

  it.effect(
    "follows a reliable shell directory into a registered Workspace without restarting",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "awen-term-dir-" });
        const mainRoot = join(parent, "main");
        const siblingRoot = join(parent, "sibling");
        const subdirectory = join(mainRoot, "packages");
        yield* fs.makeDirectory(mainRoot);
        yield* fs.makeDirectory(siblingRoot);
        yield* fs.makeDirectory(subdirectory);

        let directory: string | null = mainRoot;
        const fixture = yield* createManager(5, {
          subprocessInspector: idleInspect,
          subprocessPollIntervalMs: 20,
          directoryPollIntervalMs: 20,
          directoryObserver: fakeDirectoryObserver(() => directory),
          listRegisteredWorkspaceDirectories: () =>
            Effect.succeed([
              { workspaceId: "workspace:main", workspaceRoot: mainRoot },
              { workspaceId: "workspace:sibling", workspaceRoot: siblingRoot },
            ]),
        });
        const { manager, ptyAdapter, getEvents } = fixture;

        const opened = yield* manager.open({
          terminalId: "term-1",
          workspaceId: "workspace:main",
          cwd: mainRoot,
          cols: 80,
          rows: 24,
        });
        expect(opened.workspaceId).toBe("workspace:main");
        expect(ptyAdapter.processes).toHaveLength(1);
        const process = ptyAdapter.processes[0]!;

        // A subdirectory of the same checkout is still that Workspace.
        directory = subdirectory;
        yield* Effect.sleep("80 millis");
        expect(
          (yield* manager.getMetadata()).find((m) => m.terminalId === "term-1")?.workspaceId,
        ).toBe("workspace:main");

        // A registered sibling checkout takes over the Sidebar assignment.
        directory = siblingRoot;
        yield* waitFor(
          Effect.map(getEvents, (events) =>
            events.some(
              (event) => event.type === "assigned" && event.workspaceId === "workspace:sibling",
            ),
          ),
          "1200 millis",
        );
        const summary = (yield* manager.getMetadata()).find((m) => m.terminalId === "term-1")!;
        expect(summary.workspaceId).toBe("workspace:sibling");

        // Same PTY, same launch context, no restart.
        expect(ptyAdapter.processes).toHaveLength(1);
        expect(ptyAdapter.processes[0]!.pid).toBe(process.pid);
        expect(process.killed).toBe(false);
        const snapshot = yield* manager.open({
          terminalId: "term-1",
          cwd: mainRoot,
          cols: 80,
          rows: 24,
        });
        expect(snapshot.cwd).toBe(mainRoot);
      }),
  );

  it.effect(
    "retains the last assignment for an unknown observation and moves to unassigned for a known unregistered path",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "awen-term-dir-" });
        const mainRoot = join(parent, "main");
        const unregisteredRoot = join(parent, "elsewhere");
        yield* fs.makeDirectory(mainRoot);
        yield* fs.makeDirectory(unregisteredRoot);

        let directory: string | null = mainRoot;
        const fixture = yield* createManager(5, {
          subprocessInspector: idleInspect,
          subprocessPollIntervalMs: 20,
          directoryPollIntervalMs: 20,
          directoryObserver: fakeDirectoryObserver(() => directory),
          listRegisteredWorkspaceDirectories: () =>
            Effect.succeed([{ workspaceId: "workspace:main", workspaceRoot: mainRoot }]),
        });
        const { manager, getEvents } = fixture;
        const metadataEventsRef = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
        const unsubscribeMetadata = yield* manager.subscribeMetadata((event) =>
          Ref.update(metadataEventsRef, (events) => [...events, event]),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeMetadata));

        yield* manager.open({
          terminalId: "term-1",
          workspaceId: "workspace:main",
          cwd: mainRoot,
          cols: 80,
          rows: 24,
        });

        // Unknown observation is not a known unregistered directory.
        directory = null;
        yield* Effect.sleep("80 millis");
        expect(
          (yield* manager.getMetadata()).find((m) => m.terminalId === "term-1")?.workspaceId,
        ).toBe("workspace:main");
        expect((yield* getEvents).some((event) => event.type === "assigned")).toBe(false);

        // A known directory outside registered Workspaces becomes unassigned.
        directory = unregisteredRoot;
        yield* waitFor(
          Effect.map(getEvents, (events) => events.some((event) => event.type === "assigned")),
          "1200 millis",
        );
        const summary = (yield* manager.getMetadata()).find((m) => m.terminalId === "term-1")!;
        expect(summary.workspaceId).toBeUndefined();

        const metadataEvents = yield* Ref.get(metadataEventsRef);
        expect(
          metadataEvents.some(
            (event) =>
              event.type === "upsert" &&
              event.terminal.terminalId === "term-1" &&
              event.terminal.workspaceId === undefined,
          ),
        ).toBe(true);
      }),
  );

  it.effect("unregistration wins over an in-flight directory observation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let registered = true;
      let firstObservation = true;
      const { manager } = yield* createManager(5, {
        directoryPollIntervalMs: 60_000,
        listRegisteredWorkspaceDirectories: () =>
          Effect.succeed(
            registered ? [{ workspaceId: "workspace:a", workspaceRoot: process.cwd() }] : [],
          ),
        directoryObserver: {
          capability: { supported: true, mechanism: "procfs" },
          observe: () =>
            Effect.gen(function* () {
              if (!firstObservation) return { kind: "unknown", reason: "unavailable" } as const;
              firstObservation = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
              return { kind: "known", directory: process.cwd() } as const;
            }),
        },
      });
      yield* manager.open({ terminalId: "term-release", cwd: process.cwd(), cols: 80, rows: 24 });
      yield* Deferred.await(entered);
      registered = false;
      const releasing = yield* manager
        .releaseWorkspaceAssignment("workspace:a")
        .pipe(Effect.forkScoped);
      yield* Effect.sleep("20 millis");
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(releasing);
      yield* Effect.sleep("50 millis");
      expect((yield* manager.getMetadata())[0]?.workspaceId).toBeUndefined();
    }),
  );

  it.effect(
    "observes child directory occupancy independently of shell assignment and releases exited children",
    () =>
      Effect.gen(function* () {
        let childAlive = true;
        let childKnown = true;
        const { manager } = yield* createManager(5, {
          subprocessInspector: () =>
            Effect.succeed({
              hasRunningSubprocess: childAlive,
              childCommand: childAlive ? "sleep" : null,
              processIds: childAlive ? [999] : [],
            }),
          directoryObserver: {
            capability: { supported: true, mechanism: "procfs" },
            observe: (pid) =>
              Effect.succeed(
                pid === 999
                  ? childKnown
                    ? { kind: "known", directory: "/workspace-a/nested" }
                    : { kind: "unknown", reason: "unavailable" }
                  : { kind: "known", directory: process.cwd() },
              ),
          },
        });
        yield* manager.open({ terminalId: "term-child", cwd: process.cwd(), cols: 80, rows: 24 });
        let occupancy = (yield* manager.getDirectoryOccupancy())[0]!;
        expect(occupancy.observedDirectory).toBe(process.cwd());
        expect(occupancy.processDirectories).toEqual(["/workspace-a/nested"]);
        expect(occupancy.hasUnobservedProcesses).toBe(false);
        childKnown = false;
        occupancy = (yield* manager.getDirectoryOccupancy())[0]!;
        expect(occupancy.hasUnobservedProcesses).toBe(true);
        childAlive = false;
        occupancy = (yield* manager.getDirectoryOccupancy())[0]!;
        expect(occupancy.processDirectories).toEqual([]);
        expect(occupancy.hasUnobservedProcesses).toBe(false);
      }),
  );

  it.effect("keeps shell uncertainty separate from its last confirmed assignment", () =>
    Effect.gen(function* () {
      let directory: string | null = "/workspace-b";
      const { manager } = yield* createManager(5, {
        subprocessInspector: idleInspect,
        directoryObserver: fakeDirectoryObserver(() => directory),
        listRegisteredWorkspaceDirectories: () =>
          Effect.succeed([{ workspaceId: "workspace:b", workspaceRoot: "/workspace-b" }]),
      });
      yield* manager.open({ terminalId: "term-unknown", cwd: process.cwd(), cols: 80, rows: 24 });
      expect((yield* manager.getDirectoryOccupancy())[0]?.workspaceId).toBe("workspace:b");
      directory = null;
      const uncertain = (yield* manager.getDirectoryOccupancy())[0]!;
      expect(uncertain.workspaceId).toBe("workspace:b");
      expect(uncertain.observedDirectory).toBe("/workspace-b");
      expect(uncertain.hasUnobservedProcesses).toBe(true);
      directory = "/workspace-b";
      expect((yield* manager.getDirectoryOccupancy())[0]?.hasUnobservedProcesses).toBe(false);
    }),
  );

  it.effect("refreshes directory occupancy before the next background tick", () =>
    Effect.gen(function* () {
      let directory = process.cwd();
      const { manager } = yield* createManager(5, {
        directoryPollIntervalMs: 60_000,
        directoryObserver: fakeDirectoryObserver(() => directory),
      });
      yield* manager.open({ terminalId: "term-occupancy", cwd: process.cwd(), cols: 80, rows: 24 });
      yield* Effect.sleep("100 millis");
      directory = "/workspace-a/nested";
      expect((yield* manager.getDirectoryOccupancy())[0]?.observedDirectory).toBe(directory);
      directory = "/elsewhere";
      expect((yield* manager.getDirectoryOccupancy())[0]?.observedDirectory).toBe(directory);
    }),
  );

  it.effect("reports directory occupancy and releases an assignment without stopping the PTY", () =>
    Effect.gen(function* () {
      // No directory observer injected: on a platform without one the launch
      // assignment stands in for occupancy, which is the conservative case.
      const fixture = yield* createManager(5, {
        subprocessInspector: idleInspect,
        subprocessPollIntervalMs: 20,
      });
      const { manager, ptyAdapter, getEvents } = fixture;

      yield* manager.open({
        terminalId: "term-1",
        workspaceId: "workspace:main",
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });
      const process_ = ptyAdapter.processes[0]!;

      const occupancy = (yield* manager.getDirectoryOccupancy()).find(
        (entry) => entry.terminalId === "term-1",
      )!;
      expect(occupancy.workspaceId).toBe("workspace:main");
      expect(occupancy.status).toBe("running");
      expect(occupancy.launchCwd).toBe(process.cwd());

      yield* manager.releaseWorkspaceAssignment("workspace:main");
      const summary = (yield* manager.getMetadata()).find((m) => m.terminalId === "term-1")!;
      expect(summary.workspaceId).toBeUndefined();
      expect(summary.status).toBe("running");
      expect(ptyAdapter.processes).toHaveLength(1);
      expect(process_.killed).toBe(false);
      expect((yield* getEvents).some((event) => event.type === "assigned")).toBe(true);
    }),
  );

  it.effect("follows the shell directory independently of the subprocess poll cadence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "awen-term-dir-" });
      const mainRoot = join(parent, "main");
      const targetRoot = join(parent, "target");
      yield* fs.makeDirectory(mainRoot);
      yield* fs.makeDirectory(targetRoot);

      let directory = mainRoot;
      const fixture = yield* createManager(5, {
        subprocessInspector: idleInspect,
        // The subprocess poll backs off to a minute when its snapshot fails; the
        // directory loop must not inherit that cadence.
        subprocessPollIntervalMs: 60_000,
        directoryPollIntervalMs: 20,
        directoryObserver: fakeDirectoryObserver(() => directory),
        listRegisteredWorkspaceDirectories: () =>
          Effect.succeed([
            { workspaceId: "workspace:main", workspaceRoot: mainRoot },
            { workspaceId: "workspace:target", workspaceRoot: targetRoot },
          ]),
      });
      const { manager, getEvents } = fixture;

      yield* manager.open({
        terminalId: "term-1",
        workspaceId: "workspace:main",
        cwd: mainRoot,
        cols: 80,
        rows: 24,
      });

      directory = targetRoot;
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) => event.type === "assigned" && event.workspaceId === "workspace:target",
          ),
        ),
        "1200 millis",
      );
    }),
  );
});
