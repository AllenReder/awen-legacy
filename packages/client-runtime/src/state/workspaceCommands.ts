import type { EnvironmentId } from "@awen/contracts";
import { WS_METHODS as RpcMethods } from "@awen/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

const workspaceCommandScheduler = createAtomCommandScheduler();
const workspaceCommandConcurrency = {
  mode: "serial" as const,
  key: ({
    environmentId,
    input,
  }: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly projectId?: string; readonly workspaceId?: string };
  }) => JSON.stringify([environmentId, input.projectId ?? input.workspaceId]),
};

export function createEnvironmentWorkspaceCommandAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    register: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace:register",
      tag: RpcMethods.awenWorkspaceRegister,
      scheduler: workspaceCommandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.path]),
      },
    }),
    associate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace:associate",
      tag: RpcMethods.awenWorkspaceAssociate,
      scheduler: workspaceCommandScheduler,
      concurrency: workspaceCommandConcurrency,
    }),
    createWorktree: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace:create-worktree",
      tag: RpcMethods.awenWorkspaceCreateWorktree,
      scheduler: workspaceCommandScheduler,
      concurrency: workspaceCommandConcurrency,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace:remove",
      tag: RpcMethods.awenWorkspaceRemove,
      scheduler: workspaceCommandScheduler,
      concurrency: workspaceCommandConcurrency,
    }),
    rename: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workspace:rename",
      tag: RpcMethods.awenWorkspaceRename,
      scheduler: workspaceCommandScheduler,
      concurrency: workspaceCommandConcurrency,
    }),
    renameProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project:rename",
      tag: RpcMethods.awenProjectRename,
      scheduler: workspaceCommandScheduler,
      concurrency: workspaceCommandConcurrency,
    }),
  };
}
