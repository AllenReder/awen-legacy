// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);

/** Import only a user-selected image into the desktop's persistent resources. */
export async function importDesktopArtwork(
  filePath: string,
  stateDir: string,
  isDevelopment: boolean,
): Promise<string> {
  const extension = NodePath.extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension))
    throw new Error("Select a PNG, JPEG, WebP, GIF or AVIF image.");
  const info = await NodeFSP.stat(filePath);
  if (!info.isFile() || info.size > 32 * 1024 * 1024)
    throw new Error("Artwork must be an image smaller than 32 MB.");
  const contents = await NodeFSP.readFile(filePath);
  const name = `${NodeCrypto.createHash("sha256").update(contents).digest("hex")}${extension}`;
  const directory = NodePath.join(stateDir, "artwork");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(NodePath.join(directory, name), contents, { mode: 0o600 });
  return new URL(`artwork/${name}`, getDesktopUrl(isDevelopment)).href;
}
