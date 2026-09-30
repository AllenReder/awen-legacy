import {
  DesktopUpdateChannelSchema,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@awen/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { checkGitHubRelease } from "./GitHubReleases.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  { action: Schema.Literals(["check", "channel"]), requestedChannel: DesktopUpdateChannelSchema },
) {
  override get message(): string {
    return "Wait for the current version check before changing channels.";
  }
}
export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} release channel.`;
  }
}
export type DesktopUpdateSetChannelError =
  | DesktopUpdateActionInProgressError
  | DesktopUpdateChannelPersistenceError;

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly isActionActive: Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<
      { readonly latest: DesktopUpdateState; readonly changes: Stream.Stream<DesktopUpdateState> },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
  }
>()("@awen/desktop/updates/DesktopUpdates") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const windows = yield* ElectronWindow.ElectronWindow;
  const httpClient = yield* HttpClient.HttpClient;
  const initialSettings = yield* settings.get;
  const reason =
    environment.isDevelopment || !environment.isPackaged
      ? "Version checks are available in packaged production builds."
      : config.disableUpdateCheck
        ? "Version checks are disabled for this run."
        : null;
  const state = yield* Ref.make<DesktopUpdateState>({
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      initialSettings.updateChannel,
    ),
    enabled: reason === null,
    status: reason === null ? "idle" : "disabled",
    message: reason,
  });
  const changes = yield* PubSub.sliding<DesktopUpdateState>(16);
  const configured = yield* Ref.make(false);
  const channelChanging = yield* Ref.make(false);
  const inFlight = yield* Ref.make<Option.Option<Deferred.Deferred<DesktopUpdateCheckResult>>>(
    Option.none(),
  );
  const publish = (next: DesktopUpdateState) =>
    Ref.set(state, next).pipe(
      Effect.andThen(PubSub.publish(changes, next)),
      Effect.andThen(windows.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, next)),
    );

  const check = Effect.fn("desktop.updates.check")(function* (reason: string) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({ reason });
        const current = yield* Ref.get(state);
        if (!current.enabled || (yield* Ref.get(channelChanging)))
          return { checked: false, state: current };
        const pending = yield* Deferred.make<DesktopUpdateCheckResult>();
        const existing = yield* Ref.modify(inFlight, (active) => [
          active,
          Option.isSome(active) ? active : Option.some(pending),
        ]);
        if (Option.isSome(existing)) return yield* restore(Deferred.await(existing.value));
        return yield* Effect.gen(function* () {
          yield* publish({
            ...current,
            status: "checking",
            message: null,
            errorContext: null,
            canRetry: false,
          });
          const result = yield* restore(
            checkGitHubRelease(current.channel, current.currentVersion).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.result,
            ),
          );
          const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          let next: DesktopUpdateState;
          if (result._tag === "Failure") {
            next = {
              ...current,
              status: "error",
              checkedAt,
              message: result.failure.message,
              errorContext: "check",
              canRetry: true,
            };
          } else {
            const release = result.success;
            const notes = release
              ? normalizeDesktopUpdateReleaseNotes(
                  [{ version: release.version, note: release.body }],
                  current.currentVersion,
                  current.channel,
                )
              : { releaseNotes: [], omittedReleaseCount: 0 };
            next = {
              ...current,
              status: release ? "available" : "up-to-date",
              availableVersion: release?.version ?? null,
              releaseUrl: release?.releaseUrl ?? null,
              ...notes,
              checkedAt,
              message: null,
              errorContext: null,
              canRetry: false,
            };
          }
          yield* publish(next);
          const answer = { checked: result._tag === "Success", state: next };
          return answer;
        }).pipe(
          Effect.onExit((exit) =>
            (Exit.isFailure(exit) ? publish(current) : Effect.void).pipe(
              Effect.andThen(Deferred.done(pending, exit)),
            ),
          ),
          Effect.ensuring(Ref.set(inFlight, Option.none())),
        );
      }),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(state),
    isActionActive: Ref.get(inFlight).pipe(Effect.map(Option.isSome)),
    subscribe: Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return { latest: yield* Ref.get(state), changes: Stream.fromSubscription(subscription) };
    }),
    emitState: Ref.get(state).pipe(
      Effect.flatMap((next) => windows.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, next)),
    ),
    disabledReason: Effect.succeed(Option.fromNullishOr(reason)),
    configure: Effect.gen(function* () {
      if (yield* Ref.getAndSet(configured, true)) return;
      yield* check("startup").pipe(Effect.forkScoped);
    }),
    check,
    setChannel: (channel) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (
            Option.isSome(yield* Ref.get(inFlight)) ||
            (yield* Ref.getAndSet(channelChanging, true))
          )
            return yield* new DesktopUpdateActionInProgressError({
              action: "check",
              requestedChannel: channel,
            });
          yield* Effect.gen(function* () {
            yield* settings
              .setUpdateChannel(channel)
              .pipe(
                Effect.mapError(
                  (cause) => new DesktopUpdateChannelPersistenceError({ channel, cause }),
                ),
              );
            const current = yield* Ref.get(state);
            yield* publish({
              ...current,
              channel,
              availableVersion: null,
              releaseUrl: null,
              releaseNotes: [],
              omittedReleaseCount: 0,
              checkedAt: null,
              errorContext: null,
              canRetry: false,
              message: reason,
              status: current.enabled ? "idle" : "disabled",
            });
          }).pipe(Effect.ensuring(Ref.set(channelChanging, false)));
          return (yield* restore(check("channel-change"))).state;
        }),
      ),
  });
});
export const layer = Layer.effect(DesktopUpdates, make);
