import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { isDesktopRuntimeExternalDependency } from "../../scripts/lib/desktop-external-packages.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

Object.assign(process.env, loadRepoEnv());

// The main process is bundled the same way the server CLI is: every JS
// dependency is inlined and only packages Node must load from disk stay
// external. The packaged app then installs just those externals, instead of a
// full production install of apps/desktop's dependency tree next to a server
// bundle that already carries its own copy of the same libraries.
const isMainProcessExternal = (id: string) =>
  id === "electron" || id.startsWith("electron/") || isDesktopRuntimeExternalDependency(id);
const isElectronModule = (id: string) => id === "electron" || id.startsWith("electron/");
const shouldLaunchElectronAfterPack = process.env.AWEN_DESKTOP_DEV === "1";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "node scripts/build-trackpad.mjs && node scripts/build-preview-annotation-css.mjs && vp pack",
        cache: false,
      },
      "dev:desktop": {
        command:
          "node scripts/build-trackpad.mjs && node scripts/build-preview-annotation-css.mjs && cross-env AWEN_DESKTOP_DEV=1 vp pack --watch",
        cache: false,
      },
      dev: {
        command:
          "node scripts/build-trackpad.mjs && node scripts/build-preview-annotation-css.mjs && cross-env AWEN_DESKTOP_DEV=1 vp pack --watch",
        cache: false,
      },
      "dev:bundle": {
        command: "node scripts/build-trackpad.mjs && node scripts/build-preview-annotation-css.mjs && vp pack --watch",
        cache: false,
      },
      "dev:electron": {
        command: "node scripts/dev-electron.mjs",
        cache: false,
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      outputOptions: { codeSplitting: false },
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: [
        "src/electron/WindowsForegroundFocusWorker.ts",
        "src/snapShot/GlobalShiftShortcutWorker.ts",
        "src/snapShot/RegionSnapShotWorker.ts",
        "src/snapShot/SnapShotAccessibilityWorker.ts",
      ],
      clean: false,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
    },
    {
      // boot.cjs requires the other two at runtime, so all three stay separate files.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/boot.ts", "src/compileCache.ts"],
      clean: false,
      deps: {
        neverBundle: (id) => id === "./main.cjs" || id === "./compileCache.cjs",
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preload.ts"],
      deps: { neverBundle: isElectronModule },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pick-preload.ts"],
      deps: {
        alwaysBundle: (id) => id === "react-grab" || id.startsWith("react-grab/"),
        neverBundle: isElectronModule,
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pip-preload.ts"],
      deps: { neverBundle: isElectronModule },
    },
    {
      // Sandboxed preloads must be self-contained, without shared runtime chunks.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/mac-permission-preload.ts"],
      deps: { neverBundle: isElectronModule },
    },
  ],
  test: {
    testTimeout: 15_000,
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
});
