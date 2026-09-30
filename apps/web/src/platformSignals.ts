/**
 * Platform facts shared by the appearance layer and the terminal renderer.
 *
 * The native desktop bridge is authoritative when it reports a known platform.
 * Unknown native values fall through to browser signals instead of being treated as "not
 * Windows". Browser `navigator` signals only classify the OS; they never imply
 * a native glass stage.
 */
export type ClientPlatform = "darwin" | "win32" | "linux";

export interface ClientPlatformSignals {
  readonly desktopPlatform?: string | null | undefined;
  readonly navigatorPlatform?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

export function resolveClientPlatform(signals: ClientPlatformSignals): ClientPlatform | null {
  const desktop = signals.desktopPlatform?.trim().toLowerCase();
  if (desktop === "darwin" || desktop === "win32" || desktop === "linux") {
    return desktop;
  }

  const navigatorPlatform = signals.navigatorPlatform ?? "";
  const userAgent = signals.userAgent ?? "";
  if (/mac|iphone|ipad/i.test(navigatorPlatform) || /macintosh|mac os x/i.test(userAgent)) {
    return "darwin";
  }
  // Anchored so macOS's "Darwin" cannot read as Windows; the UA token is the
  // Windows marker, because `navigator.platform` is unreliable across browsers.
  if (/^win/i.test(navigatorPlatform) || /windows/i.test(userAgent)) {
    return "win32";
  }
  return null;
}

export function isWindowsPlatform(signals: ClientPlatformSignals): boolean {
  return resolveClientPlatform(signals) === "win32";
}
