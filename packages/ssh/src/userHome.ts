import { HostProcessEnvironment, HostProcessPlatform } from "@awen/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";

type UserInfoHome = Pick<NodeOS.UserInfo<string>, "homedir">;

/**
 * Resolve the user home directory with the same precedence as the SSH client:
 * `USERPROFILE` on Windows, `HOME` elsewhere, then the account's OS home.
 */
export function resolveUserHome(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  userInfo: () => UserInfoHome = NodeOS.userInfo,
): string {
  if (platform === "win32") {
    return environment.USERPROFILE || userInfo().homedir;
  }
  return environment.HOME || userInfo().homedir;
}

export const resolveSshUserHome = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  return resolveUserHome(platform, environment);
});
