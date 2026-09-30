// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  assertLinkFreeRuntime,
  nodeRuntimeCachePath,
  readNodeShasum,
  readStageArguments,
  removeNodeModulesBinShims,
  resolveDesktopRuntimeTarget,
  resolveNodeRuntimeCache,
  resolveRuntimeNodeVersion,
  runtimeNodeDownload,
  sha256File,
} from "./stage-desktop-runtime.ts";

const WIN_EXE_SHA = "e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50";
const DARWIN_ARM64_SHA = "8c039d59f2fec6195e4281ad5b0d02b9a940897b4df7b849c6fb48be6787bba6";
const PUBLISHED_SHASUMS = [
  `${DARWIN_ARM64_SHA}  node-v24.13.1-darwin-arm64.tar.gz`,
  "527f0578d9812e7dfa225121bda0b1546a6a0e4b5f556295fc8299c272de5fbf  node-v24.13.1-darwin-x64.tar.gz",
  `${WIN_EXE_SHA}  win-x64/node.exe`,
  "",
].join("\n");

describe("desktop runtime targets", () => {
  it("maps the platforms and architectures the release builds", () => {
    expect(resolveDesktopRuntimeTarget("darwin", "arm64")).toEqual({
      platform: "darwin",
      arch: "arm64",
      nodeName: "node",
    });
    expect(resolveDesktopRuntimeTarget("darwin", "x64").arch).toBe("x64");
    expect(resolveDesktopRuntimeTarget("win32", "x64").nodeName).toBe("node.exe");
    expect(resolveDesktopRuntimeTarget("linux", "x64").platform).toBe("linux");
  });

  it("refuses a platform it cannot stage a runtime for", () => {
    expect(() => resolveDesktopRuntimeTarget("freebsd", "x64")).toThrow(
      /Unsupported desktop runtime target/u,
    );
  });
});

describe("embedded Node version", () => {
  it("reads the exact version and the caret range the manifest uses", () => {
    expect(resolveRuntimeNodeVersion("24.13.1")).toBe("24.13.1");
    expect(resolveRuntimeNodeVersion("^24.13.1")).toBe("24.13.1");
  });

  it("refuses a range that cannot be downloaded as one version", () => {
    expect(() => resolveRuntimeNodeVersion(">=24")).toThrow(/exact engines.node version/u);
    expect(() => resolveRuntimeNodeVersion(undefined)).toThrow(/exact engines.node version/u);
  });
});

describe("runtime Node downloads", () => {
  it("takes the Windows executable straight from the dist directory", () => {
    const download = runtimeNodeDownload("24.13.1", resolveDesktopRuntimeTarget("win32", "x64"));
    expect(download.url).toBe("https://nodejs.org/dist/v24.13.1/win-x64/node.exe");
    expect(download.checksumName).toBe("win-x64/node.exe");
    expect(download.archive).toBe(false);
  });

  it("unpacks the macOS and Linux tarballs", () => {
    const download = runtimeNodeDownload("24.13.1", resolveDesktopRuntimeTarget("darwin", "x64"));
    expect(download.url).toBe("https://nodejs.org/dist/v24.13.1/node-v24.13.1-darwin-x64.tar.gz");
    expect(download.checksumName).toBe("node-v24.13.1-darwin-x64.tar.gz");
    expect(download.archive).toBe(true);
    expect(download.entryPath).toBe("node-v24.13.1-darwin-x64/bin/node");
  });
});

describe("published checksums", () => {
  it("finds the digest the download is verified against", () => {
    expect(readNodeShasum(PUBLISHED_SHASUMS, "win-x64/node.exe")).toBe(WIN_EXE_SHA);
    expect(readNodeShasum(PUBLISHED_SHASUMS, "node-v24.13.1-darwin-arm64.tar.gz")).toBe(
      DARWIN_ARM64_SHA,
    );
  });

  it("fails when the file has no published digest", () => {
    expect(() => readNodeShasum(PUBLISHED_SHASUMS, "node-v24.13.1-win-x64.zip")).toThrow(
      /No SHA256 entry/u,
    );
  });
});

describe("stage arguments", () => {
  it("defaults to the host and supports explicit platform and architecture", () => {
    expect(readStageArguments([])).toEqual({});
    expect(readStageArguments(["--platform", "darwin", "--arch=x64"])).toEqual({
      platform: "darwin",
      arch: "x64",
    });
    expect(() => readStageArguments(["--target", "x86_64-apple-darwin"])).toThrow(
      /Unknown argument/,
    );
    expect(() => readStageArguments(["--arch"])).toThrow(/needs a value/);
    expect(() => readStageArguments(["--platform=freebsd"])).toThrow(/Unsupported/);
  });
});

describe("runtime download cache", () => {
  it("uses the configured cache directory and falls back to the temp directory", () => {
    const fallback = NodePath.join(NodeOS.tmpdir(), "awen-node-runtime");
    expect(resolveNodeRuntimeCache({})).toBe(fallback);
    expect(resolveNodeRuntimeCache({ AWEN_NODE_RUNTIME_CACHE: "   " })).toBe(fallback);
    expect(resolveNodeRuntimeCache({ AWEN_NODE_RUNTIME_CACHE: "/tmp/awen-cache" })).toBe(
      "/tmp/awen-cache",
    );
  });

  it("keys a cached build by version and target", () => {
    expect(
      nodeRuntimeCachePath(
        "/cache",
        "24.13.1",
        resolveDesktopRuntimeTarget("win32", "x64"),
        "node.exe",
      ),
    ).toBe("/cache/v24.13.1/win32-x64/node.exe");
    expect(
      nodeRuntimeCachePath(
        "/cache",
        "24.13.1",
        resolveDesktopRuntimeTarget("darwin", "arm64"),
        "node-v24.13.1-darwin-arm64.tar.gz",
      ),
    ).toBe("/cache/v24.13.1/darwin-arm64/node-v24.13.1-darwin-arm64.tar.gz");
  });

  it("digests a cached file so a reused download is verified again", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "awen-runtime-hash-"));
    try {
      const filePath = NodePath.join(directory, "empty");
      NodeFS.writeFileSync(filePath, "");
      expect(sha256File(filePath)).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("staged desktop runtime layout", () => {
  const makeRuntimeDir = (): string =>
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "awen-runtime-layout-"));

  it("accepts a runtime built from real files", () => {
    const runtimeDir = makeRuntimeDir();
    try {
      const packageDir = NodePath.join(runtimeDir, "node_modules", "effect");
      NodeFS.mkdirSync(packageDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(packageDir, "package.json"), "{}");
      expect(() => assertLinkFreeRuntime(runtimeDir)).not.toThrow();
    } finally {
      NodeFS.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("rejects a runtime that resolves a dependency through a link", () => {
    const runtimeDir = makeRuntimeDir();
    const linkedTarget = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "awen-runtime-link-target-"),
    );
    try {
      NodeFS.mkdirSync(NodePath.join(runtimeDir, "node_modules"), { recursive: true });
      NodeFS.symlinkSync(
        linkedTarget,
        NodePath.join(runtimeDir, "node_modules", "effect"),
        "junction",
      );
      expect(() => assertLinkFreeRuntime(runtimeDir)).toThrow(/symlinks or junctions/u);
    } finally {
      NodeFS.rmSync(runtimeDir, { recursive: true, force: true });
      NodeFS.rmSync(linkedTarget, { recursive: true, force: true });
    }
  });

  it("drops the executable shims, whose entries are links on POSIX", () => {
    const runtimeDir = makeRuntimeDir();
    try {
      const binDir = NodePath.join(runtimeDir, "node_modules", ".bin");
      NodeFS.mkdirSync(binDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(binDir, "yaml"), "shim");
      removeNodeModulesBinShims(runtimeDir);
      expect(NodeFS.existsSync(binDir)).toBe(false);
      expect(() => assertLinkFreeRuntime(runtimeDir)).not.toThrow();
    } finally {
      NodeFS.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
