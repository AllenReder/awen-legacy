// @effect-diagnostics nodeBuiltinImport:off -- Load the platform addon from its packaged resource path.
import * as NodeModule from "node:module";
import type { DesktopTrackpadInput } from "@awen/contracts";
import type { BrowserWindow } from "electron";

interface TrackpadAddon {
  start(handle: Buffer, listener: (input: DesktopTrackpadInput) => void): number;
  stop(id: number): void;
}

export function attachNativeTrackpad(window: BrowserWindow, addonPath: string): () => void {
  const require = NodeModule.createRequire(addonPath);
  const addon = require(addonPath) as TrackpadAddon;
  const id = addon.start(window.getNativeWindowHandle(), (input) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    const zoom = window.webContents.getZoomFactor();
    window.webContents.send("desktop:trackpad-input", {
      ...input,
      deltaX: input.deltaX / zoom,
      deltaY: input.deltaY / zoom,
      x: input.x / zoom,
      y: input.y / zoom,
    });
  });
  let closed = false;
  const stop = () => {
    if (!closed) {
      closed = true;
      addon.stop(id);
    }
  };
  window.once("closed", stop);
  return stop;
}
