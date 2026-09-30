# Window chrome geometry ownership

Accepted. This supersedes ADR-0005's unified spacing unit and fixed minimum
Sidebar width, and refines the geometry rules retained by ADR-0011 and ADR-0030.

Sidebar rendering used CSS's 76px macOS toggle position while its docking and
minimum-width calculations used 74px. Electron's preload separately reserved
90 native points. Independent edits to these sources removed the intended
2px button gap and made zoom and fullscreen reservations disagree.

A pure shared module owns application chrome geometry. Desktop supplies zoom
and fullscreen metrics; one renderer store converts native window points to
CSS pixels and publishes the same result to CSS, width constraints, and Sidebar
presentation. Global CSS owns theme and visual styling, and continues to adapt
the actual titlebar height and right reservation through Window Controls
Overlay environment values. Component-local styles remain local. We do not
centralize all styles in TypeScript or retain a second set of numeric CSS
geometry defaults guarded by string-parsing tests.

At 100% zoom, a normal macOS Electron window reserves 76 window points before
the Sidebar toggle. That reservation is divided by Electron zoom; application
buttons and their gaps remain CSS pixels. Browsers, non-macOS hosts, and macOS
fullscreen use a 12px left inset. Buttons are 28px square; the collapsed button
gap is 2px, the expanded action's right gap is 6px, and the separator has 6px to
its left and 12px to its right. Minimum Sidebar width and collapsed Tabs inset
are derived from these relationships, not independently configured numbers.
Native window buttons retain their separate 10-point left position and 7-point
half-height; a native inset and an application button gap are different concepts.

Sidebar drag frames report accepted width to application presentation. The
reusable Sidebar does not calculate Settings-button coordinates. The application
restores and commits its width preference once; geometry and viewport clamps
change the effective width without overwriting that preference. Auth and
pre-shell surfaces consume the same native reservation before Workbench mounts.
The older single-toggle reservation for View headers remains separate from the
Workbench's toggle-and-Settings reservation so nested content is not padded twice.
