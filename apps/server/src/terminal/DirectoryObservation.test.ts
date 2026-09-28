import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import {
  makeTerminalDirectoryObserver,
  resolveWorkspaceAssignmentForDirectory,
  terminalDirectoryObservationCapability,
  unsupportedTerminalDirectoryObserver,
} from "./DirectoryObservation.ts";

type DirectoryObserver = ReturnType<typeof makeTerminalDirectoryObserver>;

const runOutput = (
  stdout: string,
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: 0 as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const fakeProcessRunner = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
): ProcessRunner.ProcessRunner["Service"] => ({ run }) as ProcessRunner.ProcessRunner["Service"];

const fakeFileSystem = (readLink: (path: string) => Effect.Effect<string, unknown>) =>
  ({ readLink }) as unknown as FileSystem.FileSystem;

const observerForLinux = (
  readLink: (path: string) => Effect.Effect<string, unknown>,
): DirectoryObserver =>
  makeTerminalDirectoryObserver({
    platform: "linux",
    fileSystem: fakeFileSystem(readLink),
    processRunner: fakeProcessRunner(() => Effect.die("unexpected lsof")),
  });

describe("terminalDirectoryObservationCapability", () => {
  it("documents the supported platform matrix", () => {
    expect(terminalDirectoryObservationCapability("linux")).toMatchObject({
      supported: true,
      mechanism: "procfs",
    });
    expect(terminalDirectoryObservationCapability("darwin")).toMatchObject({
      supported: true,
      mechanism: "lsof",
    });
    expect(terminalDirectoryObservationCapability("win32")).toMatchObject({
      supported: false,
      mechanism: "none",
    });
    expect(terminalDirectoryObservationCapability("freebsd")).toMatchObject({
      supported: false,
      mechanism: "none",
    });
  });
});

describe("resolveWorkspaceAssignmentForDirectory", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })(
    "maps registered ancestors and leaves unregistered paths unassigned",
    (it) => {
      it.effect("prefers the deepest matching checkout", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const workspaces = [
            { workspaceId: "workspace:main", workspaceRoot: "/repo" },
            { workspaceId: "workspace:sibling", workspaceRoot: "/repo-sibling" },
            { workspaceId: "workspace:nested", workspaceRoot: "/repo/nested" },
          ];
          expect(resolveWorkspaceAssignmentForDirectory(workspaces, "/repo/src", path)).toBe(
            "workspace:main",
          );
          expect(resolveWorkspaceAssignmentForDirectory(workspaces, "/repo", path)).toBe(
            "workspace:main",
          );
          expect(resolveWorkspaceAssignmentForDirectory(workspaces, "/repo/nested/a", path)).toBe(
            "workspace:nested",
          );
          expect(resolveWorkspaceAssignmentForDirectory(workspaces, "/repo-sibling", path)).toBe(
            "workspace:sibling",
          );
          expect(resolveWorkspaceAssignmentForDirectory(workspaces, "/tmp/elsewhere", path)).toBe(
            null,
          );
          // A string prefix is not a path boundary.
          expect(resolveWorkspaceAssignmentForDirectory(workspaces, "/repository", path)).toBe(
            null,
          );
        }),
      );
    },
  );
});

describe("makeTerminalDirectoryObserver", () => {
  it("reads /proc/<pid>/cwd on linux", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const observer = observerForLinux((target) => {
        seen.push(target);
        return Effect.succeed("/home/dev/checkout/nested");
      });
      expect(observer.capability.supported).toBe(true);
      expect(yield* observer.observe(4321)).toEqual({
        kind: "known",
        directory: "/home/dev/checkout/nested",
      });
      expect(seen).toEqual(["/proc/4321/cwd"]);
    }).pipe(Effect.runPromise));

  it("treats a removed or unreadable cwd as unknown", () =>
    Effect.gen(function* () {
      const removed = observerForLinux(() => Effect.succeed("/home/dev/gone (deleted)"));
      expect(yield* removed.observe(4321)).toEqual({ kind: "unknown", reason: "unavailable" });

      const missing = observerForLinux(() => Effect.fail("readLink failed"));
      expect(yield* missing.observe(4321)).toEqual({ kind: "unknown", reason: "unavailable" });
    }).pipe(Effect.runPromise));

  it("parses lsof output on darwin", () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<string>> = [];
      const observer = makeTerminalDirectoryObserver({
        platform: "darwin",
        fileSystem: fakeFileSystem(() => Effect.die("unexpected readLink")),
        processRunner: fakeProcessRunner((input) => {
          seen.push(input.args);
          return Effect.succeed(runOutput("p1234\nfcwd\nn/Users/dev/checkout\n"));
        }),
        lsofCommand: "lsof",
      });
      expect(yield* observer.observe(1234)).toEqual({
        kind: "known",
        directory: "/Users/dev/checkout",
      });
      expect(seen[0]).toEqual(["-a", "-p", "1234", "-d", "cwd", "-Fn"]);
    }).pipe(Effect.runPromise));

  it("reports unavailable when lsof has no directory or fails", () =>
    Effect.gen(function* () {
      const noDirectory = makeTerminalDirectoryObserver({
        platform: "darwin",
        fileSystem: fakeFileSystem(() => Effect.die("unexpected readLink")),
        processRunner: fakeProcessRunner(() => Effect.succeed(runOutput("p1234\n"))),
      });
      expect(yield* noDirectory.observe(1234)).toEqual({ kind: "unknown", reason: "unavailable" });

      const failing = makeTerminalDirectoryObserver({
        platform: "darwin",
        fileSystem: fakeFileSystem(() => Effect.die("unexpected readLink")),
        processRunner: fakeProcessRunner(() =>
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: "lsof",
              argumentCount: 6,
              cause: "missing",
            }),
          ),
        ),
      });
      expect(yield* failing.observe(1234)).toEqual({ kind: "unknown", reason: "unavailable" });
    }).pipe(Effect.runPromise));

  it("always reports unknown on unsupported platforms", () =>
    Effect.gen(function* () {
      const observer = makeTerminalDirectoryObserver({
        platform: "win32",
        fileSystem: fakeFileSystem(() => Effect.die("unexpected readLink")),
        processRunner: fakeProcessRunner(() => Effect.die("unexpected lsof")),
      });
      expect(observer.capability.supported).toBe(false);
      expect(yield* observer.observe(1234)).toEqual({ kind: "unknown", reason: "unsupported" });

      const unsupported = unsupportedTerminalDirectoryObserver("win32");
      expect(yield* unsupported.observe(1)).toEqual({ kind: "unknown", reason: "unsupported" });
    }).pipe(Effect.runPromise));
});
