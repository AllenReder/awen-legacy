# Pane identity and static View catalog

Issue #168, implementing the Workbench portion of approved spec #156, supersedes
the independent View instance in ADR-0002 and the per-Tab, in-place file reuse
policy in ADR-0008. A Pane directly holds its definition, typed resource target,
and local presentation state. The static built-in catalog validates the current
parameters and computes resource identity; no per-View versions or migrations
are supported.

Reuse is global per definition and concrete resource. Files, individual file
editors, and Git use separate definitions. An editor is addressed by Environment,
Workspace and normalized relative path. Normal navigation from a Pane opens
beside it or focuses the existing resource. Explicit split/drop moves the same
Pane identity and presentation state. This generalizes ADR-0010's Session
uniqueness to all concrete resources without changing layout algorithms.

Agent and Terminal targets use their canonical Environment-scoped Session
identities. Agent navigation resolves the current Workspace assignment; already
opened files retain their original targets. Component unmount only releases
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
