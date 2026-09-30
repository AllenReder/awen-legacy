/**
 * Operations for controlling desktop application window state (minimize, maximize, close).
 * Native Electron controls own production window operations.
 */

import { usesCustomWindowChrome } from "./utils";

export function isDesktopEnvironment(): boolean {
  if (typeof window === "undefined") return false;
  return window.desktopBridge !== undefined;
}

export interface WindowBridgeOperations {
  readonly minimize: () => Promise<void>;
  readonly toggleMaximize: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly isMaximized: () => Promise<boolean>;
  readonly isFullscreen: () => Promise<boolean>;
  readonly onResized?: (listener: () => void) => () => void;
}

// Electron owns caption controls and handles double clicks in draggable regions.
// Forced custom controls accept explicit operations (for isolated UI previews).
export const defaultWindowOperations: WindowBridgeOperations = {
  minimize: async () => {},
  toggleMaximize: async () => {},
  close: async () => {},
  isMaximized: async () => false,
  isFullscreen: async () =>
    typeof window !== "undefined"
      ? (window.desktopBridge?.getWindowFullscreenState?.() ?? false)
      : false,
};

export function handleTopbarDoubleClick(
  event: React.MouseEvent,
  operations: WindowBridgeOperations = defaultWindowOperations,
): void {
  if (
    typeof navigator === "undefined" ||
    !usesCustomWindowChrome(navigator.platform) ||
    !isDesktopEnvironment()
  ) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (
    target?.closest?.(
      "button, a, input, select, textarea, [data-no-drag], [role='tab'], [data-tab-id]",
    )
  ) {
    return;
  }
  void operations.toggleMaximize();
}
