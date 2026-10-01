// The renderer cannot supply a URL: all operations below address the owned
// local daemon, which retains SSH trust, provisioning and tunnel ownership.
import * as Data from "effect/Data";
import { ConnectionFailureCodeSchema } from "@awen/contracts";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const isConnectionFailureCode = Schema.is(ConnectionFailureCodeSchema);

export class DaemonSshRequestError extends Data.TaggedError("DaemonSshRequestError")<{
  readonly message: string;
}> {}

const paths = {
  hosts: "hosts",
  resolve: "hosts/resolve",
  trust: "trust",
  plan: "plan",
  accept: "trust/accept",
  ensure: "ensure",
  progress: "progress",
  cancel: "cancel",
  disconnect: "disconnect",
  descriptor: "descriptor",
  bootstrap: "bearer/bootstrap",
  session: "bearer/session",
  ticket: "bearer/ws-ticket",
  prompts: "password-prompts",
  resolvePrompt: "password-prompts/resolve",
} as const;

export const request = DesktopIpc.makeIpcMethod({
  channel: "desktop:daemon-ssh",
  payload: Schema.Struct({
    operation: Schema.Literals(
      Object.keys(paths) as [keyof typeof paths, ...(keyof typeof paths)[]],
    ),
    body: Schema.optionalKey(Schema.Unknown),
  }),
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.daemonSsh.request")(function* ({ operation, body }) {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    const primary = yield* pool.primary;
    const config = yield* primary.currentConfig;
    if (Option.isNone(config))
      return yield* Effect.fail(
        new DaemonSshRequestError({ message: "Local daemon is not configured." }),
      );
    const token = yield* auth.getBearerToken;
    const client = yield* HttpClient.HttpClient;
    const url = new URL(`/api/desktop/ssh/${paths[operation]}`, config.value.httpBaseUrl).href;
    let request =
      operation === "hosts" || operation === "prompts"
        ? HttpClientRequest.get(url)
        : HttpClientRequest.post(url);
    request = HttpClientRequest.setHeader(request, "authorization", `Bearer ${token}`);
    if (body !== undefined) request = yield* HttpClientRequest.bodyJson(request, body);
    const response = yield* client.execute(request);
    const result = response.status === 204 ? undefined : yield* response.json;
    if (response.status < 200 || response.status >= 300) {
      const failure =
        typeof result === "object" && result !== null && "error" in result ? result.error : result;
      const message =
        typeof failure === "object" && failure !== null && "message" in failure
          ? String(failure.message)
          : "SSH daemon request failed.";
      const code =
        typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        isConnectionFailureCode(failure.code)
          ? failure.code
          : "unknown";
      return yield* new DaemonSshRequestError({
        message: `[awen-ssh-error:${code}:${response.status}] ${message}`,
      });
    }
    return result;
  }),
});
