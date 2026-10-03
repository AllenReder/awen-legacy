import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

export interface SnapshotSubscription<A> {
  readonly latest: A;
  readonly changes: Stream.Stream<A>;
}

/**
 * Subscribes to a change PubSub before returning the stream.
 *
 * `Stream.fromPubSub` defers `PubSub.subscribe` to stream start, so callers
 * that pair a stream with a snapshot read can lose a change published in
 * between. Awaiting this effect acquires the subscription synchronously; every
 * publish after it returns is buffered until the stream is pulled.
 */
export const subscribeChanges = <A>(
  changes: PubSub.PubSub<A>,
): Effect.Effect<Stream.Stream<A>, never, Scope.Scope> =>
  PubSub.subscribe(changes).pipe(
    Effect.map((subscription) => Stream.fromSubscription(subscription)),
  );

/**
 * Emits `latest` followed by `changes`, dropping the notifications `latest`
 * already accounts for: the first element is the snapshot itself, and every
 * following value equal to its predecessor is skipped.
 */
export const changesAfterSnapshot = <A>(latest: A, changes: Stream.Stream<A>): Stream.Stream<A> =>
  Stream.concat(Stream.make(latest), changes).pipe(
    Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
    Stream.drop(1),
  );

export const subscribeBeforeSnapshot = Effect.fn("subscribeBeforeSnapshot")(function* <A, E, R>(
  changes: PubSub.PubSub<A>,
  snapshot: Effect.Effect<A, E, R>,
  mutex: Semaphore.Semaphore,
) {
  return yield* mutex.withPermits(1)(
    Effect.gen(function* () {
      const latest = yield* snapshot;
      const subscription = yield* PubSub.subscribe(changes);
      return {
        latest,
        changes: Stream.fromSubscription(subscription),
      } satisfies SnapshotSubscription<A>;
    }),
  );
});

export const subscribeBeforeSnapshotWithoutMutex = Effect.fn("subscribeBeforeSnapshotWithoutMutex")(
  function* <A, E, R>(changes: PubSub.PubSub<A>, snapshot: Effect.Effect<A, E, R>) {
    const subscription = yield* PubSub.subscribe(changes);
    const latest = yield* snapshot;
    return {
      latest,
      changes: Stream.fromSubscription(subscription),
    } satisfies SnapshotSubscription<A>;
  },
);
