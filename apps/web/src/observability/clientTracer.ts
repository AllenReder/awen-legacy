import * as Tracer from "effect/Tracer";

/**
 * The tracer client Effect runtimes hand their spans to.
 *
 * Client tracing is configured after the primary environment resolves, but a
 * runtime's layers are fixed when it is built, so the runtimes install one
 * stable delegating tracer instead: `setActiveClientTracer` points it at the
 * configured OTLP tracer, and `null` restores Effect's default tracer.
 */
let activeDelegate: Tracer.Tracer | null = null;

export function activeClientTracer(): Tracer.Tracer | null {
  return activeDelegate;
}

export function setActiveClientTracer(tracer: Tracer.Tracer | null): void {
  activeDelegate = tracer;
}

/** The tracer every client Effect runtime installs. */
export const clientTracer: Tracer.Tracer = Tracer.make({
  span: (options) => (activeDelegate ?? Tracer.Tracer.defaultValue()).span(options),
});
