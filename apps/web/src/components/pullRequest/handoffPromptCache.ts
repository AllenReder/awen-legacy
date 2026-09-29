import { LRUCache } from "~/lib/lruCache";

/**
 * What the last hand-off wrote into each draft, kept outside React because the panel that wrote
 * it is closed by the time the next one opens. It is how a prompt the reader has since edited is
 * told apart from the one they were handed: only the sentence still exactly as written may be
 * replaced.
 *
 * A remembered prompt is a whole generated hand-off and drafts outlive the panel, so the store is
 * bounded by the number of drafts it remembers; the drafts least recently handed off take their
 * prompts with them instead of the map growing for the life of the process. A prompt whose draft
 * ages out is treated as the reader's own text by the next hand-off — it appends rather than
 * replaces — which is the direction that never deletes words the reader wrote, and the cap is set
 * well above the drafts one reader hands off to in a sitting.
 */
const MAX_HANDOFF_PROMPTS = 64;
// Backstop for the pathological case; the entry count is the bound that matters in practice.
const MAX_HANDOFF_PROMPT_BYTES = 32 * 1024 * 1024;

/**
 * Creates the store the pull request panel keeps its hand-off prompts in.
 * `createHandoffPromptCache` is exported as a factory so the bound can be exercised directly;
 * the panel owns the one instance.
 */
export function createHandoffPromptCache() {
  const entries = new LRUCache<string>(MAX_HANDOFF_PROMPTS, MAX_HANDOFF_PROMPT_BYTES);
  return {
    get: (target: string): string | undefined => entries.get(target) ?? undefined,
    remember: (target: string, prompt: string): void => {
      // Two bytes per UTF-16 code unit: cheap, and the budget only has to be the right order of
      // magnitude to bound what a pile of long prompts can hold on to.
      entries.set(target, prompt, prompt.length * 2);
    },
  };
}
