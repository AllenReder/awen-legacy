# Versions and releases

Awen uses one SemVer version for the web app, Windows/macOS desktop installers,
and Linux x64 daemon. The root `package.json` is authoritative; the version
script synchronizes package manifests; Electron uses the desktop manifest directly.
Changing the version also increments the numeric macOS bundle build number.
Ordinary commits and merges never publish artifacts.

## Choose the next version

During the pre-1.0 alpha, use `0.1.0-alpha.N` for planned feature releases.
Do not reuse an existing published tag. Increment `N` for another build in the same prerelease series. Use a new
`0.1.x-alpha.1` series for a separately versioned patch line only after
`0.1.0` has shipped; while `0.1.0` is still in alpha, bug-fix builds are
`0.1.0-alpha.2`, `alpha.3`, and so on. After `0.1.0`, a backward-compatible
bug fix increments the patch (`0.1.1`), a compatible feature release
increments the minor (`0.2.0`), and a breaking release increments the major.

Set and verify the product version from the repository root:

```bash
pnpm version:set 0.1.0-alpha.4
pnpm version:check
```

Review and commit those manifest changes with the release candidate. The CI
workflow checks version consistency, typechecks, lints, and builds the
web/server workspace, runs the test suite in shards, and compiles the desktop
shell on Linux. On pull requests and pushes to `main` it then runs
`build-installers.yml` - the same workflow a release calls - which packages the
Linux x64 daemon, the Windows installer, and both macOS DMGs, and verifies the
installed daemon resources and desktop startup before upload.

## Publish

After the version commit is on `main` and CI passes, push the matching tag:

```bash
git tag v0.1.0-alpha.4
git push origin v0.1.0-alpha.4
```

The tag starts the release workflow. It verifies that the tag exactly matches
all product versions, bundles the daemon and Node runtime with the desktop
installers on Windows and both macOS architectures, builds and smoke-tests the Linux x64 daemon package,
and publishes all assets with GitHub-generated release notes. A SemVer version
containing a prerelease suffix becomes a GitHub prerelease; a version without a
suffix becomes a stable release. The final `release-assets` artifact contains only the verified installers and checksums. Publication verifies the inventory without reinstalling dependencies or transforming assets, creates a draft, uploads all files, then publishes it.
The workflow never
publishes an npm package.

Windows releases use the Electron NSIS `.exe` installer; macOS releases use DMGs. Desktop version checks read GitHub Releases and open the exact Release page for manual installation. No automatic download, installation or restart is supported. First launching a newly installed desktop version replaces its managed local daemon and may interrupt Agent and Terminal Sessions; ordinary quits keep those Sessions running. Linux daemon and SSH environment upgrades retain their independent flows.

Rehearse a release without publishing by running the `Release` workflow
manually against the release commit: it validates the version, builds and
uploads every installer as a workflow artifact, and stops before the publish
job. Set the `publish` input on a tag ref when the dry run is meant to publish.

Assets use `Awen-<version>-windows-x64.exe`,
`Awen-<version>-macos-{arm64,x64}.dmg`, and
`awen-server-<version>-linux-x64.tar.gz`. The daemon archive includes its own
`SHA256SUMS`; the release also includes checksums covering every installer and
archive.

Windows installers are unsigned. With no Apple credentials, macOS DMGs are
ad-hoc signed; users must explicitly allow the app in macOS Privacy & Security.
Apple credentials are all-or-nothing: `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_ID`,
`APPLE_PASSWORD`, and `APPLE_TEAM_ID` either are all configured, which signs
with Developer ID and notarizes, or none are, which builds an ad-hoc DMG.
The release job mounts each DMG and verifies the bundled `.app` code signature
and resource seal before publishing, preventing the “damaged” failure caused
by an incomplete bundle signature. To publish a Developer ID
signed and notarized DMG, set `APPLE_CERTIFICATE` (base64 `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific),
`APPLE_TEAM_ID`, and `KEYCHAIN_PASSWORD` as repository secrets.

Desktop resources share one layout: `resources/runtime/{node,dist/bin.mjs,dist/client,node_modules}` (Windows uses `node.exe`). Linux development requires `pkg-config`, `libsecret-1-dev`, and a display (CI uses Xvfb); this release does not publish Linux desktop installers.
