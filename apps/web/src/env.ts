/** True for the Electron desktop runtime. */
export const isElectron =
  typeof window !== "undefined" && window.desktopBridge !== undefined;

/** Legacy / fallback Tauri shell check. */
export const isTauri =
  !isElectron &&
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || window.location?.protocol === "tauri:");

/** True for either native desktop host. */
export const isDesktop = isElectron || isTauri;
