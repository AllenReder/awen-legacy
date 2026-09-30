/** One horizontal route: layout travel, a Tab crossing, then the next layout. */
export interface NavigationViewport {
  readonly maxScrollLeft: number;
  readonly scrollLeft: number;
  setScrollLeft(value: number): void;
}

export interface NavigationPreview {
  readonly fromTabId: string;
  readonly toTabId: string;
  readonly dir: -1 | 1;
  readonly progress: number;
}

export interface NavigationInput {
  readonly gestureId: number;
  readonly source: "trackpad" | "right-drag";
  readonly phase: "begin" | "update" | "end" | "momentum" | "cancel";
  readonly deltaX: number;
  readonly time: number;
}

export interface NavigationEnvironment {
  tabs(): readonly string[];
  activeTab(): string;
  width(): number;
  viewport(tabId: string): NavigationViewport | null;
  preview(): NavigationPreview | null;
  beginPreview(preview: NavigationPreview): void;
  present(progress: number, velocity: number): void;
  arrive(tabId: string, dir: -1 | 1): void;
  cancelPreview(tabId: string): void;
  settle(commit: boolean, velocity: number): void;
  hold(active: boolean): void;
}

export function trackpadCrossingProgress(input: number): number {
  return input - (0.2 * Math.sin(2 * Math.PI * input)) / (2 * Math.PI);
}

function inverseProgress(progress: number, source: NavigationInput["source"]): number {
  if (source === "right-drag") return progress;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2;
    if (trackpadCrossingProgress(middle) < progress) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function createContinuousNavigation(environment: NavigationEnvironment) {
  let session: {
    id: number;
    source: NavigationInput["source"];
    phase: "direct" | "momentum";
    tabId: string;
    crossing: (NavigationPreview & { travel: number; previousOffset: number | null }) | null;
    samples: Array<{ delta: number; time: number }>;
    momentumAllowed: boolean;
  } | null = null;

  const restoreIncoming = () => {
    const crossing = session?.crossing;
    if (crossing?.previousOffset != null) {
      environment.viewport(crossing.toTabId)?.setScrollLeft(crossing.previousOffset);
    }
  };
  const cancel = () => {
    if (!session) return;
    if (session.crossing) {
      restoreIncoming();
      environment.cancelPreview(session.tabId);
    }
    session = null;
    environment.hold(false);
  };
  const velocityAt = (time: number) => {
    const samples = session?.samples ?? [];
    const last = samples.at(-1);
    if (!last || time - last.time >= 90) return 0;
    const recent = samples.filter((sample) => sample.time >= time - 90);
    if (recent.length < 2) return 0;
    const duration = last.time - recent[0]!.time;
    return duration > 0
      ? recent.slice(1).reduce((sum, sample) => sum + sample.delta, 0) / duration
      : 0;
  };
  const move = (delta: number) => {
    const current = session;
    if (!current || !Number.isFinite(delta)) return;
    let remaining = delta;
    // Every iteration consumes distance or changes to a different route segment.
    while (Math.abs(remaining) > 0.0001) {
      const crossing = current.crossing;
      if (crossing) {
        const width = Math.max(1, environment.width());
        const next = Math.max(0, Math.min(width, crossing.travel + remaining * crossing.dir));
        remaining -= (next - crossing.travel) * crossing.dir;
        crossing.travel = next;
        const inputProgress = next / width;
        const progress =
          current.source === "trackpad" ? trackpadCrossingProgress(inputProgress) : inputProgress;
        environment.present(progress, 0);
        if (next >= width) {
          current.tabId = crossing.toTabId;
          current.crossing = null;
          environment.arrive(current.tabId, crossing.dir);
        } else if (next <= 0) {
          restoreIncoming();
          current.crossing = null;
          environment.cancelPreview(current.tabId);
        } else break;
        continue;
      }
      const viewport = environment.viewport(current.tabId);
      if (viewport) {
        const before = viewport.scrollLeft;
        const after = Math.max(0, Math.min(viewport.maxScrollLeft, before + remaining));
        viewport.setScrollLeft(after);
        remaining -= after - before;
      }
      if (Math.abs(remaining) <= 0.0001 || current.phase === "momentum") break;
      const tabs = environment.tabs();
      const fromIndex = tabs.indexOf(current.tabId);
      if (fromIndex < 0 || tabs.length < 2) break;
      const dir = remaining > 0 ? 1 : -1;
      const toTabId = tabs[(fromIndex + dir + tabs.length) % tabs.length]!;
      const preview = { fromTabId: current.tabId, toTabId, dir, progress: 0 } as const;
      environment.beginPreview(preview);
      const incoming = environment.viewport(toTabId);
      const previousOffset = incoming?.scrollLeft ?? null;
      incoming?.setScrollLeft(dir === 1 ? 0 : incoming.maxScrollLeft);
      current.crossing = { ...preview, travel: 0, previousOffset };
    }
  };

  return {
    dispatch(input: NavigationInput) {
      if (input.phase === "begin") {
        if (session?.phase === "direct") cancel();
        const visible = environment.preview();
        environment.hold(true);
        session = {
          id: input.gestureId,
          source: input.source,
          phase: "direct",
          tabId: visible?.fromTabId ?? environment.activeTab(),
          crossing: visible
            ? {
                ...visible,
                travel:
                  inverseProgress(visible.progress, input.source) *
                  Math.max(1, environment.width()),
                previousOffset: null,
              }
            : null,
          samples: [{ delta: 0, time: input.time }],
          momentumAllowed: false,
        };
        move(input.deltaX);
        return;
      }
      if (!session || session.id !== input.gestureId) return;
      if (!environment.tabs().includes(session.tabId)) {
        cancel();
        return;
      }
      if (input.phase === "cancel") {
        cancel();
        return;
      }
      if (input.phase === "update" && session.phase === "direct") {
        session.samples.push({ delta: input.deltaX, time: input.time });
        session.samples = session.samples.filter((sample) => sample.time >= input.time - 90);
        move(input.deltaX);
      } else if (input.phase === "end" && session.phase === "direct") {
        if (input.deltaX !== 0) session.samples.push({ delta: input.deltaX, time: input.time });
        move(input.deltaX);
        const velocity = velocityAt(input.time);
        const crossing = session.crossing;
        session.momentumAllowed = crossing === null;
        if (crossing) {
          const progress =
            environment.preview()?.progress ?? crossing.travel / Math.max(1, environment.width());
          const commit = progress >= 0.5 || velocity * crossing.dir >= 0.35;
          if (!commit) restoreIncoming();
          environment.settle(commit, velocity);
          if (commit) session.tabId = crossing.toTabId;
          session.crossing = null;
        }
        session.phase = "momentum";
        environment.hold(false);
        if (session.source === "right-drag") session = null;
      } else if (
        input.phase === "momentum" &&
        session.phase === "momentum" &&
        session.momentumAllowed
      ) {
        move(input.deltaX);
      }
    },
    cancel,
    dispose: cancel,
  };
}
