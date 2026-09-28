import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/**
 * Serializes Agent Session migrations against provider starts.
 *
 * Both authorities borrow the same workspace directory, so they must not
 * interleave: a migration relocates the provider and commits the Workspace
 * assignment, while a provider start reads that assignment and launches the
 * provider at the directory it names. This lock is owned once by the server
 * runtime layer so the websocket send/migrate authority
 * (`AwenSessionService`) and the provider reactor contend on the same
 * semaphore instead of holding independent ones.
 */
export class SessionExecutionLock extends Context.Service<
  SessionExecutionLock,
  {
    readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@awen/server/session/SessionExecutionLock") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  // One permit: a provider start and an Agent Session migration never overlap.
  const semaphore = yield* Semaphore.make(1);
  const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) => semaphore.withPermits(1)(effect);

  return SessionExecutionLock.of({ withLock });
});

export const layer = Layer.effect(SessionExecutionLock, make);
