import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  DesktopPreviewBridge,
  DesktopPreviewWebviewConfig,
  EnvironmentId,
} from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";

const PREVIEW_CONFIG_STALE_TIME_MS = 5 * 60_000;
const PREVIEW_CONFIG_IDLE_TTL_MS = 10 * 60_000;

export class PreviewWebviewBridgeUnavailableError extends Schema.TaggedError<PreviewWebviewBridgeUnavailableError>()(
  "PreviewWebviewBridgeUnavailableError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Desktop preview configuration is unavailable for environment "${this.environmentId}".`;
  }
}

export class PreviewWebviewConfigLoadError extends Schema.TaggedError<PreviewWebviewConfigLoadError>()(
  "PreviewWebviewConfigLoadError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load desktop preview configuration for environment "${this.environmentId}".`;
  }
}

export const PreviewWebviewConfigError = Schema.Union([
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
]);
export type PreviewWebviewConfigError = typeof PreviewWebviewConfigError.Type;

type PreviewConfigBridge = Pick<DesktopPreviewBridge, "getPreviewConfig">;

export const loadPreviewWebviewConfig = (
  environmentId: EnvironmentId,
  profileId?: string,
  bridge: PreviewConfigBridge | null = previewBridge,
): Effect.Effect<DesktopPreviewWebviewConfig, PreviewWebviewConfigError> => {
  if (bridge === null) {
    return Effect.fail(new PreviewWebviewBridgeUnavailableError({ environmentId }));
  }

  return Effect.tryPromise({
    try: () => bridge.getPreviewConfig(environmentId, profileId),
    catch: (cause) => new PreviewWebviewConfigLoadError({ environmentId, cause }),
  });
};

/**
 * `Atom.family` keys on its argument, so the environment and profile are
 * folded into one string: passing an object would allocate a fresh entry on
 * every render.
 *
 * The profile is the tail rather than a second field, so an id containing the
 * delimiter round-trips whole instead of being truncated into a different
 * profile's key. `BrowserProfileId` rejects control characters, which is what
 * makes the environment side of the split unambiguous.
 */
const CONFIG_KEY_DELIMITER = "\u0000";

const configKey = (environmentId: EnvironmentId, profileId: string | undefined): string =>
  `${environmentId}${CONFIG_KEY_DELIMITER}${profileId ?? ""}`;

const parseConfigKey = (key: string): { environmentId: EnvironmentId; profileId?: string } => {
  const delimiter = key.indexOf(CONFIG_KEY_DELIMITER);
  const environmentId = (delimiter === -1 ? key : key.slice(0, delimiter)) as EnvironmentId;
  const profileId = delimiter === -1 ? "" : key.slice(delimiter + CONFIG_KEY_DELIMITER.length);
  return {
    environmentId,
    ...(profileId === "" ? {} : { profileId }),
  };
};

const previewWebviewConfigAtom = Atom.family((key: string) => {
  const { environmentId, profileId } = parseConfigKey(key);
  return Atom.make(loadPreviewWebviewConfig(environmentId, profileId)).pipe(
    Atom.swr({
      staleTime: PREVIEW_CONFIG_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PREVIEW_CONFIG_IDLE_TTL_MS),
    Atom.withLabel(`preview:webview-config:${key}`),
  );
});

/**
 * The desktop preview configuration load, with failure kept distinct from the
 * first load so the surface can explain itself and offer a retry instead of
 * rendering nothing.
 */
export type PreviewWebviewConfigState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Ready"; readonly config: DesktopPreviewWebviewConfig }
  | {
      readonly _tag: "Unavailable";
      readonly error: PreviewWebviewConfigError;
      /** Re-runs the load, for the failure state's retry action. */
      readonly retry: () => void;
    };

export function usePreviewWebviewConfig(
  environmentId: EnvironmentId,
  profileId?: string,
): PreviewWebviewConfigState {
  const atom = previewWebviewConfigAtom(configKey(environmentId, profileId));
  const result = useAtomValue(atom);
  const retry = useAtomRefresh(atom);
  const error = AsyncResult.error(result);
  if (Option.isSome(error)) {
    return { _tag: "Unavailable", error: error.value, retry };
  }
  const config = AsyncResult.value(result);
  return Option.isSome(config) ? { _tag: "Ready", config: config.value } : { _tag: "Pending" };
}
