import type { EDITORS } from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as HostProcess from "./hostProcess.ts";
import { isCommandAvailable } from "./shell.ts";

type Editor = (typeof EDITORS)[number];

const installNames: Partial<Record<Editor["id"], ReadonlyArray<string>>> = {
  vscode: ["Visual Studio Code"],
  "vscode-insiders": ["Visual Studio Code - Insiders"],
  antigravity: ["Antigravity IDE"],
  idea: ["IntelliJ IDEA", "IntelliJ IDEA CE", "IntelliJ IDEA Ultimate"],
  pycharm: ["PyCharm", "PyCharm CE"],
  rider: ["Rider", "JetBrains Rider"],
};

export const resolveEditorCommand = Effect.fn("editor.resolveEditorCommand")(function* (
  editor: Editor,
  env: NodeJS.ProcessEnv,
) {
  if (editor.commands === null) return Option.none();
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  for (const command of editor.commands) {
    if (yield* isCommandAvailable(command, { env })) return Option.some({ command, baseArgs });
  }

  const platform = yield* HostProcess.HostProcessPlatform;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = env.HOME;
  const names = installNames[editor.id] ?? [editor.label];
  const command = editor.commands[0];
  const jetbrains = editor.launchStyle === "line-column";
  const candidates: string[] = [];

  if (platform === "darwin") {
    const roots = [...(home ? [path.join(home, "Applications")] : []), "/Applications"];
    for (const root of roots) {
      for (const name of names) {
        const contents = path.join(root, `${name}.app`, "Contents");
        candidates.push(
          ...(jetbrains || editor.id === "zed"
            ? [path.join(contents, "MacOS", editor.id === "zed" ? "cli" : command)]
            : [
                path.join(contents, "Resources/app/bin", command),
                path.join(contents, "Resources/app/bin/code"),
              ]),
        );
      }
    }
    if (home && jetbrains) {
      candidates.push(
        path.join(home, "Library/Application Support/JetBrains/Toolbox/scripts", command),
      );
    }
  } else if (platform === "win32") {
    const roots = [
      ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Programs")] : []),
      ...[env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter(
        (root): root is string => !!root,
      ),
    ];
    if (jetbrains) {
      if (env.LOCALAPPDATA) {
        candidates.push(path.join(env.LOCALAPPDATA, "JetBrains/Toolbox/scripts", `${command}.cmd`));
      }
    }
    for (const root of roots) {
      for (const name of names) {
        candidates.push(
          path.join(root, name, "bin", `${command}.cmd`),
          path.join(root, name, "bin", `${command}.bat`),
          path.join(root, name, "bin", `${command}.exe`),
        );
      }
    }
  }

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) return Option.some({ command: candidate, baseArgs });
  }

  return Option.none();
});
