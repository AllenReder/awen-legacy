import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@awen/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
} from "@awen/client-runtime/state/shell";
import {
  type EnvironmentCatalogState,
  enabledEnvironmentIds,
} from "@awen/client-runtime/state/connections";
import type { EnvironmentId } from "@awen/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { isHostedStaticApp } from "../hostedPairing";
import { isLocalEnvironmentDisabled } from "../localEnvironment";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of enabledEnvironmentIds(catalog.value)) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    // A retrying environment is only transiently disconnected; give it its
    // first retries before letting the landing settle without its snapshot.
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

const NO_AUTHORITATIVE_ENVIRONMENTS: ReadonlySet<EnvironmentId> = Object.freeze(
  new Set<EnvironmentId>(),
);

export interface ProjectEnvironmentReadinessInput {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly requiresPrimaryEnvironment: boolean;
}

/**
 * Whether the catalog is settled enough to judge an Environment's absence.
 *
 * The persisted catalog can emit before platform discovery registers the
 * primary environment. Neither that gap nor an empty catalog proves absence.
 */
function catalogCanProveAbsence(
  catalog: EnvironmentCatalogState,
  requiresPrimary: boolean,
): boolean {
  if (!catalog.isReady || catalog.entries.size === 0) return false;
  if (
    requiresPrimary &&
    !Array.from(catalog.entries.values()).some(
      (entry) => entry.target._tag === "PrimaryConnectionTarget",
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Environments whose live snapshot can prove that a saved entity is gone.
 *
 * A cached, missing, or synchronizing snapshot cannot: it may simply not list
 * the entity yet. Callers that delete saved state must scope themselves to
 * these Environments instead of waiting for every Environment to be ready.
 */
export function createAuthoritativeProjectEnvironmentIdsAtom(
  input: ProjectEnvironmentReadinessInput,
): Atom.Atom<ReadonlySet<EnvironmentId>> {
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    if (!catalogCanProveAbsence(catalog, input.requiresPrimaryEnvironment)) {
      return NO_AUTHORITATIVE_ENVIRONMENTS;
    }
    const authoritative = new Set<EnvironmentId>();
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      const shell = get(input.shellStateValueAtom(environmentId));
      if (shell.status === "live" && Option.isSome(shell.snapshot)) {
        authoritative.add(environmentId);
      }
    }
    return authoritative;
  }).pipe(Atom.withLabel("web-authoritative-project-environments"));
}

/** Cached or missing snapshots cannot establish that a saved project no longer exists. */
export function createAllEnvironmentProjectSnapshotsReadyAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly requiresPrimaryEnvironment: boolean;
}) {
  const authoritative = createAuthoritativeProjectEnvironmentIdsAtom(input);
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    if (!catalogCanProveAbsence(catalog, input.requiresPrimaryEnvironment)) return false;
    const authoritativeIds = get(authoritative);
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      if (!authoritativeIds.has(environmentId)) return false;
    }
    return true;
  }).pipe(Atom.withLabel("web-all-environment-project-snapshots-ready"));
}

/**
 * A desktop app without its local server (or a hosted client) never registers
 * a primary Environment, so absence must be provable without one. Only the
 * desktop bridge can disable the local Environment, so window-less renders
 * still expect a primary one.
 */
const requiresPrimaryEnvironment =
  !isHostedStaticApp() && (typeof window === "undefined" || !isLocalEnvironmentDisabled());

export const allEnvironmentProjectSnapshotsReadyAtom =
  createAllEnvironmentProjectSnapshotsReadyAtom({
    catalogValueAtom: environmentCatalog.catalogValueAtom,
    shellStateValueAtom: environmentShell.stateValueAtom,
    requiresPrimaryEnvironment,
  });

export const authoritativeProjectEnvironmentIdsAtom = createAuthoritativeProjectEnvironmentIdsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
  requiresPrimaryEnvironment,
});
