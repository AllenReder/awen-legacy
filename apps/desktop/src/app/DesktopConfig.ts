import { OtlpHeadersFromString, OtlpProtocol } from "@awen/shared/observability";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const optionalBoolean = (name: string) =>
  Config.boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  t3Home: trimmedString("AWEN_HOME"),
  devServerUrl: trimmedString("VITE_DEV_SERVER_URL").pipe(
    Config.map(Option.map((s) => new URL(s))),
  ),
  appUserModelIdOverride: trimmedString("AWEN_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteT3ServerEntryPath: trimmedString("AWEN_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: Config.number("AWEN_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("AWEN_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("AWEN_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("AWEN_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: trimmedString("AWEN_OTLP_TRACES_URL"),
  otlpMetricsUrl: trimmedString("AWEN_OTLP_METRICS_URL"),
  otlpLogsUrl: trimmedString("AWEN_OTLP_LOGS_URL"),
  otlpExportIntervalMs: Config.number("AWEN_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "AWEN_OTLP_HEADERS").pipe(Config.option),
  otlpProtocol: Config.schema(OtlpProtocol, "AWEN_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableUpdateCheck: optionalBoolean("AWEN_DISABLE_UPDATE_CHECK"),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
