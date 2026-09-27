/**
 * Source maps are a local debugging tool, not a shipped artifact.
 *
 * `apps/web/dist` is embedded whole into the desktop binary and published to
 * the web host, and today's maps carry the full TypeScript source — they were
 * 50 MB of a 74 MB client build. A production build therefore ships none
 * unless one is asked for explicitly; the dev server keeps its inline maps.
 *
 * `AWEN_WEB_SOURCEMAP`:
 *   unset / anything else → no build map, dev CSS map on
 *   `1` / `true`          → inline build map
 *   `hidden`              → build map without a `sourceMappingURL` comment
 *   `0` / `false`         → no build map, dev CSS map off too
 */
export interface SourcemapMode {
  /** `build.sourcemap` for a production build. */
  readonly build: boolean | "hidden";
  /** `css.devSourcemap` for the dev server. */
  readonly cssDev: boolean;
}

export function resolveSourcemapMode(raw: string | undefined): SourcemapMode {
  switch (raw?.trim().toLowerCase()) {
    case "hidden":
      return { build: "hidden", cssDev: true };
    case "1":
    case "true":
      return { build: true, cssDev: true };
    case "0":
    case "false":
      return { build: false, cssDev: false };
    default:
      return { build: false, cssDev: true };
  }
}
