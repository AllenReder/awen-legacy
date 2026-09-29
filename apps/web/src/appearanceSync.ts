import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "./env";
import { resolveClientPlatform } from "./platformSignals";

export interface ChatBackgroundSettings {
  readonly path: string | null;
  readonly opacity: number;
}

export interface MaterialSettings {
  readonly stageEnabled: boolean;
  readonly blurRadius: number;
  readonly backgroundMaskLightOpacity: number;
  readonly backgroundMaskDarkOpacity: number;
  readonly sidebarOpacity: number;
  readonly topbarOpacity: number;
  readonly workbenchOpacity: number;
  readonly workbenchGlass: boolean;
  readonly overlayOpacity: number;
}

type NativeGlassPlatform = "darwin" | "win32";

function resolveNativeGlassPlatform(): NativeGlassPlatform | null {
  if (typeof window === "undefined") return null;
  const desktopPlatform = window.desktopBridge?.getClientPlatform?.();
  if (desktopPlatform === "darwin" || desktopPlatform === "win32") return desktopPlatform;
  if (desktopPlatform) return null;
  if (!isTauri && !(window as any).isTauri && !(window as any).__TAURI_INTERNALS__) return null;
  if (typeof navigator === "undefined") return null;

  const platform = resolveClientPlatform({
    navigatorPlatform: navigator.platform,
    userAgent: navigator.userAgent,
  });
  return platform === "darwin" || platform === "win32" ? platform : null;
}

export function isNativeGlassPlatform(): boolean {
  return resolveNativeGlassPlatform() !== null;
}

export async function syncNativeWindowGlass(enabled: boolean, blurRadius: number) {
  if (typeof window !== "undefined" && window.desktopBridge?.setWindowGlassEnabled) {
    try {
      await window.desktopBridge.setWindowGlassEnabled(enabled);
      await window.desktopBridge.setWindowBackgroundBlur?.(blurRadius);
      return;
    } catch {
      // Desktop bridge invocation failed
    }
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_window_glass_enabled", { enabled });
    if (enabled) {
      await invoke("set_window_background_blur", { radius: blurRadius });
    }
  } catch {
    // Non-Tauri environment
  }
}

export function applyMaterialSettings(
  options: MaterialSettings,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
) {
  if (!root) return;
  const nativeGlassPlatform = resolveNativeGlassPlatform();
  const nativeStage = options.stageEnabled && nativeGlassPlatform !== null;
  const stageChanged = root.classList.contains("material-stage-native") !== nativeStage;
  root.classList.toggle("material-stage-native", nativeStage);
  root.classList.toggle("material-stage-windows", nativeStage && nativeGlassPlatform === "win32");
  root.classList.toggle("material-stage-opaque", !nativeStage);

  root.style.setProperty(
    "--material-background-mask-light-opacity",
    `${nativeStage ? options.backgroundMaskLightOpacity / 100 : 0}`,
  );
  root.style.setProperty(
    "--material-background-mask-dark-opacity",
    `${nativeStage ? options.backgroundMaskDarkOpacity / 100 : 0}`,
  );

  const opacities = {
    sidebar: options.sidebarOpacity,
    topbar: options.topbarOpacity,
    workbench: options.workbenchGlass ? options.workbenchOpacity : 100,
    overlay: options.overlayOpacity,
  };
  // The opaque stage stays fully solid; index.css gives each region its own
  // calibrated surface token instead of reusing the native glass background.
  for (const [surface, opacity] of Object.entries(opacities)) {
    root.style.setProperty(`--material-${surface}-opacity`, `${nativeStage ? opacity / 100 : 1}`);
  }

  const blurRadius = Math.max(1, Math.min(64, Math.round(options.blurRadius)));
  const radiusChanged =
    root.style.getPropertyValue("--material-native-blur-radius") !== `${blurRadius}px`;
  root.style.setProperty("--material-native-blur-radius", `${blurRadius}px`);
  if (nativeStage) {
    root.style.backgroundColor = "transparent";
    if (typeof document !== "undefined" && document.body) {
      document.body.style.backgroundColor = "";
    }
  } else {
    root.style.backgroundColor = "";
    if (typeof document !== "undefined" && document.body) {
      document.body.style.backgroundColor = "";
    }
  }
  // Tint and mask sliders only change CSS; avoid rebuilding native backing
  // views (and their shadows) on every slider event or calling two bridges.
  if (stageChanged || radiusChanged) {
    const bridge = window.desktopBridge;
    if (bridge?.setWindowGlassEnabled && bridge.setWindowBackgroundBlur) {
      void bridge.setWindowGlassEnabled(nativeStage);
      if (nativeStage) void bridge.setWindowBackgroundBlur(blurRadius);
    } else {
      void syncNativeWindowGlass(nativeStage, blurRadius);
    }
  }
}

export function applyWorkbenchArtwork(
  options: ChatBackgroundSettings,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
) {
  if (!root) return;
  const hasBackground = Boolean(options.path && options.path.trim().length > 0);
  if (!hasBackground || !options.path) {
    root.style.removeProperty("--workbench-artwork-image");
    root.style.removeProperty("--workbench-artwork-opacity");
    return;
  }

  const src =
    isTauri && typeof window !== "undefined" ? convertFileSrc(options.path) : options.path;
  root.style.setProperty("--workbench-artwork-image", `url(${JSON.stringify(src)})`);
  root.style.setProperty("--workbench-artwork-opacity", `${options.opacity / 100}`);
}
