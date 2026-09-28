import { WS_METHODS as RpcMethods } from "@awen/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

const sessionCommandScheduler = createAtomCommandScheduler();

/**
 * Agent Session operations that are the sole orchestration path for moving a
 * Session between Workspaces. The Sidebar and the composer invoke these same
 * atoms rather than assembling a different command sequence.
 */
export function createEnvironmentSessionCommandAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    migrateToWorkspace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:session:migrate-to-workspace",
      tag: RpcMethods.awenSessionMigrateToWorkspace,
      scheduler: sessionCommandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.agentSessionId]),
      },
    }),
  };
}
