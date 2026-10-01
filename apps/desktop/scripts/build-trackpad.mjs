/* oxlint-disable awen/no-global-process-runtime -- Compile the native addon for the build host. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

if (process.platform === "darwin") {
  const { values } = NodeUtil.parseArgs({
    options: { arch: { type: "string", default: process.arch } },
  });
  const architecture = { arm64: "arm64", x64: "x86_64" }[values.arch];
  if (!architecture) throw new Error(`Unsupported trackpad architecture: ${values.arch}`);
  const root = NodeURL.fileURLToPath(new URL("../../../native/trackpad/", import.meta.url));
  const output = NodePath.join(root, "build", values.arch, "awen-trackpad.node");
  const source = NodePath.join(root, "main.mm");
  let include = [
    NodePath.resolve(NodePath.dirname(process.execPath), "../include/node"),
    "/opt/homebrew/include/node",
    "/usr/local/include/node",
  ].find((directory) => NodeFS.existsSync(NodePath.join(directory, "node_api.h")));
  if (!include) {
    const cache = NodePath.join(NodeOS.tmpdir(), `awen-node-headers-${process.versions.node}`);
    NodeFS.mkdirSync(cache, { recursive: true });
    const archive = NodePath.join(cache, "headers.tar.gz");
    if (!NodeFS.existsSync(archive)) {
      const response = await fetch(
        `https://nodejs.org/dist/v${process.versions.node}/node-v${process.versions.node}-headers.tar.gz`,
      );
      if (!response.ok) throw new Error(`Cannot fetch Node headers: ${response.status}`);
      NodeFS.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    }
    NodeChildProcess.execFileSync("tar", ["-xzf", archive, "-C", cache]);
    include = NodePath.join(cache, `node-v${process.versions.node}`, "include/node");
  }
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  NodeChildProcess.execFileSync(
    "xcrun",
    [
      "clang++",
      "-std=c++17",
      "-fobjc-arc",
      "-dynamiclib",
      "-undefined",
      "dynamic_lookup",
      "-framework",
      "AppKit",
      "-DNAPI_VERSION=8",
      "-mmacosx-version-min=12.0",
      "-arch",
      architecture,
      "-I",
      include,
      source,
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
  NodeChildProcess.execFileSync("codesign", ["--force", "--sign", "-", output], {
    stdio: "inherit",
  });
}
