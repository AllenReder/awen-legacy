import { WS_METHODS } from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { RpcServer } from "effect/unstable/rpc";

/**
 * How many events one terminal subscriber may fall behind before its stream is
 * dropped.
 *
 * Terminal output is produced by a PTY that never waits for a client, so the
 * subscriber queue has a hard cap: an unbounded `Stream.callback` queue grows
 * with every chunk a stalled client leaves unread until the daemon runs out of
 * memory. The cap only bounds *transport* backlog, not terminal scrollback.
 */
export const TERMINAL_STREAM_BUFFER_SIZE = 256;

/**
 * A terminal subscriber stream whose queue holds at most
 * `TERMINAL_STREAM_BUFFER_SIZE` unread events.
 *
 * `register` receives the only way to emit: an event offered past that bound is
 * refused and fails the stream with `onOverflow(event)` instead of being
 * buffered, so a client that stops reading cannot grow the daemon's memory.
 */
export function terminalEventStream<A, E>(
  onOverflow: (event: A) => E,
  register: (emit: (event: A) => Effect.Effect<void>) => Effect.Effect<unknown, E, Scope.Scope>,
): Stream.Stream<A, E> {
  return Stream.callback(
    (queue) =>
      register((event) =>
        Queue.offer(queue, event).pipe(
          Effect.flatMap((accepted) =>
            accepted ? Effect.void : Queue.fail(queue, onOverflow(event)).pipe(Effect.asVoid),
          ),
        ),
      ),
    {
      bufferSize: TERMINAL_STREAM_BUFFER_SIZE,
      strategy: "dropping",
    },
  );
}

export const MAX_PENDING_CHUNKS = 8;
const MAX_PENDING_BYTES = 64 * 1024;
const isFull = (sizes: number[]) =>
  sizes.length >= MAX_PENDING_CHUNKS ||
  sizes.reduce((total, size) => total + size, 0) >= MAX_PENDING_BYTES;

export function withTerminalOutputWindow(
  protocol: RpcServer.Protocol["Service"],
): RpcServer.Protocol["Service"] {
  const windows = new Map<string, number[]>();
  let receive: Parameters<RpcServer.Protocol["Service"]["run"]>[0];
  return {
    ...protocol,
    run: (write) => {
      receive = write;
      return protocol.run((clientId, message) =>
        Effect.suspend(() => {
          if (
            message._tag === "Request" &&
            (message.tag === WS_METHODS.terminalAttach ||
              message.tag === WS_METHODS.subscribeTerminalEvents)
          ) {
            const key = `${clientId}:${message.id}`;
            if (!windows.has(key)) windows.set(key, []);
          } else if (message._tag === "Ack") {
            const window = windows.get(`${clientId}:${message.requestId}`);
            if (window) {
              const wasFull = isFull(window);
              window.shift();
              if (!wasFull || isFull(window)) return Effect.void;
            }
          }
          return write(clientId, message);
        }),
      );
    },
    send: (clientId, response, transferables) =>
      Effect.suspend(() => {
        const send = protocol.send(clientId, response, transferables);
        if (response._tag === "Exit") {
          windows.delete(`${clientId}:${response.requestId}`);
        } else if (response._tag === "Chunk") {
          const window = windows.get(`${clientId}:${response.requestId}`);
          if (window) {
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            const size = Buffer.byteLength(JSON.stringify(response));
            window.push(size);
            if (!isFull(window)) {
              return send.pipe(
                Effect.andThen(() =>
                  receive(clientId, {
                    _tag: "Ack",
                    requestId: response.requestId,
                  }),
                ),
              );
            }
          }
        }
        return send;
      }),
  };
}
