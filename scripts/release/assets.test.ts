// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { releaseAssetNames, verifyReleaseAssets } from "./assets.mjs";

describe("final release inventory", () => {
  it("verifies only the four installers and catches asset tampering", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "awen-assets-"));
    try {
      const names = releaseAssetNames("0.1.0-alpha.4");
      for (const name of names) await NodeFSP.writeFile(NodePath.join(dir, name), "installer");
      await verifyReleaseAssets(dir, "0.1.0-alpha.4", true);
      await verifyReleaseAssets(dir, "0.1.0-alpha.4");
      await NodeFSP.writeFile(NodePath.join(dir, names[0]!), "tampered");
      await expect(verifyReleaseAssets(dir, "0.1.0-alpha.4")).rejects.toThrow(/checksums/);
      await NodeFSP.writeFile(NodePath.join(dir, "latest.yml"), "obsolete");
      await expect(verifyReleaseAssets(dir, "0.1.0-alpha.4")).rejects.toThrow(/inventory/);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects missing, empty and linked installers", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "awen-assets-"));
    try {
      await expect(verifyReleaseAssets(dir, "0.1.0", true)).rejects.toThrow(/inventory/);
      const names = releaseAssetNames("0.1.0");
      for (const name of names) await NodeFSP.writeFile(NodePath.join(dir, name), "");
      await expect(verifyReleaseAssets(dir, "0.1.0", true)).rejects.toThrow(
        /Invalid release asset/,
      );
      for (const name of names) await NodeFSP.writeFile(NodePath.join(dir, name), "installer");
      await NodeFSP.rm(NodePath.join(dir, names[0]!));
      await NodeFSP.symlink(names[1]!, NodePath.join(dir, names[0]!));
      await expect(verifyReleaseAssets(dir, "0.1.0", true)).rejects.toThrow(
        /Invalid release asset/,
      );
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});
