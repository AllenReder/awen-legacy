import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@awen/shared/Net";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@awen/shared/hostProcess";
import {
  SERVER_RELEASE_CHECKSUMS_FILE,
  serverReleaseArchiveName,
} from "@awen/shared/serverRelease";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";

import { SshPasswordPrompt } from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import { SshEnvironmentProgress } from "./progress.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteAwenRunnerScript,
  SshInvalidArchiveVersionError,
  SshMissingRunnerError,
  describeReadinessCause,
  issueRemotePairingToken,
  localServerPackageCacheDir,
  launchOrReuseRemoteServer,
  parseRemotePackageStageHome,
  parseSshEnvironmentInspection,
  REMOTE_PICK_PORT_SCRIPT,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

describe("remote package upload", () => {
  it.effect("uses USERPROFILE for the local server package cache on Windows", () =>
    Effect.gen(function* () {
      const cacheDir = yield* localServerPackageCacheDir("1.2.3").pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, { USERPROFILE: "/home/awen" }),
      );
      assert.equal(cacheDir, "/home/awen/.awen/caches/server-packages/1.2.3");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("reads the absolute Awen home used by the remote staging command", () => {
    assert.equal(
      parseRemotePackageStageHome("login banner\nAWEN_STAGE_HOME=/home/allen/.awen\n"),
      "/home/allen/.awen",
    );
    assert.equal(parseRemotePackageStageHome("AWEN_STAGE_HOME=relative/.awen\n"), null);
  });
});

describe("SSH environment inspection", () => {
  const runner = { archiveVersion: "0.0.42", nodeEngineRange: TEST_NODE_ENGINE_RANGE };

  it("parses actual prerequisites and reuse state", () => {
    assert.deepEqual(
      parseSshEnvironmentInspection(
        "login banner\nAWEN_PREFLIGHT\tLinux\tx86_64\tv22.16.0\tyes\treuse\n",
        runner,
      ),
      {
        version: "0.0.42",
        os: "Linux",
        arch: "x86_64",
        nodeVersion: "v22.16.0",
        nodeSupported: true,
        gitAvailable: true,
        daemon: "reuse",
      },
    );
  });

  it("reports unsupported Node and rejects malformed output", () => {
    assert.equal(
      parseSshEnvironmentInspection(
        "AWEN_PREFLIGHT\tLinux\tx86_64\tv22.15.0\tno\tinstall\n",
        runner,
      )?.nodeSupported,
      false,
    );
    assert.equal(
      parseSshEnvironmentInspection(
        "AWEN_PREFLIGHT\tLinux\tx86_64\tv22.16.0\tyes\tunknown\n",
        runner,
      ),
      null,
    );
  });
});

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

function commandName(command: ChildProcess.Command): string {
  return command._tag === "StandardCommand" ? command.command : "";
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
const NODE_SCRIPT = {
  nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
} as const;

describe("ssh tunnel scripts", () => {
  it("installs and runs the Awen server release archive after Node and Git checks", () => {
    const script = buildRemoteAwenRunnerScript(ARCHIVE);

    assert.include(script, "AWEN_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "AWEN_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "AWEN_RELEASE_BASE_URL='https://github.com/AllenReder/awen/releases/download'",
    );
    assert.include(script, 'AWEN_RUNTIME_DIR="$AWEN_HOME/runtime/versions/$AWEN_ARCHIVE_VERSION"');
    assert.include(script, 'AWEN_ARCHIVE="awen-server-$AWEN_ARCHIVE_VERSION-linux-x64.tar.gz"');
    assert.include(script, "SHA256SUMS");
    assert.include(script, "AWEN_ERROR install-download-checksum Checksum mismatch for %s.");
    assert.include(script, 'exec "$AWEN_RUNTIME_DIR/bin/awen" "$@"');
    assert.include(script, 'if [ "$(uname -s)" != "Linux" ]; then');
    assert.include(script, "x86_64 | amd64");
    assert.include(script, "if ! command -v git >/dev/null 2>&1; then");
    assert.include(script, "AWEN_ERROR prerequisite-missing Remote host is missing Git on PATH.");
    assert.include(script, "if ! ensure_remote_node_path; then");
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "awen@latest");
    assert.notInclude(script, 'exec awen "$@"');
    // Concurrent launches serialize on a per-version mkdir lock and recheck
    // the completion marker after acquiring it.
    assert.include(
      script,
      'AWEN_LOCK="$AWEN_HOME/runtime/versions/.$AWEN_ARCHIVE_VERSION.install.lock"',
    );
    // mkdir is the exclusive create; the pid follows atomically. A dead owner
    // is reclaimed at once, a never-published owner after a short grace.
    assert.include(script, 'while ! mkdir "$AWEN_LOCK" 2>/dev/null; do');
    assert.include(script, 'mv "$AWEN_LOCK/pid.tmp" "$AWEN_LOCK/pid"');
    assert.include(script, 'if ! kill -0 "$AWEN_LOCK_OWNER" 2>/dev/null; then');
    assert.include(script, 'if [ "$AWEN_LOCK_UNOWNED" -ge 5 ]; then');
    assert.include(script, 'if [ "$AWEN_LOCK_WAITED" -ge 360 ]; then');
    assert.include(script, '"$AWEN_STAGING/SHA256SUMS" 30');
    assert.include(script, '"$AWEN_STAGING/$AWEN_ARCHIVE" 240');
    assert.include(script, "AWEN_PROGRESS download %s");
    assert.include(script, "AWEN_PROGRESS stage installing");
    assert.include(script, "AWEN_PROGRESS stage starting");
    assert.notInclude(script, "AWEN_LOCK_CANDIDATE");
    assert.notInclude(script, "-mmin");
    assert.equal(script.split("if ! awen_runtime_ready; then").length - 1, 2);
    assert.isBelow(
      script.indexOf('"$AWEN_STAGING/bin/awen" --version'),
      script.indexOf('> "$AWEN_STAGING/.install-complete"'),
    );
    // Node discovery is defined for the dev path but only ever invoked inside
    // the node-script branch, which the archive path skips entirely.
    assert.equal(script.split("ensure_remote_node_path || true").length - 1, 1);
    assert.isBelow(
      script.indexOf("ensure_remote_node_path || true"),
      script.indexOf('exec node "$AWEN_NODE_SCRIPT_PATH" "$@"'),
    );
    assert.isBelow(
      script.indexOf('exec node "$AWEN_NODE_SCRIPT_PATH" "$@"'),
      script.indexOf("AWEN_ARCHIVE_VERSION="),
    );

    const launch = buildRemoteLaunchScript({
      ...ARCHIVE,
      releaseBaseUrl: "https://mirror.example/awen/",
    });
    assert.include(launch, "AWEN_ARCHIVE_MODE=1");
    assert.include(launch, "AWEN_RELEASE_BASE_URL='https://mirror.example/awen'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    // Reuse only adopts a daemon that answers the public discovery API.
    assert.include(launch, "/.well-known/awen/environment");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"');
    assert.include(buildRemoteLaunchScript(NODE_SCRIPT), "AWEN_ARCHIVE_MODE=0");
  });

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => buildRemoteAwenRunnerScript({ archiveVersion }),
        SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      buildRemoteAwenRunnerScript(ARCHIVE),
      "AWEN_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it("refuses to build a runner with neither an archive version nor a node script", () => {
    for (const input of [undefined, {}, { archiveVersion: "  " }, { nodeScriptPath: null }]) {
      assert.throws(() => buildRemoteAwenRunnerScript(input), SshMissingRunnerError);
    }
    assert.throws(() => buildRemoteLaunchScript(), SshMissingRunnerError);
  });

  it("does not hard-code a remote node engine range", () => {
    const script = buildRemoteAwenRunnerScript(NODE_SCRIPT);

    assert.include(script, "AWEN_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("builds the remote Awen runner with a node script override", () => {
    const script = buildRemoteAwenRunnerScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(
      script,
      "AWEN_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$AWEN_NODE_SCRIPT_PATH" "$@"');
    assert.include(script, "AWEN_ARCHIVE_VERSION=''");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `AWEN_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for AWEN_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
    assert.notInclude(script, "npx");
  });

  it("uses the remote Awen runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const launch = buildRemoteLaunchScript(ARCHIVE);
    const devLaunch = buildRemoteLaunchScript({
      ...NODE_SCRIPT,
      nodeEngineRange: TEST_NODE_ENGINE_RANGE,
    });

    assert.include(
      launch,
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    // A live daemon is reused as-is; the updated runner only takes effect on
    // its next natural start, so a healthy daemon with active Sessions is
    // never silently restarted.
    assert.notInclude(launch, "RUNNER_CHANGED");
    assert.include(launch, "ensure_remote_node_path()");
    assert.include(launch, "if ! ensure_remote_node_path; then");
    assert.include(devLaunch, `AWEN_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(devLaunch, "does not satisfy required range ");
    // Only an unhealthy daemon is killed for recovery.
    assert.include(launch, 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(launch, "wait_ready");
    assert.include(launch, '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(launch, '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(launch, "server-home");
    assert.include(launch, "Remote Awen daemon did not become ready");
    assert.include(launch, "AWEN_ERROR daemon-start Remote Awen daemon did not become ready");
    assert.include(launch, 'wait_ready "60000"');
    assert.include(launch, 'if [ -s "$LOG_FILE" ]; then');
    assert.include(launch, "It wrote nothing to %s");
    assert.include(launch, "AWEN_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(
      buildRemotePairingScript(target, ARCHIVE),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(
      buildRemotePairingScript(target, ARCHIVE),
      "AWEN_ERROR daemon-authentication Failed to create an authorized pairing credential",
    );
    assert.include(
      buildRemotePairingScript(target, ARCHIVE),
      'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"',
    );
    assert.notInclude(buildRemotePairingScript(target, ARCHIVE), "server-home");
    assert.include(
      buildRemotePairingScript(target, ARCHIVE),
      "AWEN_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
    assert.include(
      launch,
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(launch, "resolve_default_runtime_port()");
    assert.include(launch, 'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port');
    assert.include(launch, "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))");
    assert.include(launch, 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(launch, 'rm -f "$PID_FILE"');
    assert.include(launch, "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(launch, 'if [ -z "$REMOTE_PORT" ]; then');
    // A live managed daemon blocks adoption of the default runtime record.
    assert.isBelow(
      launch.indexOf("MANAGED_ALIVE=1"),
      launch.indexOf('if [ "$MANAGED_ALIVE" != "1" ]; then'),
    );
    assert.isBelow(
      launch.indexOf('if [ "$MANAGED_ALIVE" != "1" ]; then'),
      launch.indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      launch.indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      launch.indexOf('elif [ -n "$REMOTE_PID" ]'),
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        launchOrReuseRemoteServer(target, undefined, NODE_SCRIPT),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("gives cold archive launches a larger budget than node-script launches", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 800_000)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(launchOrReuseRemoteServer(target, undefined, ARCHIVE));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(800));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("checks the public environment descriptor for SSH readiness", () => {
    const urls: string[] = [];
    const httpClient = HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 })));
    });
    return Effect.gen(function* () {
      yield* waitForHttpReady({ baseUrl: "http://127.0.0.1:41773/" });
      assert.deepEqual(urls, ["http://127.0.0.1:41773/.well-known/awen/environment"]);
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("closes the local tunnel on disconnect but leaves the remote daemon running", () => {
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        spawnedCommands.push(args);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          // Any non-launch remote shell command would be a remote mutation;
          // disconnect must never issue one.
          stopCommandCount += 1;
          return makeSuccessfulProcess("");
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;

      const first = yield* manager.ensureEnvironment(target);
      assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
      const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
      assert.isDefined(firstTunnelArgs);
      assert.include(firstTunnelArgs, "ControlMaster=no");
      assert.include(firstTunnelArgs, "ControlPath=none");
      assert.include(firstTunnelArgs, "ControlPersist=no");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      // Disconnecting a Connection must not stop remote Sessions.
      assert.equal(stopCommandCount, 0);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(
      Effect.provide(layer),
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          // Scope teardown also only closes the local forwarding.
          assert.equal(tunnelKillCount, 2);
          assert.equal(stopCommandCount, 0);
        }),
      ),
    );
  });

  it.effect("waits for local tunnel shutdown before reconnecting the same target", () =>
    Effect.gen(function* () {
      const shutdownStarted = yield* Deferred.make<void>();
      const finishShutdown = yield* Deferred.make<void>();
      const reconnectsStarted = yield* Deferred.make<void>();
      const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishShutdown)),
      );
      let resolutions = 0;
      let launches = 0;
      let tunnels = 0;
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          const isTarget = args.includes(target.alias);
          if (args.includes("-G")) {
            if (isTarget && ++resolutions === 4) {
              yield* Deferred.succeed(reconnectsStarted, undefined);
            }
            return makeSuccessfulProcess("");
          }
          if (args.includes("-N")) {
            const tunnel = makeRunningProcess(() => undefined);
            if (isTarget && ++tunnels === 1) {
              return {
                ...tunnel,
                kill: (options?: ChildProcess.KillOptions) =>
                  pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
              };
            }
            return tunnel;
          }
          if (args.includes("--")) {
            if (isTarget) {
              launches += 1;
            }
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          return makeSuccessfulProcess("\n");
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshPasswordPrompt.disabledLayer,
        SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        yield* manager.ensureEnvironment(target);
        const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
        yield* Deferred.await(shutdownStarted);
        const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
        const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
        yield* Deferred.await(reconnectsStarted);

        yield* manager.ensureEnvironment({
          alias: "other",
          hostname: "other",
          username: null,
          port: null,
        });
        yield* TestClock.adjust(Duration.zero);
        const launchesBeforeShutdown = launches;
        yield* Deferred.succeed(finishShutdown, undefined);
        yield* Fiber.join(disconnect);
        const first = yield* Fiber.join(firstReconnect);
        const second = yield* Fiber.join(secondReconnect);

        assert.equal(launchesBeforeShutdown, 1);
        assert.equal(launches, 2);
        assert.equal(tunnels, 2);
        assert.equal(first.httpBaseUrl, second.httpBaseUrl);
      }).pipe(
        Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
        Effect.provide(layer),
        Effect.scoped,
      );
    }),
  );

  it.effect("skips the local package fallback when the launch fails on SSH authentication", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    let scpUploads = 0;
    const httpUrls: string[] = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (commandName(command).startsWith("scp")) {
          scpUploads += 1;
          return makeSuccessfulProcess("");
        }
        if (args.includes("--")) {
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
            stderr: Stream.make(new TextEncoder().encode("Permission denied (publickey).\n")),
          };
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const recordingHttpClient = HttpClient.make((request) => {
      httpUrls.push(request.url);
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 })));
    });
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, recordingHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
    );

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const result = yield* Effect.result(manager.ensureEnvironment(target));

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, SshCommandError);
        assert.include(result.failure.message, "Permission denied");
      }
      // No 70 MB download and no SCP upload may precede the auth signal.
      assert.equal(scpUploads, 0);
      assert.deepEqual(httpUrls, []);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("skips the local package fallback when a remote prerequisite is missing", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    let scpUploads = 0;
    const httpUrls: string[] = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        if (commandName(command).startsWith("scp")) {
          scpUploads += 1;
          return makeSuccessfulProcess("");
        }
        if (args.includes("--")) {
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            stderr: Stream.make(
              new TextEncoder().encode(
                "AWEN_ERROR prerequisite-missing Remote host is missing Git on PATH.\n",
              ),
            ),
          };
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const recordingHttpClient = HttpClient.make((request) => {
      httpUrls.push(request.url);
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 })));
    });
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, recordingHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
    );

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      const result = yield* Effect.result(manager.ensureEnvironment(target));

      assert.isTrue(Result.isFailure(result));
      assert.equal(scpUploads, 0);
      assert.deepEqual(httpUrls, []);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect(
    "stages a locally built package from AWEN_SERVER_PACKAGE_DIR after a download failure",
    () => {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.com",
        username: "julius",
        port: 2222,
      } as const;
      const archiveName = serverReleaseArchiveName(ARCHIVE.archiveVersion);
      let launches = 0;
      let scpUploads = 0;
      const firstUploadProgress = Deferred.makeUnsafe<void>();
      const uploadProgress: Array<{ transferredBytes: number | null; totalBytes: number | null }> =
        [];
      const httpUrls: string[] = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (commandName(command).startsWith("scp")) {
            assert.include(args, "-P");
            assert.notInclude(args, "-p");
            assert.include(args.at(-1) ?? "", "julius@devbox:/home/julius/.awen/ssh-launch/");
            scpUploads += 1;
            let released = false;
            return yield* Effect.acquireRelease(
              Effect.succeed({
                ...makeSuccessfulProcess(""),
                exitCode: Deferred.await(firstUploadProgress).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      if (released) throw new Error("SCP process scope closed before exit");
                      return ChildProcessSpawner.ExitCode(0);
                    }),
                  ),
                ),
              }),
              () =>
                Effect.sync(() => {
                  released = true;
                }),
            );
          }
          if (args.includes("--")) {
            launches += 1;
            if (launches === 1) {
              return {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(new TextEncoder().encode("curl: (6) Could not resolve host\n")),
              };
            }
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }
          if (args.includes("-N")) {
            return makeRunningProcess(() => undefined);
          }
          if (args.includes("sh")) {
            return makeSuccessfulProcess(
              scpUploads > 0 ? "10\n" : "AWEN_STAGE_HOME=/home/julius/.awen\n",
            );
          }
          return makeSuccessfulProcess("\n");
        }),
      );
      const deadHttpClient = HttpClient.make((request) => {
        httpUrls.push(request.url);
        // Only release downloads are forbidden; the loopback readiness probe
        // through the tunnel still answers.
        if (request.url.includes("github")) {
          return Effect.die(new Error("no network in this test"));
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("", { status: 200 })),
        );
      });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, deadHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshPasswordPrompt.disabledLayer,
        Layer.succeed(
          SshEnvironmentProgress,
          SshEnvironmentProgress.of({
            report: (progress) => {
              if (progress.stage === "uploading") {
                uploadProgress.push(progress);
                if (progress.transferredBytes === 10) {
                  Deferred.doneUnsafe(firstUploadProgress, Effect.void);
                }
              }
            },
          }),
        ),
        SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const packageDir = yield* fs.makeTempDirectoryScoped({ prefix: "awen-local-package-" });
        const archiveBytes = new TextEncoder().encode("fake awen server archive");
        const checksum = NodeCrypto.createHash("sha256").update(archiveBytes).digest("hex");
        yield* fs.writeFile(path.join(packageDir, archiveName), archiveBytes);
        yield* fs.writeFileString(
          path.join(packageDir, SERVER_RELEASE_CHECKSUMS_FILE),
          `${checksum}  ${archiveName}\n`,
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            process.env.AWEN_SERVER_PACKAGE_DIR = packageDir;
          }),
          () =>
            Effect.sync(() => {
              delete process.env.AWEN_SERVER_PACKAGE_DIR;
            }),
        );

        const manager = yield* SshEnvironmentManager;
        const bootstrap = yield* manager.ensureEnvironment(target);

        assert.equal(bootstrap.httpBaseUrl, "http://127.0.0.1:41773/");
        assert.equal(launches, 2);
        // Archive plus SHA256SUMS uploaded; nothing came from the release feed.
        assert.equal(scpUploads, 2);
        assert.isTrue(
          uploadProgress.some(
            (progress) =>
              progress.transferredBytes === 10 && progress.totalBytes === archiveBytes.length,
          ),
        );
        assert.deepEqual(
          httpUrls.filter((url) => url.includes("github")),
          [],
        );
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
  );
});

// The archive runner is generated shell; string assertions cannot prove the
// lock excludes concurrent installers. Run the real script against a tiny
// fake archive served from a file:// mirror.
describe("archive runner script", () => {
  const archiveVersion = "1.2.3-preview.20260911.4";

  const runRunner = (home: string, runner: string) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", [runner, "--version"], {
          env: { PATH: process.env.PATH ?? "", HOME: home },
          extendEnv: false,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    });

  // A fake "executable" that answers --version, packed the way the release
  // workflow packs the real archive: one top-level directory named after the
  // stem, checksummed in SHA256SUMS.
  const makeMirror = Effect.fn("makeMirror")(function* (root: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const stem = `awen-server-${archiveVersion}-linux-x64`;
    const stage = `${root}/stage/${stem}`;
    const release = `${root}/mirror/v${archiveVersion}`;
    const script = [
      "set -eu",
      `mkdir -p '${stage}/bin' '${release}'`,
      `printf '#!/bin/sh\\necho awen v${archiveVersion}\\n' > '${stage}/bin/awen'`,
      `chmod +x '${stage}/bin/awen'`,
      `tar -czf '${release}/${stem}.tar.gz' -C '${root}/stage' '${stem}'`,
      `cd '${release}' && (sha256sum '${stem}.tar.gz' 2>/dev/null || shasum -a 256 '${stem}.tar.gz') > SHA256SUMS`,
    ].join("\n");
    const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script]));
    assert.equal(Number(yield* child.exitCode), 0);
    return `file://${root}/mirror`;
  });

  it.effect(
    "installs once when several launches race, and reclaims stale locks",
    () =>
      Effect.gen(function* () {
        if (
          (yield* HostProcessPlatform) !== "linux" ||
          (yield* HostProcessArchitecture) !== "x64"
        ) {
          return;
        }
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "awen-archive-runner-" });
        const releaseBaseUrl = yield* makeMirror(root);
        const runner = `${root}/run-awen.sh`;
        yield* fs.writeFileString(
          runner,
          buildRemoteAwenRunnerScript({ archiveVersion, releaseBaseUrl }),
        );
        const home = `${root}/home`;
        yield* fs.makeDirectory(home, { recursive: true });

        const results = yield* Effect.all(
          [runRunner(home, runner), runRunner(home, runner), runRunner(home, runner)],
          { concurrency: "unbounded" },
        );
        for (const result of results) {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.include(result.stdout, `awen v${archiveVersion}`);
        }
        const versionsDir = `${home}/.awen/runtime/versions`;
        assert.deepEqual(yield* fs.readDirectory(versionsDir), [archiveVersion]);
        assert.equal(
          (yield* fs.readFileString(`${versionsDir}/${archiveVersion}/.install-complete`)).trim(),
          archiveVersion,
        );

        // A lock left by a crashed installer (dead pid) must not block the
        // next launch, and neither must one that never published a pid.
        const lock = `${versionsDir}/.${archiveVersion}.install.lock`;
        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.makeDirectory(lock);
        yield* fs.writeFileString(`${lock}/pid`, "999999\n");
        const afterDead = yield* runRunner(home, runner);
        assert.equal(afterDead.exitCode, 0, afterDead.stderr);

        yield* fs.remove(`${versionsDir}/${archiveVersion}`, { recursive: true });
        yield* fs.makeDirectory(lock);
        const afterUnowned = yield* runRunner(home, runner);
        assert.equal(afterUnowned.exitCode, 0, afterUnowned.stderr);
        assert.isFalse(yield* fs.exists(lock));
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
});
