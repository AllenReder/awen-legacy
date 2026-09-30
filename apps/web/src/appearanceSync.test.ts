import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyMaterialSettings,
  applyWorkbenchArtwork,
  isNativeGlassPlatform,
} from "./appearanceSync";

function makeRoot() {
  const classes = new Set<string>();
  const properties = new Map<string, string>();
  return {
    root: {
      classList: {
        add: (...names: string[]) => names.forEach((n) => classes.add(n)),
        remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
        toggle: (name: string, force?: boolean) => {
          const next = force ?? !classes.has(name);
          if (next) classes.add(name);
          else classes.delete(name);
          return next;
        },
        contains: (name: string) => classes.has(name),
      },
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
        getPropertyValue: (name: string) => properties.get(name) ?? "",
      },
    } as unknown as HTMLElement,
    classes,
    properties,
  };
}

describe("appearanceSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("isNativeGlassPlatform", () => {
    it("returns true on darwin desktop", () => {
      vi.stubGlobal("window", {
        desktopBridge: {
          getClientPlatform: () => "darwin",
        },
      });
      expect(isNativeGlassPlatform()).toBe(true);
    });

    it("returns true on Windows desktop", () => {
      vi.stubGlobal("window", {
        desktopBridge: {
          getClientPlatform: () => "win32",
        },
      });
      vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows" });
      expect(isNativeGlassPlatform()).toBe(true);
    });

    it("marks only the Windows native stage for the overlay material fallback", () => {
      vi.stubGlobal("window", {
        desktopBridge: {
          getClientPlatform: () => "win32",
        },
      });
      vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows" });
      const { root, classes } = makeRoot();

      applyMaterialSettings(
        {
          stageEnabled: true,
          contentBlur: 24,
          backgroundMaskLightOpacity: 10,
          backgroundMaskDarkOpacity: 35,
          sidebarOpacity: 65,
          topbarOpacity: 75,
          workbenchOpacity: 88,
          workbenchGlass: true,
          overlayOpacity: 90,
        },
        root,
      );

      expect(classes.has("material-stage-native")).toBe(true);
      expect(classes.has("material-stage-windows")).toBe(true);
      expect(classes.has("material-stage-opaque")).toBe(false);
    });

    it("returns false on Linux desktop so the opaque fallback stays active", () => {
      vi.stubGlobal("window", {
        desktopBridge: {
          getClientPlatform: () => "linux",
        },
      });
      vi.stubGlobal("navigator", { platform: "Linux x86_64", userAgent: "Linux" });
      expect(isNativeGlassPlatform()).toBe(false);
    });
  });

  describe("applyMaterialSettings", () => {
    it("publishes stage and surface material variables for native glass", () => {
      const setWindowGlassEnabled = vi.fn().mockResolvedValue(undefined);
      const setWindowBackgroundBlur = vi.fn().mockResolvedValue(undefined);

      vi.stubGlobal("window", {
        desktopBridge: {
          getClientPlatform: () => "darwin",
          setWindowGlassEnabled,
          setWindowBackgroundBlur,
        },
      });

      const { root, properties, classes } = makeRoot();

      applyMaterialSettings(
        {
          stageEnabled: true,
          contentBlur: 24,
          backgroundMaskLightOpacity: 10,
          backgroundMaskDarkOpacity: 35,
          sidebarOpacity: 65,
          topbarOpacity: 75,
          workbenchOpacity: 88,
          workbenchGlass: true,
          overlayOpacity: 90,
        },
        root,
      );

      expect(properties.get("--material-background-mask-dark-opacity")).toBe("0.35");
      expect(properties.get("--material-sidebar-opacity")).toBe("0.65");
      expect(properties.get("--material-topbar-opacity")).toBe("0.75");
      expect(properties.get("--material-workbench-opacity")).toBe("0.88");
      expect(properties.get("--material-overlay-opacity")).toBe("0.9");
      expect(classes.has("material-stage-native")).toBe(true);
      expect(classes.has("material-stage-windows")).toBe(false);
      expect(classes.has("material-stage-opaque")).toBe(false);
      expect(setWindowGlassEnabled).toHaveBeenCalledWith(true);
      expect(setWindowBackgroundBlur).not.toHaveBeenCalled();
      expect(properties.get("--glass-blur")).toBe("24px");
    });

    it("updates mask and tint without reconfiguring the native window", () => {
      const setWindowGlassEnabled = vi.fn();
      const setWindowBackgroundBlur = vi.fn();
      vi.stubGlobal("window", {
        desktopBridge: {
          getClientPlatform: () => "darwin",
          setWindowGlassEnabled,
          setWindowBackgroundBlur,
        },
      });
      const { root } = makeRoot();
      const settings = {
        stageEnabled: true,
        contentBlur: 24,
        sidebarOpacity: 50,
        topbarOpacity: 50,
        workbenchOpacity: 50,
        workbenchGlass: true,
        overlayOpacity: 90,
        backgroundMaskLightOpacity: 10,
        backgroundMaskDarkOpacity: 35,
      };
      applyMaterialSettings(settings, root);
      applyMaterialSettings(
        { ...settings, backgroundMaskDarkOpacity: 60, sidebarOpacity: 40 },
        root,
      );
      expect(setWindowGlassEnabled).toHaveBeenCalledTimes(1);
      expect(setWindowBackgroundBlur).not.toHaveBeenCalled();
    });

    it("falls back to opaque stage variables when native glass is unavailable", () => {
      vi.stubGlobal("window", {});

      const { root, properties, classes } = makeRoot();

      applyMaterialSettings(
        {
          stageEnabled: true,
          contentBlur: 24,
          backgroundMaskLightOpacity: 10,
          backgroundMaskDarkOpacity: 35,
          sidebarOpacity: 65,
          topbarOpacity: 75,
          workbenchOpacity: 88,
          workbenchGlass: true,
          overlayOpacity: 90,
        },
        root,
      );

      expect(properties.get("--material-background-mask-dark-opacity")).toBe("0");
      expect(classes.has("material-stage-native")).toBe(false);
      expect(classes.has("material-stage-opaque")).toBe(true);
      expect(properties.get("--material-sidebar-opacity")).toBe("1");
      expect(properties.get("--material-topbar-opacity")).toBe("1");
      expect(properties.get("--material-workbench-opacity")).toBe("1");
      expect(properties.get("--material-overlay-opacity")).toBe("0.9");
      expect(properties.get("--glass-blur")).toBe("24px");
    });
  });

  describe("applyWorkbenchArtwork", () => {
    it("applies background image and opacity variables", () => {
      const { root, properties } = makeRoot();

      applyWorkbenchArtwork(
        {
          path: "/Users/test/wallpaper.png",
          opacity: 30,
        },
        root,
      );

      expect(properties.get("--workbench-artwork-opacity")).toBe("0.3");
      expect(properties.get("--workbench-artwork-image")).toBeDefined();
    });

    it("removes background classes and variables when path is null", () => {
      const { root, properties } = makeRoot();
      properties.set("--workbench-artwork-image", "url(foo)");
      properties.set("--workbench-artwork-opacity", "0.5");

      applyWorkbenchArtwork(
        {
          path: null,
          opacity: 24,
        },
        root,
      );

      expect(properties.has("--workbench-artwork-image")).toBe(false);
      expect(properties.has("--workbench-artwork-opacity")).toBe(false);
    });
  });
});
