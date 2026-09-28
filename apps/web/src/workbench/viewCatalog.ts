import type {
  AgentSessionId,
  AwenProjectId,
  EnvironmentId,
  TerminalSessionId,
  WorkspaceId,
} from "@awen/contracts";

/** Each definition owns its typed parameters. Runtime identities stay in adapters. */
export interface WorkspaceViewTarget {
  readonly kind: "workspace";
  readonly environmentId: EnvironmentId;
  readonly workspaceId: WorkspaceId;
  readonly initialPath?: string | undefined;
  readonly revealLine?: number | undefined;
}

export interface ViewTargets {
  welcome: { readonly kind: "welcome"; readonly definitionId?: "welcome" };
  project: {
    readonly kind: "project";
    readonly environmentId: EnvironmentId;
    readonly projectId: AwenProjectId;
    readonly definitionId?: "project";
  };
  agentSession: {
    readonly kind: "agentSession";
    readonly environmentId: EnvironmentId;
    readonly agentSessionId: AgentSessionId;
    readonly definitionId?: "agentSession";
  };
  workspaceTerminal: {
    readonly kind: "workspaceTerminal";
    readonly environmentId: EnvironmentId;
    readonly terminalSessionId: TerminalSessionId;
    /** Mutable assignment is not part of resource identity. */
    readonly workspaceId?: WorkspaceId;
    readonly definitionId?: "workspaceTerminal";
  };
  fileView: WorkspaceViewTarget & {
    readonly definitionId: "fileView";
    readonly initialPath?: never;
    readonly revealLine?: never;
  };
  fileEditor: WorkspaceViewTarget & {
    readonly definitionId: "fileEditor";
    readonly initialPath: string;
  };
  gitView: WorkspaceViewTarget & {
    readonly definitionId: "gitView";
    readonly initialPath?: never;
    readonly revealLine?: never;
  };
}

export type ViewTarget = ViewTargets[keyof ViewTargets];

export type ViewKind = ViewTarget["kind"];
export function definitionIdForTarget(target: ViewTarget): keyof ViewTargets {
  return target.definitionId ?? target.kind;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const workspace = (value: Record<string, unknown>) =>
  value.kind === "workspace" && identity(value.environmentId) && identity(value.workspaceId);
const path = (value: unknown): value is string =>
  identity(value) &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !/^[A-Za-z]:/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

interface CatalogEntry {
  readonly validate: (value: Record<string, unknown>) => boolean;
  readonly resource: (target: ViewTarget) => readonly unknown[];
}

/** Static built-ins own current parameter validation and concrete resource identity. */
const catalog: Readonly<Record<keyof ViewTargets, CatalogEntry>> = {
  welcome: {
    validate: (value) => value.kind === "welcome",
    resource: () => [],
  },
  project: {
    validate: (value) =>
      value.kind === "project" && identity(value.environmentId) && identity(value.projectId),
    resource: (target) =>
      target.kind === "project" ? [target.environmentId, target.projectId] : [],
  },
  agentSession: {
    validate: (value) =>
      value.kind === "agentSession" &&
      identity(value.environmentId) &&
      identity(value.agentSessionId),
    resource: (target) =>
      target.kind === "agentSession" ? [target.environmentId, target.agentSessionId] : [],
  },
  workspaceTerminal: {
    validate: (value) =>
      value.kind === "workspaceTerminal" &&
      identity(value.environmentId) &&
      identity(value.terminalSessionId) &&
      (value.workspaceId === undefined || identity(value.workspaceId)),
    resource: (target) =>
      target.kind === "workspaceTerminal" ? [target.environmentId, target.terminalSessionId] : [],
  },
  fileView: {
    validate: (value) =>
      workspace(value) && value.initialPath === undefined && value.revealLine === undefined,
    resource: (target) =>
      target.kind === "workspace" ? [target.environmentId, target.workspaceId] : [],
  },
  fileEditor: {
    validate: (value) =>
      workspace(value) &&
      path(value.initialPath) &&
      (value.revealLine === undefined ||
        (Number.isSafeInteger(value.revealLine) && Number(value.revealLine) > 0)),
    resource: (target) =>
      target.kind === "workspace"
        ? [
            target.environmentId,
            target.workspaceId,
            ...(target.initialPath === undefined ? [] : [target.initialPath]),
          ]
        : [],
  },
  gitView: {
    validate: (value) =>
      workspace(value) && value.initialPath === undefined && value.revealLine === undefined,
    resource: (target) =>
      target.kind === "workspace" ? [target.environmentId, target.workspaceId] : [],
  },
};

export function isViewTarget(value: unknown): value is ViewTarget {
  if (!record(value) || typeof value.kind !== "string") return false;
  const id = value.definitionId ?? value.kind;
  return (
    typeof id === "string" &&
    Object.hasOwn(catalog, id) &&
    catalog[id as keyof ViewTargets].validate(value)
  );
}

export function targetKey(target: ViewTarget): string {
  const id = definitionIdForTarget(target);
  const definition = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
  if (!definition || !isViewTarget(target)) throw new Error(`Invalid View target: ${id}`);
  return JSON.stringify([id, ...definition.resource(target)]);
}

export function targetsEqual(a: ViewTarget, b: ViewTarget): boolean {
  return targetKey(a) === targetKey(b);
}
