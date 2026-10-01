# macOS trackpad input

`main.mm` observes precise AppKit scroll events for one Electron NSView/window.
It never consumes AppKit events. Node-API 8 keeps the binary independent of
Electron's Node module ABI; the renderer bridge validates packets and scales
coordinates/displacement into renderer CSS pixels using the current zoom.

Build with `node apps/desktop/scripts/build-trackpad.mjs --arch arm64` or `--arch x64`.
The build uses Xcode command-line tools, Node headers and an ad-hoc signature.
Installer CI builds the target architecture and copies the addon outside ASAR to
`resources/trackpad/awen-trackpad.node`; development loads the architecture-specific
build directory. A missing addon falls back to native content scrolling.

`start(handle, callback)` returns an observer id. `stop(id)` is idempotent; window
close and environment teardown remove the monitor and release the callback.
The callback receives gestureId, sequence, phase, deltaX/deltaY, timestamp and
window-local coordinates. `begin/update/end` describe direct input, `momentum`
describes inertia, `finish` clears completed momentum ownership and `cancel`
marks cancellation. No WebView delta is forwarded a second time.

The isolated appearance probe checks actual Electron loading and cleanup. A real
trackpad is still required to judge physical direction, momentum and resistance;
synthetic IPC tests prove routing, not physical input fidelity.
