// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the filesystem pruning contract.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { assertReleaseTreePruned, pruneReleaseTree } from "./release-tree.ts";

const LINUX_X64 = { platform: "linux", arch: "x64" } as const;
const DARWIN_ARM64 = { platform: "darwin", arch: "arm64" } as const;

function makeTree(entries: ReadonlyArray<string>): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "awen-release-tree-"));
  for (const entry of entries) {
    const entryPath = NodePath.join(root, entry);
    NodeFS.mkdirSync(NodePath.dirname(entryPath), { recursive: true });
    NodeFS.writeFileSync(entryPath, "x");
  }
  return root;
}

function withTree<T>(entries: ReadonlyArray<string>, run: (root: string) => T): T {
  const root = makeTree(entries);
  try {
    return run(root);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

const PREBUILD_ENTRIES = [
  "node_modules/pty/prebuilds/darwin-arm64/pty.node",
  "node_modules/pty/prebuilds/darwin-x64/pty.node",
  "node_modules/pty/prebuilds/linux-arm64/pty.node",
  "node_modules/pty/prebuilds/linux-x64/pty.node",
  "node_modules/pty/prebuilds/win32-arm64/pty.node",
  "node_modules/pty/prebuilds/win32-x64/pty.node",
] as const;

describe("pruneReleaseTree", () => {
  it("removes source maps and debug symbols but keeps runtime files", () => {
    withTree(
      [
        "dist/bin.mjs",
        "dist/bin.mjs.map",
        "node_modules/pty/index.js",
        "node_modules/pty/build/Release/pty.node",
        "node_modules/pty/build/Release/pty.pdb",
      ],
      (root) => {
        const removed = pruneReleaseTree(root, LINUX_X64);

        expect(NodeFS.existsSync(NodePath.join(root, "dist/bin.mjs"))).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(root, "dist/bin.mjs.map"))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(root, "node_modules/pty/index.js"))).toBe(true);
        expect(
          NodeFS.existsSync(NodePath.join(root, "node_modules/pty/build/Release/pty.node")),
        ).toBe(true);
        expect(
          NodeFS.existsSync(NodePath.join(root, "node_modules/pty/build/Release/pty.pdb")),
        ).toBe(false);
        expect(removed).toEqual({ files: 2, bytes: 2 });
      },
    );
  });

  it("keeps only the target platform prebuilds", () => {
    withTree(PREBUILD_ENTRIES, (root) => {
      pruneReleaseTree(root, LINUX_X64);

      expect(NodeFS.existsSync(NodePath.join(root, "node_modules/pty/prebuilds/linux-x64"))).toBe(
        true,
      );
      for (const foreign of [
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "win32-arm64",
        "win32-x64",
      ]) {
        expect(
          NodeFS.existsSync(NodePath.join(root, "node_modules/pty/prebuilds", foreign)),
          foreign,
        ).toBe(false);
      }
    });
  });

  it("drops a platform directory the pruning rules never enumerated", () => {
    withTree(["node_modules/pty/prebuilds/aix-ppc64/pty.node"], (root) => {
      pruneReleaseTree(root, LINUX_X64);

      expect(NodeFS.existsSync(NodePath.join(root, "node_modules/pty/prebuilds/aix-ppc64"))).toBe(
        false,
      );
    });
  });

  it("keeps a sibling build of the target platform and arch, such as a musl prebuild", () => {
    withTree(["node_modules/pty/prebuilds/linuxmusl-x64/pty.node"], (root) => {
      pruneReleaseTree(root, LINUX_X64);

      expect(
        NodeFS.existsSync(NodePath.join(root, "node_modules/pty/prebuilds/linuxmusl-x64")),
      ).toBe(true);
    });
  });

  it("keeps the prebuilds of a different target so the desktop release keeps its own platform", () => {
    withTree(PREBUILD_ENTRIES, (root) => {
      pruneReleaseTree(root, DARWIN_ARM64);

      expect(
        NodeFS.existsSync(NodePath.join(root, "node_modules/pty/prebuilds/darwin-arm64")),
      ).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(root, "node_modules/pty/prebuilds/linux-x64"))).toBe(
        false,
      );
    });
  });

  it("leaves entries under prebuilds alone when they do not name a platform", () => {
    withTree(
      ["node_modules/pty/prebuilds/README.md", "node_modules/pty/prebuilds/shared/tool.node"],
      (root) => {
        pruneReleaseTree(root, LINUX_X64);

        expect(NodeFS.existsSync(NodePath.join(root, "node_modules/pty/prebuilds/README.md"))).toBe(
          true,
        );
        expect(
          NodeFS.existsSync(NodePath.join(root, "node_modules/pty/prebuilds/shared/tool.node")),
        ).toBe(true);
      },
    );
  });

  it("refuses a target that cannot name a prebuild directory", () => {
    withTree(["node_modules/pty/prebuilds/win32-x64/pty.node"], (root) => {
      expect(() => pruneReleaseTree(root, { platform: "win", arch: "x64" })).toThrow(
        /Unsupported release platform/u,
      );
    });
  });
});

describe("assertReleaseTreePruned", () => {
  it("accepts a pruned tree", () => {
    withTree(["dist/bin.mjs", "node_modules/pty/prebuilds/linux-x64/pty.node"], (root) => {
      pruneReleaseTree(root, LINUX_X64);

      expect(() => assertReleaseTreePruned(root, LINUX_X64)).not.toThrow();
    });
  });

  it("names the source map, debug symbol, and foreign platform directory it finds", () => {
    withTree(
      [
        "dist/bin.mjs.map",
        "node_modules/pty/build/Release/pty.pdb",
        "node_modules/pty/prebuilds/win32-x64/pty.node",
      ],
      (root) => {
        expect(() => assertReleaseTreePruned(root, LINUX_X64)).toThrow(/bin\.mjs\.map/u);
        expect(() => assertReleaseTreePruned(root, LINUX_X64)).toThrow(/3 release-only entries/u);
      },
    );
  });

  it("names a platform directory outside the enumerated platforms", () => {
    withTree(["node_modules/pty/prebuilds/aix-ppc64/pty.node"], (root) => {
      expect(() => assertReleaseTreePruned(root, LINUX_X64)).toThrow(/aix-ppc64/u);
    });
  });
});
