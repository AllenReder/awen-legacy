import { invoke } from "@tauri-apps/api/core";

const logNode = document.querySelector<HTMLElement>("#log");
const page = new URLSearchParams(window.location.search).get("guestPage");
if (!page) throw new Error("The browser proof requires a guestPage from the native runner");

function log(label: string, value: unknown): void {
  if (logNode) logNode.textContent += `${label}: ${JSON.stringify(value)}\n`;
}

async function evaluate(tab: "a" | "b", script: string): Promise<unknown> {
  return invoke("evaluate", { tab, script });
}

async function ready(tab: "a" | "b", expectedUrl = page): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const state = await evaluate(tab, "({ ready: document.readyState, url: location.href })");
      if (
        typeof state === "object" &&
        state !== null &&
        "ready" in state &&
        state.ready === "complete" &&
        "url" in state &&
        state.url === expectedUrl
      )
        return;
    } catch {
      // A newly attached guest can reject evaluation until its first load.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Page ${tab} did not finish loading`);
}

async function run(): Promise<void> {
  if (logNode) logNode.textContent = "";
  await invoke("open", { tab: "a" });
  await invoke("open", { tab: "b" });
  await Promise.all([ready("a"), ready("b")]);
  log("two pages", {
    a: await evaluate("a", "document.title"),
    b: await evaluate("b", "document.title"),
  });

  const navigatedUrl = `${page}?navigated=1`;
  await invoke("navigate", { tab: "a", url: navigatedUrl });
  await ready("a", navigatedUrl);
  log("navigation", await evaluate("a", "location.href"));

  // This is the same guest a person can see and click. Keep the changed field
  // and count visible after navigation for the manual same-page check. The
  // command stands in for a routed preview request from the daemon.
  await evaluate("a", "document.querySelector('#message').value = 'agent typed here'; true");
  await evaluate("a", "document.querySelector('#increment').click(); true");
  log(
    "same-page snapshot",
    await evaluate(
      "a",
      "({ message: document.querySelector('#message').value, clicks: document.querySelector('#count').textContent })",
    ),
  );

  const geometry = await invoke("geometry", {
    tab: "a",
    x: 390,
    y: 120,
    width: 390,
    height: 440,
    zoom: 1.25,
  });
  log("geometry and focus", geometry);
  log(
    "rendered viewport",
    await evaluate(
      "a",
      "({ width: innerWidth, height: innerHeight, focused: document.hasFocus() })",
    ),
  );

  await evaluate("a", "localStorage.setItem('awen-browser-proof', 'profile-a'); true");
  log("profile A", await evaluate("a", "localStorage.getItem('awen-browser-proof')"));
  log("profile B", await evaluate("b", "localStorage.getItem('awen-browser-proof')"));
  log("close", "Cancel the confirmation dialog, check page A, then confirm closure.");
}

document.querySelector("#run")?.addEventListener("click", () => {
  void run().catch((error: unknown) => log("error", String(error)));
});
document.querySelector("#cancel")?.addEventListener("click", () => {
  // A production browser Pane asks for confirmation before releasing a page
  // under Agent control. Cancellation deliberately leaves the native guest.
  void evaluate("a", "({ url: location.href, live: true })")
    .then((result) => log("cancelled, page remains", result))
    .catch((error: unknown) => log("error", String(error)));
});
document.querySelector("#close")?.addEventListener("click", () => {
  if (!window.confirm("Close page A while Agent control is active?")) {
    log("close cancelled", true);
    return;
  }
  void invoke("close", { tab: "a" })
    .then(async () => {
      try {
        await evaluate("a", "location.href");
        log("close error", "Page still accepts control");
      } catch (error) {
        log("closed page result", String(error));
      }
    })
    .catch((error: unknown) => log("error", String(error)));
});
document.querySelector("#reopen")?.addEventListener("click", () => {
  void invoke("open", { tab: "a" })
    .then(() => log("reopened", "a"))
    .catch((error: unknown) => log("error", String(error)));
});
