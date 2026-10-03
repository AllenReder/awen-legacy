import { assert, describe, it } from "@effect/vitest";
import type { DesktopSshEnvironmentTarget } from "@awen/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@awen/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  classifySshHostKeyTrust,
  confirmedHostKeyLine,
  fingerprintHostKey,
  knownHostsLookupHost,
  trustSshHostKey,
} from "./trust.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "allen",
  port: 22,
};

const KEY_A = "AAAAC3NzaC1lZDI1NTE5AAAAIKeyA";
const KEY_B = "AAAAC3NzaC1lZDI1NTE5AAAAIKeyB";
const RSA_KEY = "AAAAB3NzaC1yc2EAAAADAQABAAABKey";

const keyscanOutput = (key = KEY_A) =>
  [
    "# devbox.example.test:22 SSH-2.0-OpenSSH_9.9",
    `devbox.example.test ssh-ed25519 ${key}`,
    `devbox.example.test ssh-rsa ${RSA_KEY}`,
    "",
  ].join("\n");

const knownHostsOutput = (key = KEY_A) =>
  ["# Host devbox.example.test found: line 3", `devbox.example.test ssh-ed25519 ${key}`, ""].join(
    "\n",
  );

const makeSuccessfulProcess = (stdout: string) => {
  const output = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: output,
    stderr: Stream.empty,
    all: output,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeFailedProcess = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const makeTrustSpawner = () =>
  ChildProcessSpawner.make((command) =>
    Effect.succeed(
      command._tag === "StandardCommand" && command.command === "ssh-keygen"
        ? makeFailedProcess()
        : makeSuccessfulProcess(keyscanOutput()),
    ),
  );

describe("classifySshHostKeyTrust", () => {
  it("looks up known hosts by resolved hostname and non-default port, without username", () => {
    assert.equal(knownHostsLookupHost(TARGET), "devbox.example.test");
    assert.equal(knownHostsLookupHost({ ...TARGET, port: 6000 }), "[devbox.example.test]:6000");
  });

  it("formats OpenSSH SHA256 fingerprints from presented key bytes", () => {
    const first = Buffer.from("first key").toString("base64");
    const second = Buffer.from("second key").toString("base64");
    assert.match(fingerprintHostKey(first), /^SHA256:[A-Za-z0-9+/]+$/u);
    assert.notEqual(fingerprintHostKey(first), fingerprintHostKey(second));
  });

  it("accepts only the exact host key confirmed by the user", () => {
    const key = Buffer.from("confirmed key").toString("base64");
    const changed = Buffer.from("changed key").toString("base64");
    const fingerprint = fingerprintHostKey(key);
    assert.equal(
      confirmedHostKeyLine(keyscanOutput(key), TARGET, "ssh-ed25519", fingerprint),
      `devbox.example.test ssh-ed25519 ${key}`,
    );
    assert.equal(
      confirmedHostKeyLine(keyscanOutput(changed), TARGET, "ssh-ed25519", fingerprint),
      null,
    );
  });
  it("trusts a known host when a scanned key matches the known_hosts entry", () => {
    const result = classifySshHostKeyTrust(knownHostsOutput(), keyscanOutput(), TARGET);
    assert.deepEqual(result, { status: "trusted", keyType: null });
  });

  it("blocks when the scanned key for a known key type changed", () => {
    const result = classifySshHostKeyTrust(knownHostsOutput(), keyscanOutput(KEY_B), TARGET);
    assert.equal(result.status, "changed");
    assert.equal(result.keyType, "ssh-ed25519");
  });

  it("treats a host with no known_hosts entry as new", () => {
    const result = classifySshHostKeyTrust("", keyscanOutput(), TARGET);
    assert.equal(result.status, "new");
    assert.equal(result.keyType, "ssh-ed25519");
  });

  it("stays trusted when the host is unreachable but a known_hosts entry exists", () => {
    const result = classifySshHostKeyTrust(knownHostsOutput(), "", TARGET);
    assert.deepEqual(result, { status: "trusted", keyType: null });
  });

  it("reports a new host with no key material when nothing scans and nothing is known", () => {
    const result = classifySshHostKeyTrust("", "", TARGET);
    assert.deepEqual(result, { status: "new", keyType: null });
  });

  it("blocks when every scanned key type is absent or different in known_hosts", () => {
    // Host was reimaged and now only serves RSA; the known ed25519 key is gone.
    const scanned = `devbox.example.test ssh-rsa ${RSA_KEY}\n`;
    const result = classifySshHostKeyTrust(knownHostsOutput(), scanned, TARGET);
    assert.equal(result.status, "changed");
  });

  it("reads hashed known_hosts entries matched by ssh-keygen -F", () => {
    const hashed = "|1|salt==|hash== ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyA\n";
    const result = classifySshHostKeyTrust(hashed, keyscanOutput(), TARGET);
    assert.equal(result.status, "trusted");
  });

  it("matches non-default ports with the bracketed host prefix", () => {
    const target: DesktopSshEnvironmentTarget = { ...TARGET, port: 2222 };
    const scanned = `[devbox.example.test]:2222 ssh-ed25519 ${KEY_B}\n`;
    const known = `[devbox.example.test]:2222 ssh-ed25519 ${KEY_A}\n`;
    const result = classifySshHostKeyTrust(known, scanned, target);
    assert.equal(result.status, "changed");
  });

  it("ignores keyscan lines for other hosts", () => {
    const scanned = `other.example.test ssh-ed25519 ${KEY_B}\n`;
    const result = classifySshHostKeyTrust("", scanned, TARGET);
    assert.deepEqual(result, { status: "new", keyType: null });
  });

  it.effect("writes a confirmed key under USERPROFILE on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "awen-ssh-home-" });

      yield* trustSshHostKey(TARGET, "ssh-ed25519", fingerprintHostKey(KEY_A)).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, { USERPROFILE: home }),
      );

      assert.equal(
        yield* fs.readFileString(path.join(home, ".ssh", "known_hosts")),
        `devbox.example.test ssh-ed25519 ${KEY_A}\n`,
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, makeTrustSpawner()),
        ),
      ),
      Effect.scoped,
    ),
  );
});
