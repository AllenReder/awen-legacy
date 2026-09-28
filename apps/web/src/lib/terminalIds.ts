import { randomUUID } from "./utils";

/**
 * Allocate a stable, Environment-unique terminal id.
 *
 * Terminal ids are Session identities, so they must be unique across every
 * terminal in the Environment — sequential `term-N` ids scoped to one client
 * list would let two terminals share one PTY.
 */
export function createTerminalId(): string {
  return `term-${randomUUID()}`;
}
