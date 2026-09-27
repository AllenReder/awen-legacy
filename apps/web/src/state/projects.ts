import { Atom, AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { terminalEnvironment } from "./terminal";
import { createEnvironmentProjectAtoms } from "@awen/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@awen/client-runtime/state/projects";
import { createEnvironmentWorkspaceAtoms } from "@awen/client-runtime/state/workspaceEntities";
import { createEnvironmentWorkspaceCommandAtoms } from "@awen/client-runtime/state/workspaceCommands";
import { createEnvironmentSessionCommandAtoms } from "@awen/client-runtime/state/sessionCommands";
import { createEnvironmentRpcQueryAtomFamily } from "@awen/client-runtime/state/runtime";
import { WS_METHODS } from "@awen/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
/**
 * Web-only: project content search backs the ⇧⌘F dialog, which has no mobile
 * surface, so the atom family lives here instead of the shared client-runtime
 * project atoms consumed by the mobile app.
 */
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
export const environmentWorkspace = createEnvironmentWorkspaceAtoms({
  terminalMetadataAtom: Atom.family((environmentId) =>
    Atom.make((get) =>
      Option.getOrNull(
        AsyncResult.value(get(terminalEnvironment.metadata({ environmentId, input: null }))),
      ),
    ),
  ),
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
export const workspaceEnvironment = createEnvironmentWorkspaceCommandAtoms(connectionAtomRuntime);
export const sessionEnvironment = createEnvironmentSessionCommandAtoms(connectionAtomRuntime);
