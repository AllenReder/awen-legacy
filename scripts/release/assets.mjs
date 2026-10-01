import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function releaseAssetNames(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version))
    throw new Error("Invalid release version");
  return [
    `Awen-${version}-macos-arm64.dmg`,
    `Awen-${version}-macos-x64.dmg`,
    `Awen-${version}-windows-x64.exe`,
    `awen-server-${version}-linux-x64.tar.gz`,
  ].sort();
}

/** Reject extra files, symlinks, empty installers and checksum drift before publication. */
export async function verifyReleaseAssets(directory, version, assemble = false) {
  const names = releaseAssetNames(version);
  const actual = (await NodeFSP.readdir(directory)).sort();
  const expected = [...names, ...(assemble ? [] : ["SHA256SUMS"])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `Release inventory mismatch. Expected ${expected.join(", ")}; found ${actual.join(", ")}`,
    );
  const lines = [];
  for (const name of names) {
    const filename = NodePath.join(directory, name);
    const stat = await NodeFSP.lstat(filename);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid release asset: ${name}`);
    lines.push(
      `${NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(filename))
        .digest("hex")}  ${name}\n`,
    );
  }
  const checksums = lines.join("");
  const checksumFile = NodePath.join(directory, "SHA256SUMS");
  if (assemble) await NodeFSP.writeFile(checksumFile, checksums, { flag: "wx" });
  else if ((await NodeFSP.readFile(checksumFile, "utf8")) !== checksums)
    throw new Error("Release checksums do not match the verified assets");
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  const [mode, directory, version] = process.argv.slice(2);
  if (!["assemble", "verify"].includes(mode) || !directory || !version)
    throw new Error("Usage: assets.mjs assemble|verify <directory> <version>");
  await verifyReleaseAssets(directory, version, mode === "assemble");
}
