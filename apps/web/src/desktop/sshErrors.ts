import { ConnectionFailureCodeSchema, type ConnectionFailureCode } from "@awen/contracts";
import * as Schema from "effect/Schema";

const isConnectionFailureCode = Schema.is(ConnectionFailureCodeSchema);

/**
 * The daemon reports SSH password-prompt cancellation as a typed marker
 * (`DesktopSshPasswordPromptCancelledType`); the desktop bridge rethrows it as
 * this typed error so the connection platform can classify cancellation
 * without sniffing message text. Kept in its own module so effect-land
 * connection code can classify cancellation at the renderer boundary.
 */
export class SshPasswordPromptCancelledError extends Error {
  override readonly name = "SshPasswordPromptCancelledError";
}

/**
 * Error raised by the desktop SSH API client after preserving the daemon's
 * stable failure code. Connection onboarding maps this without parsing text.
 */
export class DesktopSshRequestError extends Error {
  override readonly name = "DesktopSshRequestError";

  constructor(
    readonly code: ConnectionFailureCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** Electron preserves IPC error messages, but drops custom error properties. */
export function decodeDesktopSshError(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause;
  const cancellation = cause.message.indexOf("[awen-ssh-cancelled] ");
  if (cancellation !== -1)
    return new SshPasswordPromptCancelledError(
      cause.message.slice(cancellation + "[awen-ssh-cancelled] ".length),
    );
  const failure = /\[awen-ssh-error:([a-z-]+):(\d{3})\] ([\s\S]*)/.exec(cause.message);
  if (failure && isConnectionFailureCode(failure[1]))
    return new DesktopSshRequestError(
      failure[1],
      failure[3] ?? "SSH daemon request failed.",
      Number(failure[2]),
    );
  return cause;
}
