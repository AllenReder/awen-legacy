# Continuous integration

PRs, pushes to `main` and manual runs use `.github/workflows/ci.yml`. Tagged releases and manual dry runs use `.github/workflows/release.yml`. Both call `build-installers.yml`, so the installers a release publishes come from the definition `main` and packaging-changing pull requests already ran.

A pull request runs the four-target installer matrix only when it changes a packaging input: the desktop app, its native modules, the packaging scripts (`scripts/`), the dependency graph (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`) or the workflows (`.github/workflows/`). `scripts/packaging-inputs.ts` owns that list. Everything else is covered by `quality`, `tests` and the Linux `desktop-shell` smoke; the full matrix still runs on every push to `main`, every tag, and `gh workflow run ci.yml --ref <branch>` on demand.

## Required checks

- `quality`: consistent versions, formatting, typecheck, lint and web/server build.
- `tests`: server and web in two shards each; remaining workspace tests exclude desktop.
- `desktop-shell`: Linux build, preload verification, desktop tests and Xvfb startup smoke. Install `pkg-config`, `libsecret-1-dev`, GTK, NSS and audio/display libraries before tests or native compilation.
- `installers`: Linux x64 daemon, Windows x64 NSIS installer, macOS arm64 and x64 DMGs. Each platform verifies packaged runtime startup and installed Electron behavior. macOS uses native `macos-15` and `macos-15-intel` runners; Windows uses `windows-2025`. Runs on `main`, tags, manual runs and packaging-changing pull requests.
- `assemble`: exact final inventory plus `SHA256SUMS`, uploaded as `release-assets` after every installer verification succeeds.
- `CI gate`: fails on any failure or cancellation. The one skip it tolerates is the installer matrix on a pull request the change detector cleared, and the gate re-checks that against the detector before passing.

No Linux desktop installer is published. Linux GUI smoke validates Electron development support.

## Signing

The signing step reads six secrets as one group: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. None means ad-hoc signing with explicit `mac.identity=-`, identity autodiscovery and hardened runtime disabled, and PR signing enabled. Developer ID builds keep hardened runtime. All means Developer ID signing, notarization and stapling. Any partial configuration fails. Apple credentials are confined to the signing step and exported only for complete Developer ID configuration.

## Local reproduction

```bash
pnpm version:check
pnpm fmt:check
pnpm typecheck
pnpm lint
pnpm test:packages
pnpm test:server
pnpm test:web
pnpm --filter @awen/desktop test
node scripts/stage-desktop-runtime.ts --platform darwin --arch arm64
```

Runtime staging accepts `--platform darwin|win32|linux` and `--arch arm64|x64`. Explicit targets download the pinned official Node build and verify its published SHA256; without arguments it copies the host Node binary. Native addons are built on matching host runners. Downloads cached through `AWEN_NODE_RUNTIME_CACHE` are reverified before use.

Platform collection and installation checks are in `scripts/release/`. Their `VERSION`, `ARCH`, `MACHO_ARCH` and `SIGNING_MODE` inputs match the reusable workflow. `assets.mjs assemble|verify <directory> <version>` rejects extra, missing, empty, linked or modified release assets.
