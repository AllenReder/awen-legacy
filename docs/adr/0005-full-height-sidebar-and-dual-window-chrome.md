# Full-height Sidebar and Dual Window Chrome

The client shell adopts a full-height, left-through ("贯通式") Sidebar from top to bottom (0 to 100vh), alongside an independent Workbench Tab titlebar in the right panel. Window controls (macOS traffic lights, sidebar toggle, and settings/back button) dynamically hand off between the Sidebar and Workbench headers depending on whether the Sidebar is expanded or collapsed.

## Status

Accepted. ADR-0032 supersedes the unified spacing unit and fixed minimum
Sidebar width below; the full-height Sidebar and dual-chrome arrangement remain.

## Context

Previously, the Workbench owned a single frameless title strip (`WorkbenchWindowChrome`) spanning the entire window width (`fixed inset-x-0 top-0`), which pushed the Sidebar down by 36px. Because the Tab list started shortly after the macOS traffic lights, tabs spilled over the top of the Sidebar. Moreover, the Settings button was relegated to the bottom of the Sidebar.

The new layout treats the Sidebar as a full-height navigation pillar on the left. The window top is horizontally partitioned into two coordinated headers (both 36px in height):

1. **Sidebar Header (left)**: When expanded, it houses the macOS traffic lights, a left-aligned Sidebar hide button, a middle draggable drag region, and a right-aligned Settings button (or Back button when in `/settings`).
2. **Workbench Header (right)**: When the Sidebar is expanded, tabs begin immediately at the left border of the Workbench without overlapping the Sidebar. When the Sidebar is collapsed, the Workbench expands to full width and seamlessly takes over the traffic lights, placing the Sidebar open trigger and Settings button immediately next to the traffic lights, followed by a hairline separator and the Tab list.

A unified spacing constant $S$ (12px, derived from the window left edge to the traffic lights) governs the spacing throughout: between the traffic lights and the hide button, between the buttons at minimum width, and between the Settings button and the sidebar right border. The minimum sidebar width is locked at 156px ($64\text{px} + 12\text{px} + 28\text{px} + 12\text{px} + 28\text{px} + 12\text{px}$) so that at minimum width, the inter-button gap symmetrically matches the traffic-light gap.

## Consequences

- The global `html[data-workbench-window-chrome]` CSS rules that previously offset `sidebar-container` and `sidebar-inset` are removed.
- Sidebar minimum width is reduced to 156px while preserving content legibility.
- Control buttons (Sidebar trigger, Settings, Back) share unified 28x28 styling, Apple-style active press scaling (`active:scale-[0.98]`), and `-webkit-app-region: no-drag`.
- On non-macOS platforms (Windows/Linux), the same layout applies without the left traffic-light inset, aligning the controls to the window's left border (amended by ADR 0011 to adopt a 12px baseline margin on Windows).
