/** True for the Electron desktop runtime. */
export const isElectron = typeof window !== "undefined" && window.desktopBridge !== undefined;

/** True for the native desktop host. */
export const isDesktop = isElectron;
