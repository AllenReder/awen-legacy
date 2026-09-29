import type { DiscoveredLocalServer } from "@awen/contracts";
import { isLoopbackHost } from "@awen/shared/preview";
import { useMemo } from "react";

import type { EnvironmentId } from "@awen/contracts";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useDiscoveredPortsState } from "~/portDiscoveryState";

export interface PreviewableServer extends DiscoveredLocalServer {
  source: "scanner" | "configured";
  /**
   * Pre-resolution loopback url. `url` is the resolved navigation target
   * (volatile on a remote environment); history must key off this instead.
   */
  requestedUrl: string;
}

interface UseDiscoveredLocalServersInput {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
}

/**
 * Enrich the environment-level live server snapshot with matching configured
 * URLs and return a stable sorted list.
 */
export function useDiscoveredLocalServers(
  input: UseDiscoveredLocalServersInput,
): ReadonlyArray<PreviewableServer> {
  const scannerState = useDiscoveredPortsState(input.environmentId, input.configuredUrls);

  return useMemo(
    () =>
      mergeServers({
        scanner: resolveReachableScannerServers(input.environmentId, scannerState.servers),
        configuredUrls: input.configuredUrls ?? [],
        configuredUrlProbing: scannerState.configuredUrlProbing,
      }),
    [input.environmentId, scannerState, input.configuredUrls],
  );
}

/**
 * Resolves the scanner's raw loopback URLs against their environment.
 *
 * Entries whose environment is not connected are dropped rather than offered:
 * a loopback URL only means something on the environment's own machine, and
 * navigating to the raw value would open this machine's port instead.
 */
export function resolveReachableScannerServers(
  environmentId: EnvironmentId,
  servers: ReadonlyArray<DiscoveredLocalServer>,
): ReadonlyArray<DiscoveredLocalServer & { readonly requestedUrl: string }> {
  const resolved: Array<DiscoveredLocalServer & { requestedUrl: string }> = [];
  for (const server of servers) {
    try {
      resolved.push({
        ...server,
        url: resolveDiscoveredServerUrl(environmentId, server.url),
        requestedUrl: server.url,
      });
    } catch {
      // Unreachable right now; the live scan will offer it again once the
      // environment is connected.
    }
  }
  return resolved;
}

export function mergeServers(input: {
  scanner: ReadonlyArray<DiscoveredLocalServer & { requestedUrl: string }>;
  configuredUrls: ReadonlyArray<string>;
  configuredUrlProbing?: boolean;
}): ReadonlyArray<PreviewableServer> {
  const configuredByServer = new Map<string, { host: string; port: number; url: string }>();

  for (const url of input.configuredUrls) {
    const parsed = parseLocalUrl(url);
    if (!parsed) continue;
    const key = canonicalKey(parsed.host, parsed.port);
    if (!configuredByServer.has(key)) configuredByServer.set(key, parsed);
  }

  const live: PreviewableServer[] = [];
  for (const server of input.scanner) {
    const key = canonicalKey(server.host, server.port);
    const configured = configuredByServer.get(key);
    live.push({
      ...server,
      requestedUrl:
        configured && input.configuredUrlProbing === false ? configured.url : server.requestedUrl,
      source: configured ? "configured" : "scanner",
    });
  }

  return live.toSorted((a, b) => {
    const sourceOrder: Record<PreviewableServer["source"], number> = {
      configured: 0,
      scanner: 1,
    };
    if (sourceOrder[a.source] !== sourceOrder[b.source]) {
      return sourceOrder[a.source] - sourceOrder[b.source];
    }
    return a.port - b.port;
  });
}

function canonicalKey(host: string, port: number): string {
  const normalizedHost = host.toLowerCase();
  return `${isLoopbackHost(normalizedHost) ? "loopback" : normalizedHost}:${port}`;
}

function parseLocalUrl(raw: string): { host: string; port: number; url: string } | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!isLoopbackHost(parsed.hostname)) return null;
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "http:"
        ? 80
        : 443;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host: parsed.hostname, port, url: parsed.href };
  } catch {
    return null;
  }
}
