export interface ChatBackgroundSettings {
  readonly path: string | null;
  readonly opacity: number;
}

export interface MaterialSettings {
  readonly stageEnabled: boolean;
  readonly contentBlur: number;
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
  if (window.desktopBridge?.getWindowGlassSupported?.() === false) return null;
  const desktopPlatform = window.desktopBridge?.getClientPlatform?.();
  if (desktopPlatform === "darwin" || desktopPlatform === "win32") return desktopPlatform;
  return null;
}

export function isNativeGlassPlatform(): boolean {
  return resolveNativeGlassPlatform() !== null;
}

export async function syncNativeWindowGlass(enabled: boolean) {
  await window.desktopBridge?.setWindowGlassEnabled?.(enabled);
}

export function applyMaterialSettings(
  options: MaterialSettings,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
) {
  if (!root) return;
  const nativeGlassPlatform = resolveNativeGlassPlatform();
  const reduceTransparency =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches === true;
  const nativeStage = options.stageEnabled && nativeGlassPlatform !== null && !reduceTransparency;
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
    root.style.setProperty(
      `--material-${surface}-opacity`,
      `${surface === "overlay" || nativeStage ? opacity / 100 : 1}`,
    );
  }

  // Density controls the glass film, not a 90%-opaque paint layer. The curve
  // gives the default 90 a subtle 3.4% dark tint while retaining a solid 100.
  root.style.setProperty(
    "--material-overlay-glass-opacity",
    `${Math.pow(Math.max(0, Math.min(100, options.overlayOpacity)) / 100, 32)}`,
  );

  const contentBlur = Math.max(0, Math.min(32, Math.round(options.contentBlur)));
  root.style.setProperty("--glass-blur", `${contentBlur}px`);
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
  if (stageChanged) void syncNativeWindowGlass(nativeStage);
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

  const src = options.path;
  root.style.setProperty("--workbench-artwork-image", `url(${JSON.stringify(src)})`);
  root.style.setProperty("--workbench-artwork-opacity", `${options.opacity / 100}`);
}
