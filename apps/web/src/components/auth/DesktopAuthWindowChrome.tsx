import type { ReactNode } from "react";

import { MaterialSurface } from "../MaterialSurface";
import { WindowControls } from "../desktop/WindowControls";
import {
  handleTopbarDoubleClick,
  isDesktopEnvironment,
  type WindowBridgeOperations,
} from "../../lib/windowControls";
import { usesCustomWindowChrome } from "../../lib/utils";

export interface DesktopAuthWindowChromeProps {
  readonly children: ReactNode;
  readonly operations?: WindowBridgeOperations;
}

/**
 * Gives auth and pre-shell states the same frameless titlebar geometry as the
 * Workbench on Windows and Linux. Browser and macOS surfaces stay unchanged.
 */
export function DesktopAuthWindowChrome({ children, operations }: DesktopAuthWindowChromeProps) {
  const usesDesktopChrome =
    typeof navigator !== "undefined" &&
    isDesktopEnvironment() &&
    (Boolean(window.desktopBridge) || usesCustomWindowChrome(navigator.platform));

  if (!usesDesktopChrome) {
    return <>{children}</>;
  }

  return (
    <>
      <MaterialSurface
        kind="topbar"
        style={{
          paddingLeft: "var(--chrome-native-controls-left)",
        }}
        className="wco:pr-[var(--workspace-native-controls-inset)] drag-region fixed inset-x-0 top-0 z-50 flex h-[var(--workspace-topbar-height)] items-center border-b border-[var(--material-edge)]"
        data-slot="desktop-auth-window-chrome"
        onDoubleClick={(event) => handleTopbarDoubleClick(event, operations)}
      >
        <div
          aria-hidden
          className="h-full min-w-0 flex-1"
          data-slot="desktop-auth-window-chrome-drag-region"
        />
        {operations ? <WindowControls operations={operations} /> : <WindowControls />}
      </MaterialSurface>
      {children}
    </>
  );
}
