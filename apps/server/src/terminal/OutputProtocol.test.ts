import { assert, describe, it } from "@effect/vitest";
import { TerminalStreamOverflowError, WS_METHODS } from "@awen/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rpc, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc";

import {
  MAX_PENDING_CHUNKS,
  TERMINAL_STREAM_BUFFER_SIZE,
  terminalEventStream,
  withTerminalOutputWindow,
} from "./OutputProtocol.ts";

describe("terminal output window", () => {
  for (const { tag, size, limit } of [
    { tag: WS_METHODS.terminalAttach, size: 1, limit: 8 },
    { tag: WS_METHODS.subscribeTerminalEvents, size: 1, limit: 8 },
    { tag: WS_METHODS.terminalAttach, size: 64 * 1024, limit: 1 },
    { tag: WS_METHODS.subscribeTerminalMetadata, size: 1, limit: 1 },
  ]) {
    it.effect(`limits ${tag} with ${size}-byte values to ${limit} pending chunks`, () =>
      Effect.gen(function* () {
        const group = RpcGroup.make(Rpc.make(tag, { success: Schema.String, stream: true }));
        const output = yield* Queue.unbounded<string>();
        const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
        const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
        const protocol = yield* RpcServer.Protocol.make((write) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(receive, write);
            const serialization = yield* RpcSerialization.RpcSerialization;
            return {
              disconnects: yield* Queue.unbounded<number>(),
              send: (_clientId, response) => Queue.offer(responses, response),
              end: () => Effect.void,
              clientIds: Effect.succeed(new Set([0])),
              initialMessage: Effect.succeedNone,
              supportsAck: true,
              supportsTransferables: false,
              supportsSpanPropagation: false,
              supportsNotifications: true,
              codecFor: serialization.codecFor,
            };
          }),
        );
        yield* RpcServer.make(group).pipe(
          Effect.provide(group.toLayerHandler(tag, () => Stream.fromQueue(output))),
          Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
          Effect.forkScoped,
        );
        const write = yield* Deferred.await(receive);
        yield* write(0, { _tag: "Request", id: "1", tag, payload: null, headers: [] });

        for (let index = 0; index < limit; index++) {
          const value = String(index).repeat(size);
          yield* Queue.offer(output, value);
          yield* TestClock.adjust(0);
          assert.equal(yield* Queue.size(responses), 1);
          assert.deepEqual(yield* Queue.take(responses), {
            _tag: "Chunk",
            requestId: "1",
            values: [value],
          });
        }
        yield* Queue.offer(output, "i".repeat(size));
        yield* TestClock.adjust(0);
        assert.equal(yield* Queue.size(responses), 0);
        yield* write(0, { _tag: "Ack", requestId: "1" });
        const resumed = yield* Queue.take(responses);
        assert.equal(resumed._tag, "Chunk");
        if (resumed._tag === "Chunk") assert.deepEqual(resumed.values, ["i".repeat(size)]);

        yield* Queue.offer(output, "j");
        yield* TestClock.adjust(0);
        assert.equal(yield* Queue.size(responses), 0);
        yield* write(0, { _tag: "Interrupt", requestId: "1" });
        assert.equal((yield* Queue.take(responses))._tag, "Exit");
      }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
    );
  }

  it.effect("bounds a stalled subscriber's backlog and fails its stream", () =>
    Effect.gen(function* () {
      const tag = WS_METHODS.terminalAttach;
      const group = RpcGroup.make(
        Rpc.make(tag, {
          success: Schema.String,
          error: TerminalStreamOverflowError,
          stream: true,
        }),
      );
      const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
      const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
      const protocol = yield* RpcServer.Protocol.make((write) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(receive, write);
          const serialization = yield* RpcSerialization.RpcSerialization;
          return {
            disconnects: yield* Queue.unbounded<number>(),
            send: (_clientId: number, response: RpcMessage.FromServerEncoded) =>
              Queue.offer(responses, response),
            end: () => Effect.void,
            clientIds: Effect.succeed(new Set([0])),
            initialMessage: Effect.succeedNone,
            supportsAck: true,
            supportsTransferables: false,
            supportsSpanPropagation: false,
            supportsNotifications: true,
            codecFor: serialization.codecFor,
          };
        }),
      );

      const emitRef = yield* Ref.make<((event: string) => Effect.Effect<void>) | null>(null);
      let overflowedAt = -1;
      yield* RpcServer.make(group).pipe(
        Effect.provide(
          group.toLayerHandler(tag, () =>
            terminalEventStream<string, TerminalStreamOverflowError>(
              (event) => {
                overflowedAt = Number(event.slice("event-".length));
                return new TerminalStreamOverflowError({ terminalId: "terminal-1" });
              },
              (offer) => Ref.set(emitRef, offer),
            ),
          ),
        ),
        Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
        Effect.forkScoped,
      );
      const write = yield* Deferred.await(receive);
      yield* write(0, { _tag: "Request", id: "1", tag, payload: null, headers: [] });
      yield* TestClock.adjust(0);

      let offer: ((event: string) => Effect.Effect<void>) | null = null;
      for (let attempt = 0; attempt < 200 && offer === null; attempt += 1) {
        yield* Effect.yieldNow;
        offer = yield* Ref.get(emitRef);
      }
      assert.ok(offer !== null, "the subscriber stream was never registered");
      if (offer === null) return;

      // The client stopped reading: the window fills and nothing pulls the
      // subscriber queue any more.
      const eventCount = TERMINAL_STREAM_BUFFER_SIZE * 4;
      for (let index = 0; index < eventCount && overflowedAt < 0; index += 1) {
        yield* TestClock.adjust(0);
        yield* offer(`event-${index}`);
      }

      // The stalled subscriber retains one buffer, not the whole output.
      assert.ok(overflowedAt >= 0, "the stalled subscriber never overflowed");
      assert.ok(
        overflowedAt <= TERMINAL_STREAM_BUFFER_SIZE + MAX_PENDING_CHUNKS,
        `the stalled subscriber buffered ${overflowedAt} events`,
      );

      // Letting the client read again surfaces the dropped stream as an error.
      let terminalMessage: RpcMessage.FromServerEncoded | null = null;
      for (let attempt = 0; attempt < eventCount + 2 && terminalMessage === null; attempt += 1) {
        yield* write(0, { _tag: "Ack", requestId: "1" });
        yield* TestClock.adjust(0);
        const next = yield* Queue.poll(responses);
        if (Option.isSome(next) && next.value._tag === "Exit") terminalMessage = next.value;
      }
      assert.ok(terminalMessage !== null, "the stalled subscriber was never told");
      if (terminalMessage === null || terminalMessage._tag !== "Exit") return;
      assert.deepEqual(terminalMessage.exit, {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: { _tag: "TerminalStreamOverflowError", terminalId: "terminal-1" },
          },
        ],
      });
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );
});
