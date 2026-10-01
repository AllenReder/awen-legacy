import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../env", () => ({
  get isElectron() {
    return typeof window !== "undefined" && window.desktopBridge !== undefined;
  },
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children?: ReactNode }) => children,
  TooltipTrigger: ({ render }: { readonly render?: ReactNode }) => render ?? null,
  TooltipPopup: () => null,
}));

import { DesktopAuthWindowChrome } from "./DesktopAuthWindowChrome";
import { PairingPendingSurface } from "./PairingRouteSurface";
import type { WindowBridgeOperations } from "../../lib/windowControls";

function createOperations(): WindowBridgeOperations {
  return {
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    isFullscreen: vi.fn().mockResolvedValue(false),
  };
}

describe("DesktopAuthWindowChrome", () => {
  let renderer: ReactTestRenderer;

  afterEach(async () => {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reserves native controls on the Linux Electron pairing surface", () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });

    const html = renderToStaticMarkup(<PairingPendingSurface />);

    expect(html).toContain('data-slot="desktop-auth-window-chrome"');
    expect(html).toContain('data-slot="desktop-auth-window-chrome-drag-region"');
    expect(html).toContain("drag-region");
    expect(html).not.toContain('data-slot="window-controls"');
    expect(html).not.toContain('aria-label="Minimize"');
    expect(html).not.toContain('aria-label="Maximize"');
    expect(html).not.toContain('aria-label="Close"');
    expect(html).toContain("Pairing with this environment");
  });

  it("does not render window chrome in a browser", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });

    const html = renderToStaticMarkup(<PairingPendingSurface />);

    expect(html).not.toContain("desktop-auth-window-chrome");
    expect(html).not.toContain('data-slot="window-controls"');
    expect(html).toContain("Pairing with this environment");
  });

  it("toggles maximize when double-clicking the non-interactive titlebar", async () => {
    const operations = createOperations();
    vi.stubGlobal("window", { desktopBridge: {} });
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });

    await act(() => {
      renderer = create(
        <DesktopAuthWindowChrome operations={operations}>
          <div>Auth content</div>
        </DesktopAuthWindowChrome>,
      );
    });

    const titlebar = renderer.root.findByProps({
      "data-slot": "desktop-auth-window-chrome",
    });
    await act(() => {
      titlebar.props.onDoubleClick({ target: { closest: () => null } });
    });

    expect(operations.toggleMaximize).toHaveBeenCalledTimes(1);
  });
});
