# Pane identity and static View catalog

Issue #168, implementing the Workbench portion of approved spec #156, supersedes
the independent View instance in ADR-0002 and the per-Tab file reuse scope
in ADR-0008. ADR-0008’s in-place file switching remains the product behavior. A Pane directly holds its definition, typed resource target,
and local presentation state. The static built-in catalog validates the current
parameters and computes resource identity; no per-View versions or migrations
are supported.

Reuse is Workbench-wide per definition and concrete resource. Each Environment
and Workspace has one Files Pane combining browsing, preview and editing; Git
is a separate definition and can coexist. A file path is the Files Pane’s selected
presentation state, not an independently opened resource. File tree, Agent links,
search, composer mentions and Git actions all switch files in that same Pane.
Switching away from unsaved edits uses the existing save/discard/cancel decision;
opening Files without a file request preserves its selection and draft. A new
Workspace View opens beside its origin. Explicit split/drop moves the same Pane
identity and presentation state across Tabs without duplicating it.

This follows the maintainer’s correction to #156 stories 32/34 and #168: distinct
files in one Workspace do not open side by side. It replaces this PR’s earlier
per-file catalog entry, while retaining global reuse and the existing layouts.

Agent and Terminal targets use their canonical Environment-scoped Session
identities. Agent navigation resolves the current Workspace assignment; already
opened Files Panes retain their original Workspace and selected file. Component unmount only releases
presentation subscriptions and does not request resource closure.

The Workbench uses serialization format 2 and storage key `awen:workbench:v2`.
Old layout keys are not read or migrated; startup begins at Welcome until a new
layout is saved. Restoring the current format rejects unknown definitions,
invalid target parameters, duplicate Pane identities and duplicate resources.
This changes client layout restoration, not daemon Session data. Existing file
save conflict checks and dirty close guards remain in use, and editor drafts
travel with Pane presentation rather than being lost on cross-Tab remount.

Resource close coordination and native browser hosting remain separate tickets
under #156; this change does not implement their lifecycle policies.
