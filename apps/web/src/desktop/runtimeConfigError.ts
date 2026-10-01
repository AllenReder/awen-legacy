/**
 * The desktop shell's runtime-config read outcome, kept in a tiny module so the
 * error view can read it without importing the desktop bridge.
 *
 * A launcher failure is otherwise invisible: the bridge keeps bootstraps empty,
 * the client falls back to the window origin, and the user sees only a generic
 * primary-environment error. Recording the launcher's own message here lets the
 * error surface name the mechanism (`discovery-invalid`, `daemon-port-occupied`,
 * ...) and the next step.
 */
let desktopRuntimeConfigError: unknown = null;
let resolveSettled: (() => void) | undefined;

/** Resolves once the runtime-config read has settled, success or failure. */
export const desktopRuntimeConfigSettled: Promise<void> = new Promise((resolve) => {
  resolveSettled = resolve;
});

export function recordDesktopRuntimeConfigError(error: unknown): void {
  desktopRuntimeConfigError = error;
}

export function markDesktopRuntimeConfigSettled(): void {
  resolveSettled?.();
  resolveSettled = undefined;
}

export function readDesktopRuntimeConfigError(): unknown {
  return desktopRuntimeConfigError;
}

export function __resetDesktopRuntimeConfigErrorForTests(): void {
  desktopRuntimeConfigError = null;
}
