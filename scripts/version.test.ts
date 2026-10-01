// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { checkVersion, setVersion } from "./version.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const VERSIONED_FILES = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "apps/desktop/package.json",
  "packages/contracts/package.json",
];

function withVersionFixture(run: (rootDir: string) => void): void {
  const rootDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "awen-version-"));
  try {
    for (const relativePath of VERSIONED_FILES) {
      const target = NodePath.join(rootDir, relativePath);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.copyFileSync(NodePath.join(REPO_ROOT, relativePath), target);
    }
    run(rootDir);
  } finally {
    NodeFS.rmSync(rootDir, { recursive: true, force: true });
  }
}

describe("product version", () => {
  it("keeps the checked-in manifests aligned", () => {
    expect(checkVersion()).toEqual([]);
  });

  it("updates every product manifest from one version", () => {
    withVersionFixture((rootDir) => {
      const desktopPath = NodePath.join(rootDir, "apps/desktop/package.json");
      const initial = JSON.parse(NodeFS.readFileSync(desktopPath, "utf8"));
      const nextBuild = String(Number(initial.build.mac.bundleVersion) + 1);
      setVersion("1.2.3-rc.1", rootDir);
      expect(checkVersion(rootDir)).toEqual([]);
      const desktop = JSON.parse(NodeFS.readFileSync(desktopPath, "utf8"));
      expect(desktop.version).toBe("1.2.3-rc.1");
      expect(desktop.build.mac.bundleVersion).toBe(nextBuild);
      const original = NodeFS.readFileSync(desktopPath, "utf8");
      setVersion("1.2.3-rc.1", rootDir);
      expect(NodeFS.readFileSync(desktopPath, "utf8")).toBe(original);
    });
  });

  it("reports drift and rejects an invalid version before editing", () => {
    withVersionFixture((rootDir) => {
      const webPackagePath = NodePath.join(rootDir, "apps/web/package.json");
      const original = NodeFS.readFileSync(webPackagePath, "utf8");
      const currentVersion = JSON.parse(original).version as string;
      expect(() => setVersion("latest", rootDir)).toThrow(/exact semver-like/u);
      expect(() => setVersion("0.1.0-alpha.01", rootDir)).toThrow(/exact semver-like/u);
      expect(NodeFS.readFileSync(webPackagePath, "utf8")).toBe(original);

      NodeFS.writeFileSync(
        webPackagePath,
        original.replace(`"version": "${currentVersion}"`, '"version": "9.9.9"'),
      );
      expect(checkVersion(rootDir)).toContain(
        `apps/web/package.json: expected ${currentVersion}, found 9.9.9.`,
      );
    });
  });
});
