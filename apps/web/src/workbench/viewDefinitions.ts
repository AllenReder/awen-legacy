import { WorkspaceFileView } from "./WorkspaceFileView";
import { WorkspaceGitView } from "./WorkspaceGitView";
import { createWelcomeViewDefinition } from "./welcomeViewDefinition";
import { AgentView } from "./AgentView";
import { TerminalView } from "./TerminalView";
import {
  emptyViewBinding,
  registerViewDefinition,
  type ViewDefinition,
  type ViewTarget,
} from "./viewRegistry";

// Agent/Terminal remain trusted runtime adapters. Their migration to dedicated
// data sources belongs to the Session adapter tickets; no handles cross this seam.
export const agentViewDefinition: ViewDefinition<Extract<ViewTarget, { kind: "agentSession" }>> = {
  id: "agentSession",
  label: "Agent",
  accepts: (target): target is Extract<ViewTarget, { kind: "agentSession" }> =>
    target.kind === "agentSession",
  bind: emptyViewBinding,
  Component: AgentView,
};

export const workspaceFileViewDefinition: ViewDefinition<
  Extract<ViewTarget, { kind: "workspace" }>
> = {
  id: "fileView",
  label: "Files",
  accepts: (target): target is Extract<ViewTarget, { kind: "workspace" }> =>
    target.kind === "workspace" && target.definitionId === "fileView",
  bind: emptyViewBinding,
  Component: WorkspaceFileView,
};

export const workspaceGitViewDefinition: ViewDefinition<
  Extract<ViewTarget, { kind: "workspace" }>
> = {
  id: "gitView",
  label: "Changes",
  accepts: (target): target is Extract<ViewTarget, { kind: "workspace" }> =>
    target.kind === "workspace" && target.definitionId === "gitView",
  bind: emptyViewBinding,
  Component: WorkspaceGitView,
};

export const terminalViewDefinition: ViewDefinition<
  Extract<ViewTarget, { kind: "workspaceTerminal" }>
> = {
  id: "workspaceTerminal",
  label: "Terminal",
  accepts: (target): target is Extract<ViewTarget, { kind: "workspaceTerminal" }> =>
    target.kind === "workspaceTerminal",
  bind: emptyViewBinding,
  Component: TerminalView,
};

let registered = false;

/**
 * Idempotent module-load registration. Calling more than once is a no-op so
 * HMR and concurrent imports stay safe.
 */
export function registerCoreViewDefinitions(options: { force?: boolean } = {}): void {
  if (registered && !options.force) return;
  registerViewDefinition(createWelcomeViewDefinition());
  registerViewDefinition(agentViewDefinition);
  registerViewDefinition(terminalViewDefinition);
  registerViewDefinition(workspaceFileViewDefinition);
  registerViewDefinition(workspaceGitViewDefinition);
  registered = true;
}

registerCoreViewDefinitions();
