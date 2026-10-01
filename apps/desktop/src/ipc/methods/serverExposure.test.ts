import { describe, expect, it } from "@effect/vitest";
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

const exerciseChange = (kind: "mode" | "tailscale", changed: boolean, stopFails = false) =>
  Effect.gen(function* () {
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
      Layer.succeed(
        DesktopEnvironment.DesktopEnvironment,
        {} as DesktopEnvironment.DesktopEnvironment["Service"],
      ),
      Layer.mock(DesktopWindow.DesktopWindow, {}),
      Layer.mock(ElectronApp.ElectronApp, {}),
      Layer.mock(ElectronTheme.ElectronTheme, {}),
    );
    const exit =
      kind === "mode"
        ? yield* setServerExposureMode
            .handler("local-only")
            .pipe(Effect.provide(layer), Effect.exit)
        : yield* setTailscaleServeEnabled
            .handler({ enabled: true, port: 8443 })
            .pipe(Effect.provide(layer), Effect.exit);
    return { events, exit };
  });

describe("server exposure IPC", () => {
  for (const kind of ["mode", "tailscale"] as const) {
    it.effect(`stops the old daemon before relaunching for changed ${kind} settings`, () =>
      Effect.gen(function* () {
        expect((yield* exerciseChange(kind, true)).events).toEqual(["stop", "relaunch"]);
      }),
    );
    it.effect(`keeps the daemon when ${kind} settings did not change`, () =>
      Effect.gen(function* () {
        expect((yield* exerciseChange(kind, false)).events).toEqual([]);
      }),
    );
    it.effect(`does not relaunch after failing to stop the old ${kind} daemon`, () =>
      Effect.gen(function* () {
        const result = yield* exerciseChange(kind, true, true);
        expect(result.events).toEqual(["stop"]);
        expect(result.exit._tag).toBe("Failure");
      }),
    );
  }
});
