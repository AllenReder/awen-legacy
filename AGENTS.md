## Reference projects

See the open-source projects in `_refs/` for reference. They are read-only,
gitignored, and not part of the build.

The current `main` branch is the clean-slate Awen v1 implementation line.
Prefer adopting and adapting mature implementations from reference projects
over reimplementing equivalent infrastructure from scratch. Do not restore
pre-v1 implementation patterns unless a ticket or current architecture
decision explicitly requires them.

## Commits

Conventional Commits, `type(scope): subject`:

```text
feat(shell): add the pane layout tree
fix(ui): keep window controls on macOS
docs: record the token split
```

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`,
  `chore`, `revert`.
- Scope names the area touched and is optional. Prefer scopes that correspond
  to the current v1 codebase, such as `shell`, `ui`, `domain`, `runtime`,
  `server`, `contracts`, `ci`, or `docs`. Do not assume legacy directory or
  crate names still exist.
- The body states what changed and why. A fixed defect gets its own bullet
  naming the mechanism, so a later reader cannot reintroduce it.
- A breaking change takes `!` before the colon, plus a `BREAKING CHANGE:`
  footer naming what callers must do.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `AllenReder/awen`, driven by the
`gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to identically-named labels:
`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
See `docs/agents/triage-labels.md`.

### Domain docs

single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
