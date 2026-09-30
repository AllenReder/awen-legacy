import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopServerExposure from "../../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { setServerExposureMode, setTailscaleServeEnabled } from "./serverExposure.ts";

const exerciseChange = async (kind: "mode" | "tailscale", changed: boolean, stopFails = false) => {
  const events: string[] = [];
  const layer = Layer.mergeAll(
    Layer.mock(DesktopServerExposure.DesktopServerExposure, {
      setMode: () => Effect.succeed({ requiresRelaunch: changed, state: {} as never }),
      setTailscaleServeEnabled: () =>
        Effect.succeed({
          requiresRelaunch: changed,
          state: { tailscaleServeEnabled: true } as never,
        }),
    }),
    Layer.mock(DesktopBackendPool.DesktopBackendPool, {
      primary: Effect.succeed({
        id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
        label: Effect.succeed("Local"),
        start: Effect.void,
        stop: () =>
          Effect.sync(() => {
            events.push("stop");
          }).pipe(Effect.andThen(stopFails ? Effect.die("stop failed") : Effect.void)),
        currentConfig: Effect.succeedNone,
        snapshot: Effect.succeed({
          desiredRunning: false,
          ready: false,
          activePid: Option.none(),
          restartAttempt: 0,
          restartScheduled: false,
        }),
        waitForReady: () => Effect.succeed(false),
      }),
    }),
    Layer.mock(DesktopLifecycle.DesktopLifecycle, {
      relaunch: () =>
        Effect.sync(() => {
          events.push("relaunch");
        }),
    }),
    DesktopShutdown.layer,
    DesktopState.layer,
    Layer.mock(DesktopEnvironment.DesktopEnvironment, {}),
    Layer.mock(DesktopWindow.DesktopWindow, {}),
    Layer.mock(ElectronApp.ElectronApp, {}),
    Layer.mock(ElectronTheme.ElectronTheme, {}),
  );
  const action =
    kind === "mode"
      ? setServerExposureMode.handler("local-only")
      : setTailscaleServeEnabled.handler({ enabled: true, port: 8443 });
  const exit = await Effect.runPromise(action.pipe(Effect.provide(layer), Effect.exit));
  return { events, exit };
};

describe("server exposure IPC", () => {
  for (const kind of ["mode", "tailscale"] as const) {
    it(`stops the old daemon before relaunching for changed ${kind} settings`, async () => {
      expect((await exerciseChange(kind, true)).events).toEqual(["stop", "relaunch"]);
    });
    it(`keeps the daemon when ${kind} settings did not change`, async () => {
      expect((await exerciseChange(kind, false)).events).toEqual([]);
    });
    it(`does not relaunch after failing to stop the old ${kind} daemon`, async () => {
      const result = await exerciseChange(kind, true, true);
      expect(result.events).toEqual(["stop"]);
      expect(result.exit._tag).toBe("Failure");
    });
  }
});
