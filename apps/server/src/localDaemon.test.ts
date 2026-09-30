// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  LOCAL_DAEMON_PROTOCOL_VERSION,
  deriveLocalDaemonPaths,
  inspectLocalDaemon,
  makeLocalDaemonDiscovery,
  parseLocalDaemonDiscovery,
  requestedDaemonPort,
  startLocalDaemon,
  withLocalDaemonLaunchLock,
} from "./localDaemon.ts";

describe("local daemon discovery", () => {
  it("uses one state root and keeps credential paths out of discovery records", async () => {
    const baseDir = NodePath.join("/tmp", "Awen path with spaces");
    const paths = deriveLocalDaemonPaths(baseDir);
    const discovery = makeLocalDaemonDiscovery({
      daemonId: "daemon-1",
      pid: 321,
      origin: "http://127.0.0.1:43123/",
      startedAt: "2026-09-18T00:00:00.000Z",
      workingDirectory: "/worktree with spaces",
    });

    expect(paths.stateDir).toBe(NodePath.join(baseDir, "userdata"));
    expect(paths.runtimeStatePath).toBe(NodePath.join(baseDir, "userdata", "server-runtime.json"));
    expect(paths.credentialPath).toBe(
      NodePath.join(baseDir, "userdata", "secrets", "desktop-bootstrap.token"),
    );
    expect(discovery).toEqual({
      version: 1,
      daemonProtocolVersion: LOCAL_DAEMON_PROTOCOL_VERSION,
      daemonId: "daemon-1",
      daemonOwner: "awen-local-daemon",
      daemonWorkingDirectory: "/worktree with spaces",
      daemonManaged: true,
      pid: 321,
      origin: "http://127.0.0.1:43123/",
      startedAt: "2026-09-18T00:00:00.000Z",
    });
    expect(JSON.stringify(discovery)).not.toContain("desktop-bootstrap.token");
  });

  it("rejects records that cannot prove daemon ownership", () => {
    expect(
      parseLocalDaemonDiscovery({
        version: 1,
        daemonProtocolVersion: LOCAL_DAEMON_PROTOCOL_VERSION,
        daemonId: "daemon-1",
        daemonOwner: "awen-local-daemon",
        daemonWorkingDirectory: "/worktree",
        daemonManaged: true,
        pid: 321,
        origin: "http://127.0.0.1:43123",
        startedAt: "2026-09-18T00:00:00.000Z",
      }),
    ).toBeDefined();

    expect(
      parseLocalDaemonDiscovery({
        version: 1,
        pid: 321,
        origin: "http://127.0.0.1:43123",
      }),
    ).toBeUndefined();
    expect(
      parseLocalDaemonDiscovery({
        version: 1,
        daemonProtocolVersion: LOCAL_DAEMON_PROTOCOL_VERSION,
        daemonId: "daemon-1",
        daemonManaged: true,
        pid: 321,
        origin: "http://192.168.1.10:43123",
        startedAt: "2026-09-18T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});

describe("local daemon launch lock", () => {
  it("does not leave an unreadable lock if the launcher exits before writing its owner", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-interrupted-lock-"));
    const moduleUrl = new URL("./localDaemon.ts", import.meta.url).href;
    const script = `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const open = fs.open;
      fs.open = async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).includes("daemon-launch.lock")) process.exit(0);
        return handle;
      };
      syncBuiltinESMExports();
      const { withLocalDaemonLaunchLock } = await import(${JSON.stringify(moduleUrl)});
      await withLocalDaemonLaunchLock(${JSON.stringify(root)}, async () => {});
    `;
    try {
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          cwd: NodeURL.fileURLToPath(new URL("../", import.meta.url)),
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const lock = await NodeFSP.readFile(
        deriveLocalDaemonPaths(root).launchLockPath,
        "utf8",
      ).catch(() => undefined);
      expect(lock).toBeUndefined();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent work for one data root", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-local-daemon-lock-"));
    const order: string[] = [];

    const first = withLocalDaemonLaunchLock(root, async () => {
      order.push("first-enter");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("first-exit");
    });
    const second = withLocalDaemonLaunchLock(root, async () => {
      order.push("second-enter");
      order.push("second-exit");
    });

    await Promise.all([first, second]);
    expect(
      order.join(",") === "first-enter,first-exit,second-enter,second-exit" ||
        order.join(",") === "second-enter,second-exit,first-enter,first-exit",
    ).toBe(true);
  });
});

describe("requested daemon port", () => {
  it("treats daemon-specific keys as contracts and the server port as a preference", () => {
    expect(requestedDaemonPort({ AWEN_DAEMON_PORT: "13773" })).toEqual({
      _tag: "set",
      key: "AWEN_DAEMON_PORT",
      port: 13_773,
      required: true,
    });
    expect(requestedDaemonPort({ AWEN_DAEMON_PORT: "13773" })).toEqual({
      _tag: "set",
      key: "AWEN_DAEMON_PORT",
      port: 13_773,
      required: true,
    });
    // `AWEN_PORT` is the web dev runner's general server port: a leftover
    // listener must not stop `pnpm dev` from taking a free port instead.
    expect(requestedDaemonPort({ AWEN_PORT: "13773" })).toEqual({
      _tag: "set",
      key: "AWEN_PORT",
      port: 13_773,
      required: false,
    });
    expect(requestedDaemonPort({})).toEqual({ _tag: "unset" });
  });

  it("keeps the documented precedence and skips blank values", () => {
    expect(
      requestedDaemonPort({
        AWEN_DAEMON_PORT: "3333",
        AWEN_PORT: "4444",
      }),
    ).toEqual({ _tag: "set", key: "AWEN_DAEMON_PORT", port: 3333, required: true });
    expect(requestedDaemonPort({ AWEN_DAEMON_PORT: "  ", AWEN_PORT: "4444" })).toMatchObject({
      _tag: "set",
      key: "AWEN_PORT",
    });
  });

  it("rejects an unusable value instead of silently ignoring it", () => {
    expect(() => requestedDaemonPort({ AWEN_DAEMON_PORT: "not-a-port" })).toThrowError(
      /must be a port number between 1 and 65535/,
    );
    expect(() => requestedDaemonPort({ AWEN_PORT: "0" })).toThrowError(
      /must be a port number between 1 and 65535/,
    );
  });
});

const writeDiscovery = async (baseDir: string, state: unknown) => {
  const paths = deriveLocalDaemonPaths(baseDir);
  await NodeFSP.mkdir(paths.stateDir, { recursive: true });
  await NodeFSP.writeFile(paths.runtimeStatePath, `${JSON.stringify(state)}\n`, "utf8");
  return paths;
};

const listenForHandshake = async (
  handler: (request: import("node:http").IncomingMessage) => {
    readonly status: number;
    readonly body: unknown;
  },
) => {
  const server = NodeHttp.createServer((request, response) => {
    const result = handler(request);
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("test server did not expose a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("local daemon discovery diagnostics", () => {
  it("diagnoses malformed and stale records without starting a process", async () => {
    const malformedRoot = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-invalid-"));
    const malformedPaths = deriveLocalDaemonPaths(malformedRoot);
    await NodeFSP.mkdir(malformedPaths.stateDir, { recursive: true });
    await NodeFSP.writeFile(malformedPaths.runtimeStatePath, "{not-json", "utf8");
    await expect(inspectLocalDaemon(malformedRoot)).resolves.toMatchObject({ status: "invalid" });

    const staleRoot = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-stale-"));
    const stale = makeLocalDaemonDiscovery({
      daemonId: "stale-daemon",
      pid: 2_147_483_647,
      origin: "http://127.0.0.1:43123",
      startedAt: "2026-09-18T00:00:00.000Z",
      workingDirectory: "/stale",
    });
    await writeDiscovery(staleRoot, stale);
    await expect(inspectLocalDaemon(staleRoot)).resolves.toMatchObject({ status: "stale" });
  });

  it("rejects a live foreign process at the recorded endpoint", async () => {
    const server = await listenForHandshake(() => ({
      status: 200,
      body: {
        protocolVersion: LOCAL_DAEMON_PROTOCOL_VERSION,
        owner: "awen-local-daemon",
        daemonId: "foreign-daemon",
        pid: process.pid,
        managed: true,
      },
    }));
    try {
      const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-foreign-"));
      const state = makeLocalDaemonDiscovery({
        daemonId: "expected-daemon",
        pid: process.pid,
        origin: server.origin,
        startedAt: "2026-09-18T00:00:00.000Z",
        workingDirectory: "/foreign",
      });
      await writeDiscovery(root, state);
      await expect(inspectLocalDaemon(root, { verifyCredential: false })).resolves.toMatchObject({
        status: "foreign",
      });
    } finally {
      await server.close();
    }
  });

  it("diagnoses a rejected credential without replacing it", async () => {
    const server = await listenForHandshake((request) => ({
      status: request.url === "/.well-known/awen/daemon" ? 200 : 401,
      body:
        request.url === "/.well-known/awen/daemon"
          ? {
              protocolVersion: LOCAL_DAEMON_PROTOCOL_VERSION,
              owner: "awen-local-daemon",
              daemonId: "auth-daemon",
              pid: process.pid,
              managed: true,
            }
          : { error: "auth_invalid" },
    }));
    try {
      const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-auth-"));
      const state = makeLocalDaemonDiscovery({
        daemonId: "auth-daemon",
        pid: process.pid,
        origin: server.origin,
        startedAt: "2026-09-18T00:00:00.000Z",
        workingDirectory: "/auth",
      });
      const paths = await writeDiscovery(root, state);
      await NodeFSP.mkdir(NodePath.dirname(paths.credentialPath), { recursive: true });
      await NodeFSP.writeFile(paths.credentialPath, "invalid-token\n", { mode: 0o600 });

      await expect(inspectLocalDaemon(root)).resolves.toMatchObject({ status: "auth-invalid" });
      await expect(NodeFSP.readFile(paths.credentialPath, "utf8")).resolves.toBe("invalid-token\n");
    } finally {
      await server.close();
    }
  });

  it("resolves credential path under secrets directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-paths-"));
    const paths = deriveLocalDaemonPaths(root);
    expect(paths.credentialPath).toBe(
      NodePath.join(root, "userdata", "secrets", "desktop-bootstrap.token"),
    );
  });
});

const spawnIdleProcess = async (): Promise<NodeChildProcess.ChildProcess> => {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const listenOnLoopback = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  // A plain TCP listener that never answers HTTP, used to hold a port. Track its
  // sockets so an aborted probe request cannot leave a keep-alive connection
  // open and hang `close()`.
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("probe listener did not expose a TCP address");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
};

const writeFakeDaemon = async (
  root: string,
  markerDelayMs: number | null,
  serverVersion = "1.0.0",
) => {
  const scriptPath = NodePath.join(root, "fake-daemon.mjs");
  const pidPath = NodePath.join(root, "fake-daemon.pid");
  await NodeFSP.writeFile(
    scriptPath,
    `
import * as NodeFS from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const port = Number(process.env.AWEN_PORT);
const origin = \`http://127.0.0.1:\${port}/\`;
await NodeFS.writeFile(${JSON.stringify(pidPath)}, String(process.pid), "utf8");

const server = NodeHttp.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/.well-known/awen/daemon") {
    response.writeHead(200);
    response.end(JSON.stringify({
      protocolVersion: 1,
      owner: process.env.AWEN_DAEMON_OWNER,
      daemonId: process.env.AWEN_DAEMON_ID,
      pid: process.pid,
      managed: true,
    }));
    return;
  }
  if (request.url === "/.well-known/awen/environment") {
    response.writeHead(200);
    response.end(JSON.stringify({ serverVersion: ${JSON.stringify(serverVersion)} }));
    return;
  }
  if (request.url === "/api/auth/browser-session") {
    response.writeHead(200);
    response.end("{}");
    return;
  }
  response.writeHead(404);
  response.end("{}");
});

server.listen(port, "127.0.0.1", () => {
  ${
    markerDelayMs === null
      ? ""
      : `setTimeout(async () => {
    const statePath = NodePath.join(process.env.AWEN_HOME, "userdata", "server-runtime.json");
    await NodeFS.mkdir(NodePath.dirname(statePath), { recursive: true });
    await NodeFS.writeFile(statePath, JSON.stringify({
      version: 1,
      daemonProtocolVersion: 1,
      daemonId: process.env.AWEN_DAEMON_ID,
      daemonOwner: process.env.AWEN_DAEMON_OWNER,
      daemonWorkingDirectory: process.env.AWEN_DAEMON_WORKING_DIR,
      daemonManaged: true,
      pid: process.pid,
      origin,
      startedAt: new Date().toISOString(),
    }) + "\\n", "utf8");
  }, ${markerDelayMs}).unref();`
  }
});
`,
    "utf8",
  );
  return { scriptPath, pidPath };
};

const reserveLoopbackPort = async (): Promise<number> => {
  const holder = await listenOnLoopback();
  await holder.close();
  return holder.port;
};

describe("local daemon startup readiness", () => {
  it("reuses the same version and replaces an owned daemon for a desktop upgrade", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-version-"));
    let daemon: Awaited<ReturnType<typeof startLocalDaemon>> | undefined;
    const start = async (version: string) => {
      const fake = await writeFakeDaemon(root, 0, version);
      return startLocalDaemon({
        baseDir: root,
        expectedServerVersion: version,
        timeoutMs: 5_000,
        requestTimeoutMs: 250,
        reservePort: reserveLoopbackPort,
        serverInvocation: { command: process.execPath, args: [fake.scriptPath] },
      });
    };
    try {
      daemon = await start("1.0.0");
      const original = daemon;
      daemon = await start("1.0.0");
      expect(daemon.pid).toBe(original.pid);
      daemon = await start("1.1.0");
      expect(daemon.pid).not.toBe(original.pid);
      expect(processIsAlive(original.pid)).toBe(false);
      expect(processIsAlive(daemon.pid)).toBe(true);
    } finally {
      if (daemon && processIsAlive(daemon.pid)) process.kill(daemon.pid, "SIGKILL");
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("waits for the runtime marker after the ownership handshake", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-delayed-marker-"));
    const fake = await writeFakeDaemon(root, 200);
    let pid: number | undefined;
    try {
      const descriptor = await startLocalDaemon({
        baseDir: root,
        timeoutMs: 5_000,
        requestTimeoutMs: 250,
        reservePort: reserveLoopbackPort,
        serverInvocation: { command: process.execPath, args: [fake.scriptPath] },
      });
      pid = descriptor.pid;

      expect(descriptor.daemonId).toBeTruthy();
      expect(processIsAlive(descriptor.pid)).toBe(true);
      await expect(
        NodeFSP.readFile(deriveLocalDaemonPaths(root).runtimeStatePath, "utf8"),
      ).resolves.toContain(descriptor.daemonId);
    } finally {
      if (pid !== undefined) process.kill(pid, "SIGKILL");
    }
  });

  it("fails within the startup deadline and cleans up when the runtime marker never appears", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-missing-marker-"));
    const fake = await writeFakeDaemon(root, null);
    try {
      await expect(
        startLocalDaemon({
          baseDir: root,
          timeoutMs: 2_000,
          requestTimeoutMs: 100,
          reservePort: reserveLoopbackPort,
          serverInvocation: { command: process.execPath, args: [fake.scriptPath] },
        }),
      ).rejects.toMatchObject({ code: "daemon-start-timeout" });

      const pid = Number(await NodeFSP.readFile(fake.pidPath, "utf8"));
      expect(pid).toBeGreaterThan(0);
      expect(processIsAlive(pid)).toBe(false);
    } finally {
      const pid = Number(await NodeFSP.readFile(fake.pidPath, "utf8").catch(() => "0"));
      if (pid > 0 && processIsAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

describe("local daemon port contract", () => {
  it("refuses to drift to a free port when an explicit daemon port is taken", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-strict-port-"));
    const holder = await listenOnLoopback();
    const previous = process.env.AWEN_DAEMON_PORT;
    process.env.AWEN_DAEMON_PORT = String(holder.port);
    try {
      // A daemon on another port leaves the desktop shell and the web dev proxy
      // dialing a port nothing serves: fail loudly instead.
      await expect(startLocalDaemon({ baseDir: root })).rejects.toMatchObject({
        code: "daemon-port-unavailable",
      });
    } finally {
      if (previous === undefined) delete process.env.AWEN_DAEMON_PORT;
      else process.env.AWEN_DAEMON_PORT = previous;
      await holder.close();
    }
  });

  // A start that cannot honour the required port must fail without taking the
  // daemon that is running on another port with it. Reconciliation stops that
  // daemon before reserving the replacement port, so the port is validated first;
  // otherwise a foreign process holding 13773 left the developer with no daemon at
  // all instead of a working one plus a clear error.
  it("leaves the running daemon alone when the required port is unavailable", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-keep-old-"));
    const running = await spawnIdleProcess();
    const pid = running.pid;
    if (pid === undefined) throw new Error("idle holder did not expose a pid");
    const server = await listenForHandshake(() => ({
      status: 200,
      body: {
        protocolVersion: LOCAL_DAEMON_PROTOCOL_VERSION,
        owner: "awen-local-daemon",
        daemonId: "running-daemon",
        pid,
        managed: true,
      },
    }));
    const taken = await listenOnLoopback();
    const previousPort = process.env.AWEN_DAEMON_PORT;
    process.env.AWEN_DAEMON_PORT = String(taken.port);
    try {
      const paths = await writeDiscovery(
        root,
        makeLocalDaemonDiscovery({
          daemonId: "running-daemon",
          pid,
          origin: server.origin,
          startedAt: "2026-09-18T00:00:00.000Z",
          workingDirectory: "/running",
        }),
      );
      await NodeFSP.mkdir(NodePath.dirname(paths.credentialPath), { recursive: true });
      await NodeFSP.writeFile(paths.credentialPath, "bootstrap-token\n", { mode: 0o600 });

      await expect(startLocalDaemon({ baseDir: root })).rejects.toMatchObject({
        code: "daemon-port-unavailable",
      });

      expect(processIsAlive(pid)).toBe(true);
      await expect(NodeFSP.readFile(paths.runtimeStatePath, "utf8")).resolves.toContain(
        "running-daemon",
      );
    } finally {
      if (previousPort === undefined) delete process.env.AWEN_DAEMON_PORT;
      else process.env.AWEN_DAEMON_PORT = previousPort;
      running.kill("SIGKILL");
      await server.close();
      await taken.close();
    }
  });

  // The reconciliation path used to nest `stopLocalDaemon` inside a held launch
  // lock. The lock record names the holding pid — here, our own — so the nested
  // acquisition could never break it and only ended in `launch-lock-timeout`
  // after LOCK_TIMEOUT_MS, leaving the outdated daemon running, its descriptor in
  // place, and the proxy pointing at a port nothing served.
  it("stops a daemon on another port instead of deadlocking on its own launch lock", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-reconcile-"));
    const outdated = await spawnIdleProcess();
    const pid = outdated.pid;
    if (pid === undefined) throw new Error("idle holder did not expose a pid");
    const server = await listenForHandshake(() => ({
      status: 200,
      body: {
        protocolVersion: LOCAL_DAEMON_PROTOCOL_VERSION,
        owner: "awen-local-daemon",
        daemonId: "outdated-daemon",
        pid,
        managed: true,
      },
    }));
    const previousPort = process.env.AWEN_PORT;
    // Any port other than the recorded daemon's own moves the launcher onto the
    // reconciliation path.
    process.env.AWEN_PORT = String(Number(new URL(server.origin).port) + 1);
    try {
      const paths = await writeDiscovery(
        root,
        makeLocalDaemonDiscovery({
          daemonId: "outdated-daemon",
          pid,
          origin: server.origin,
          startedAt: "2026-09-18T00:00:00.000Z",
          workingDirectory: "/outdated",
        }),
      );
      // A launcher start verifies the recorded daemon's credential before it
      // reconciles, so the fake daemon needs one on disk.
      await NodeFSP.mkdir(NodePath.dirname(paths.credentialPath), { recursive: true });
      await NodeFSP.writeFile(paths.credentialPath, "bootstrap-token\n", { mode: 0o600 });

      // The injected reserve step replaces spawning the replacement daemon:
      // reaching it at all proves the launcher got past the stop without spinning
      // on the launch lock it already holds.
      const reserved = new Error("reservePort reached");
      const failure: unknown = await startLocalDaemon({
        baseDir: root,
        requestTimeoutMs: 250,
        reservePort: () => Promise.reject(reserved),
      }).catch((cause: unknown) => cause);

      expect(failure).toBe(reserved);
      expect(processIsAlive(pid)).toBe(false);
      await expect(
        NodeFSP.readFile(deriveLocalDaemonPaths(root).runtimeStatePath, "utf8"),
      ).rejects.toThrowError(/ENOENT/);
    } finally {
      if (previousPort === undefined) delete process.env.AWEN_PORT;
      else process.env.AWEN_PORT = previousPort;
      outdated.kill("SIGKILL");
      await server.close();
    }
  });
});

describe("local daemon descriptor reconciliation", () => {
  // A web-mode dev server writes `server-runtime.json` without `daemonManaged`.
  // Once its process is gone the port is bindable, which is the launcher's proof
  // the record is replaceable: it must start a managed daemon rather than refuse
  // on the unusable record (issue #129).
  it("replaces a non-managed record whose process is gone and starts a managed daemon", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-nonmanaged-dead-"));
    const fake = await writeFakeDaemon(root, 0);
    const freePort = await reserveLoopbackPort();
    const paths = await writeDiscovery(root, {
      version: 1,
      pid: 2_147_483_647,
      origin: `http://127.0.0.1:${String(freePort)}`,
      startedAt: "2026-09-18T00:00:00.000Z",
    });
    let pid: number | undefined;
    try {
      const descriptor = await startLocalDaemon({
        baseDir: root,
        timeoutMs: 5_000,
        requestTimeoutMs: 250,
        reservePort: () => Promise.resolve(freePort),
        serverInvocation: { command: process.execPath, args: [fake.scriptPath] },
      });
      pid = descriptor.pid;

      expect(descriptor.daemonId).toBeTruthy();
      const contents = await NodeFSP.readFile(paths.runtimeStatePath, "utf8");
      expect(contents).toContain('"daemonManaged":true');
      expect(contents).toContain(descriptor.daemonId);
      expect(contents).not.toContain("2147483647");
    } finally {
      if (pid !== undefined) process.kill(pid, "SIGKILL");
    }
  });

  // The loud same-checkout conflict: `pnpm dev` still holds the port, so the
  // record cannot be replaced and a second process would share one data root.
  it("refuses a live non-managed process on the recorded port", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-nonmanaged-live-"));
    const holder = await listenOnLoopback();
    const previous = process.env.AWEN_DAEMON_PORT;
    process.env.AWEN_DAEMON_PORT = String(holder.port);
    try {
      const paths = await writeDiscovery(root, {
        version: 1,
        pid: process.pid,
        origin: `http://127.0.0.1:${String(holder.port)}`,
        startedAt: "2026-09-18T00:00:00.000Z",
      });

      await expect(
        startLocalDaemon({ baseDir: root, requestTimeoutMs: 100 }),
      ).rejects.toMatchObject({ code: "daemon-port-occupied" });

      // Refusing must leave the other process and its record untouched.
      await expect(NodeFSP.readFile(paths.runtimeStatePath, "utf8")).resolves.toContain(
        String(holder.port),
      );
    } finally {
      if (previous === undefined) delete process.env.AWEN_DAEMON_PORT;
      else process.env.AWEN_DAEMON_PORT = previous;
      await holder.close();
    }
  });

  // A managed daemon whose process is alive but no longer answers, with the port
  // free: start the replacement (acceptance 5). The unreachable process is NOT
  // signalled — pid liveness alone is not proof we started the current holder.
  it("starts a replacement for an unreachable managed record when its port is free", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-unreachable-"));
    const fake = await writeFakeDaemon(root, 0);
    const hung = await spawnIdleProcess();
    const hungPid = hung.pid;
    if (hungPid === undefined) throw new Error("idle holder did not expose a pid");
    const freePort = await reserveLoopbackPort();
    const paths = await writeDiscovery(
      root,
      makeLocalDaemonDiscovery({
        daemonId: "hung-daemon",
        pid: hungPid,
        origin: `http://127.0.0.1:${String(freePort)}`,
        startedAt: "2026-09-18T00:00:00.000Z",
        workingDirectory: "/hung",
      }),
    );
    let pid: number | undefined;
    try {
      const descriptor = await startLocalDaemon({
        baseDir: root,
        timeoutMs: 5_000,
        requestTimeoutMs: 100,
        reservePort: () => Promise.resolve(freePort),
        serverInvocation: { command: process.execPath, args: [fake.scriptPath] },
      });
      pid = descriptor.pid;

      await expect(NodeFSP.readFile(paths.runtimeStatePath, "utf8")).resolves.toContain(
        descriptor.daemonId,
      );
    } finally {
      if (pid !== undefined) process.kill(pid, "SIGKILL");
      if (processIsAlive(hungPid)) hung.kill("SIGKILL");
    }
  });

  // A managed record pointing at a port a different process now holds: refuse
  // with a conflict that names the port, and leave the other process alone.
  it("refuses when a non-managed process holds a managed record's port", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join("/tmp", "awen-daemon-unreachable-held-"));
    const holder = await listenOnLoopback();
    const hung = await spawnIdleProcess();
    const hungPid = hung.pid;
    if (hungPid === undefined) throw new Error("idle holder did not expose a pid");
    try {
      await writeDiscovery(
        root,
        makeLocalDaemonDiscovery({
          daemonId: "unreachable-daemon",
          pid: hungPid,
          origin: `http://127.0.0.1:${String(holder.port)}`,
          startedAt: "2026-09-18T00:00:00.000Z",
          workingDirectory: "/unreachable",
        }),
      );

      await expect(
        startLocalDaemon({ baseDir: root, requestTimeoutMs: 100 }),
      ).rejects.toMatchObject({ code: "daemon-port-occupied" });
      expect(processIsAlive(hungPid)).toBe(true);
    } finally {
      if (processIsAlive(hungPid)) hung.kill("SIGKILL");
      await holder.close();
    }
  });
});
