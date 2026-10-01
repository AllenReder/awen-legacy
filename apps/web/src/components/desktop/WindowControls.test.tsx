import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { WindowControls } from "./WindowControls";
import {
  defaultWindowOperations,
  handleTopbarDoubleClick,
  type WindowBridgeOperations,
} from "../../lib/windowControls";

describe("WindowControls", () => {
  let renderer: ReactTestRenderer;

  afterEach(async () => {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  it("does not render in standard non-desktop or macOS environments", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(() => {
      renderer = create(<WindowControls />);
    });
    expect(renderer.toJSON()).toBeNull();
  });

  it("renders 3 control buttons when forced visible", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(() => {
      renderer = create(<WindowControls forceVisible />);
    });
    const buttons = renderer.root.findAllByType("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.props["aria-label"]).toBe("Minimize");
    expect(buttons[1]?.props["aria-label"]).toBe("Maximize");
    expect(buttons[2]?.props["aria-label"]).toBe("Close");
  });

  it("marks all control buttons with no-drag and 46px width", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(() => {
      renderer = create(<WindowControls forceVisible />);
    });
    const buttons = renderer.root.findAllByType("button");
    for (const button of buttons) {
      expect(button.props.className).toContain("[-webkit-app-region:no-drag]");
      expect(button.props.className).toContain("w-[46px]");
    }
  });

  it("applies Windows red hover styling to the close button", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await act(() => {
      renderer = create(<WindowControls forceVisible />);
    });
    const closeBtn = renderer.root.findByProps({ "aria-label": "Close" });
    expect(closeBtn.props.className).toContain(
      "hover:bg-[var(--window-control-close-hover,#e81123)]",
    );
    expect(closeBtn.props.className).toContain("hover:text-white");
  });

  it("triggers minimize, toggleMaximize, and close operations when clicked", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const operations: WindowBridgeOperations = {
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      isMaximized: vi.fn().mockResolvedValue(false),
      isFullscreen: vi.fn().mockResolvedValue(false),
    };

    await act(() => {
      renderer = create(<WindowControls forceVisible operations={operations} />);
    });

    const minimizeBtn = renderer.root.findByProps({ "aria-label": "Minimize" });
    const maximizeBtn = renderer.root.findByProps({ "aria-label": "Maximize" });
    const closeBtn = renderer.root.findByProps({ "aria-label": "Close" });

    await act(() => {
      minimizeBtn.props.onClick();
    });
    expect(operations.minimize).toHaveBeenCalledTimes(1);

    await act(() => {
      maximizeBtn.props.onClick();
    });
    expect(operations.toggleMaximize).toHaveBeenCalledTimes(1);

    await act(() => {
      closeBtn.props.onClick();
    });
    expect(operations.close).toHaveBeenCalledTimes(1);
  });

  it("shows Restore label when window is maximized", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const operations: WindowBridgeOperations = {
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      isMaximized: vi.fn().mockResolvedValue(true),
      isFullscreen: vi.fn().mockResolvedValue(false),
    };

    await act(async () => {
      renderer = create(<WindowControls forceVisible operations={operations} />);
    });

    const restoreBtn = renderer.root.findByProps({ "aria-label": "Restore" });
    expect(restoreBtn).toBeDefined();
    expect(renderer.root.findAllByProps({ "aria-label": "Maximize" })).toHaveLength(0);
  });

  it("updates maximize/restore state when resize listener triggers", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let resizeCallback: (() => void) | null = null;
    let isMax = false;

    const operations: WindowBridgeOperations = {
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      isMaximized: vi.fn().mockImplementation(() => Promise.resolve(isMax)),
      isFullscreen: vi.fn().mockResolvedValue(false),
      onResized: (listener) => {
        resizeCallback = listener;
        return () => {
          resizeCallback = null;
        };
      },
    };

    await act(async () => {
      renderer = create(<WindowControls forceVisible operations={operations} />);
    });

    expect(renderer.root.findByProps({ "aria-label": "Maximize" })).toBeDefined();

    // Now window state changes to maximized
    isMax = true;
    await act(async () => {
      resizeCallback?.();
    });

    expect(renderer.root.findByProps({ "aria-label": "Restore" })).toBeDefined();
  });

  describe("handleTopbarDoubleClick", () => {
    it("does not toggle maximize on macOS", () => {
      const toggleSpy = vi
        .spyOn(defaultWindowOperations, "toggleMaximize")
        .mockResolvedValue(undefined);
      vi.stubGlobal("window", { desktopBridge: {} });
      vi.stubGlobal("navigator", { platform: "MacIntel" });

      const target = { closest: () => null } as unknown as HTMLElement;
      handleTopbarDoubleClick({ target } as unknown as React.MouseEvent);

      expect(toggleSpy).not.toHaveBeenCalled();
      toggleSpy.mockRestore();
    });

    it("does not toggle maximize when in a non-desktop browser on Windows", () => {
      const toggleSpy = vi
        .spyOn(defaultWindowOperations, "toggleMaximize")
        .mockResolvedValue(undefined);
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", { platform: "Win32" });

      const target = { closest: () => null } as unknown as HTMLElement;
      handleTopbarDoubleClick({ target } as unknown as React.MouseEvent);

      expect(toggleSpy).not.toHaveBeenCalled();
      toggleSpy.mockRestore();
    });

    it("does not toggle maximize when in a non-desktop browser on Linux", () => {
      const toggleSpy = vi
        .spyOn(defaultWindowOperations, "toggleMaximize")
        .mockResolvedValue(undefined);
      vi.stubGlobal("window", {});
      vi.stubGlobal("navigator", { platform: "Linux x86_64" });

      const target = { closest: () => null } as unknown as HTMLElement;
      handleTopbarDoubleClick({ target } as unknown as React.MouseEvent);

      expect(toggleSpy).not.toHaveBeenCalled();
      toggleSpy.mockRestore();
    });

    it("toggles maximize on Windows desktop for empty topbar regions", () => {
      const toggleSpy = vi
        .spyOn(defaultWindowOperations, "toggleMaximize")
        .mockResolvedValue(undefined);
      vi.stubGlobal("window", { desktopBridge: {} });
      vi.stubGlobal("navigator", { platform: "Win32" });

      const target = { closest: () => null } as unknown as HTMLElement;
      handleTopbarDoubleClick({ target } as unknown as React.MouseEvent);

      expect(toggleSpy).toHaveBeenCalledTimes(1);
      toggleSpy.mockRestore();
    });

    it("toggles maximize on Linux desktop for empty topbar regions", () => {
      const toggleSpy = vi
        .spyOn(defaultWindowOperations, "toggleMaximize")
        .mockResolvedValue(undefined);
      vi.stubGlobal("window", { desktopBridge: {} });
      vi.stubGlobal("navigator", { platform: "Linux x86_64" });

      const target = { closest: () => null } as unknown as HTMLElement;
      handleTopbarDoubleClick({ target } as unknown as React.MouseEvent);

      expect(toggleSpy).toHaveBeenCalledTimes(1);
      toggleSpy.mockRestore();
    });

    it("does not toggle maximize when double clicking interactive elements", () => {
      const toggleSpy = vi
        .spyOn(defaultWindowOperations, "toggleMaximize")
        .mockResolvedValue(undefined);
      vi.stubGlobal("window", { desktopBridge: {} });
      vi.stubGlobal("navigator", { platform: "Win32" });

      const target = {
        closest: (selector: string) => (selector.includes("button") ? {} : null),
      } as unknown as HTMLElement;
      handleTopbarDoubleClick({ target } as unknown as React.MouseEvent);

      expect(toggleSpy).not.toHaveBeenCalled();
      toggleSpy.mockRestore();
    });
  });
});
