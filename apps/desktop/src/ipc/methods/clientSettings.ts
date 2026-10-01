import { ClientSettingsSchema } from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Path from "effect/Path";
import { importDesktopArtwork } from "../../app/DesktopArtwork.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class DesktopArtworkSelectionError extends Data.TaggedError("DesktopArtworkSelectionError")<{
  readonly message: string;
}> {}

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const saved = Option.getOrNull(yield* clientSettings.get);
    const path = yield* Path.Path;
    if (saved?.chatBackgroundPath && path.isAbsolute(saved.chatBackgroundPath)) {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const chatBackgroundPath = yield* Effect.tryPromise(() =>
        importDesktopArtwork(
          saved.chatBackgroundPath!,
          environment.stateDir,
          environment.isDevelopment,
        ),
      ).pipe(Effect.orElseSucceed(() => null));
      if (chatBackgroundPath) {
        const migrated = { ...saved, chatBackgroundPath };
        yield* clientSettings.set(migrated);
        return migrated;
      }
    }
    return saved;
  }),
});

export const setClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.set")(function* (settings) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
    const path = yield* Path.Path;
    if (settings.chatBackgroundPath && path.isAbsolute(settings.chatBackgroundPath)) {
      const saved = yield* clientSettings.get;
      if (Option.isNone(saved) || saved.value.chatBackgroundPath !== settings.chatBackgroundPath) {
        return yield* Effect.fail(
          new DesktopArtworkSelectionError({
            message: "Choose wallpaper with the file picker before saving it.",
          }),
        );
      }
    }
    yield* clientSettings.set(settings);
    yield* snapShot.configure(settings);
  }),
});
