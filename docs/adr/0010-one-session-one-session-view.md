# One Session, one Session View across the Workbench

View identity and reuse decisions are superseded by [ADR-0028](0028-pane-view-catalog.md) and #156/#168.

**Status: accepted**

A Session has exactly one Session View in the whole Workbench. Opening a Session
that is already open focuses its View and activates its Tab; an explicit split or
drop **moves** that View instead of creating a second one. Presentation copying is
not an ACode operation in v1.

## Context

ADR-0002 allowed "a Session View … once per Tab and … in multiple Tabs", so C11
delivered per-Tab uniqueness with cross-Tab mirrors and C12 delivered an explicit
"Duplicate to new tab" action. ADR-0004 had already rejected per-Tab copies for the
Agent draft, because multiple Views would race over one composer, attachment set,
and promotion operation. The same argument applies to every Session View: a
mirrored Session gave two interactive surfaces over one transcript, one composer,
one approval surface, and one PTY.

Terminal Sessions made the cost concrete. C11 had to specify which mirror owned
input and resize, and to forbid hidden mirrors from resizing an active PTY — rules
that exist only because one Session could be displayed twice.

## Decision

- A Session View is unique across the Workbench: one Session, one Tab, one Pane.
  Agent and Terminal Sessions follow the same rule.
- Opening an already open Session (Sidebar click or Awen Deep Link) focuses the
  existing View and activates its Tab. It never creates a
  second View.
- An explicit split or a drag/drop of an already open Session **moves** that View:
  the source Pane is closed and the View lands at the requested position, including
  within one Tab. Dropping onto a Tab that already displays that Session merges to
  the single existing View and honours the drop zone.
- Presentation copying does not exist in v1: no menu action, button, shortcut, or
  drag modifier creates a second View instance of a Session.
- Uniqueness is scoped to **Session-targeted** Views by Awen Session identity
  (Environment + Thread for Agent Sessions; Environment + Workspace + Terminal
  Session for Terminal Sessions). File, Git, Project, and
  Workspace Views keep their own per-Tab coexistence rules (ADR-0008 stays in
  force).
- Two clients connected to one daemon may each display the same Session. That is
  not duplication: uniqueness is a Workbench rule, and the daemon remains the
  single acceptance authority for user actions on a Session.

## Alternatives considered

- **Per-Tab uniqueness with cross-Tab mirrors (the C11/C12 model).** Rejected: it
  multiplies interactive surfaces over one work instance and needs input/resize
  ownership rules that exist only to arbitrate between copies.
- **No uniqueness at all.** Rejected: it leaves "which Pane owns this composer and
  this approval" undefined, and contradicts the draft rule already in force.
- **Uniqueness for Agent Sessions only, mirrors allowed for Terminals.** Rejected:
  the Session definition in `CONTEXT.md` gives both kinds the same identity
  semantics; splitting the rule would make "one Session, one View" half an
  invariant.
- **Copying for non-Session Views only.** Rejected as a v1 feature: no such action
  existed, and multi-display comparison is a separate product need that deserves
  its own ticket rather than a leftover menu item.

## Consequences

- C11's per-Tab mirror ACs and C12's copy ACs are superseded; the Workbench keeps
  only focus (navigation) and move (layout intent) as presentation operations.
- Terminal input and resize ownership stop being a multi-View arbitration problem.
- A persisted layout written under the old model may contain the same Session in two
  Tabs. Loading repairs it to one View instead of rejecting the snapshot, so Tabs,
  layout, titles, and focus survive.
- `CONTEXT.md` carries `_Avoid_: Mirror, 镜像, Duplicate View`; the word describes a
  rejected model, not a feature.
- Comparing one Session side by side is not supported until a future ticket decides
  how to do it without duplicating interactive ownership.
