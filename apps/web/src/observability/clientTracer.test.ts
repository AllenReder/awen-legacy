import { remoteHttpClientLayer } from "@awen/client-runtime/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { vi } from "vite-plus/test";

import { runtime } from "~/lib/runtime";

import { activeClientTracer, clientTracer, setActiveClientTracer } from "./clientTracer";
import { configureClientTracing } from "./clientTracing";

/** Reads a captured fetch body, whether the transport sent text, bytes, or a stream. */
const readRequestBody = async (init?: RequestInit): Promise<string> => {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ReadableStream) return await new Response(body).text();
  return String(body ?? "");
};

/** A tracer that records the spans it is asked for, backed by Effect's default spans. */
const makeRecordingTracer = () => {
  const names: string[] = [];
  return {
    names,
    tracer: Tracer.make({
      span: (options) => {
        names.push(options.name);
        return Tracer.Tracer.defaultValue().span(options);
      },
    }),
  };
};

/** Runs one span through the real client runtime the app hands its effects to. */
const runClientSpan = (name: string) =>
  Effect.promise(() => runtime.runPromise(Effect.withSpan(name)(Effect.void)));

describe("client tracer", () => {
  it.effect("does not require a configured tracer", () =>
    Effect.gen(function* () {
      setActiveClientTracer(null);
      yield* runClientSpan("client-runtime-span");

      const span = clientTracer.span({
        name: "direct-span",
        parent: Option.none(),
        annotations: Context.empty(),
        links: [],
        startTime: 0n,
        kind: "internal",
        root: false,
        sampled: true,
      });
      expect(span.name).toBe("direct-span");
    }),
  );

  it.effect("records client runtime spans on the installed tracer", () =>
    Effect.gen(function* () {
      const recording = makeRecordingTracer();
      setActiveClientTracer(recording.tracer);
      yield* Effect.addFinalizer(() => Effect.sync(() => setActiveClientTracer(null)));

      yield* runClientSpan("client-runtime-span");

      expect(recording.names).toEqual(["client-runtime-span"]);
    }).pipe(Effect.scoped),
  );

  it.effect("exports client runtime spans through the configured OTLP tracer", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const exportedBodies: string[] = [];
        const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
          exportedBodies.push(await readRequestBody(init));
          return new Response(null, { status: 200 });
        });
        const exporterContext = yield* Layer.build(
          Layer.mergeAll(
            OtlpExporter.layerFlusher,
            OtlpSerialization.layerJson,
            remoteHttpClientLayer(fetchMock as unknown as typeof fetch),
            Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
          ),
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const delegate = yield* OtlpTracer.make({
          url: "http://127.0.0.1:3773/api/observability/v1/traces",
          exportInterval: "10 millis",
          resource: { serviceName: "awen-web-test" },
        }).pipe(Scope.provide(scope), Effect.provide(exporterContext));
        setActiveClientTracer(delegate);
        yield* Effect.addFinalizer(() => Effect.sync(() => setActiveClientTracer(null)));

        yield* runClientSpan("client-exported-span");
        yield* Effect.sleep("250 millis");

        expect(fetchMock).toHaveBeenCalled();
        expect(exportedBodies.join("\n")).toContain("client-exported-span");
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("installs the configured OTLP tracer for client runtime spans", () =>
    Effect.gen(function* () {
      const exportedBodies: string[] = [];
      const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
        exportedBodies.push(await readRequestBody(init));
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { origin: "http://127.0.0.1:3773" } },
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          setActiveClientTracer(null);
          Reflect.deleteProperty(globalThis, "window");
          vi.unstubAllGlobals();
        }),
      );

      yield* Effect.promise(() => configureClientTracing({ exportIntervalMs: 10 }));
      expect(activeClientTracer()).not.toBeNull();

      yield* runClientSpan("client-configured-span");
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 250)));

      expect(exportedBodies.join("\n")).toContain("client-configured-span");
    }).pipe(Effect.scoped),
  );
});
