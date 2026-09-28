import { createMotionValue } from "./motionValue";
import { getAnimationDurationScale, skipAutomaticWorkbenchMotion } from "./workbenchMotion";

/** Pointer progress required to commit a Sliding Tab switch on release. */
export const TAB_SWITCH_COMMIT_PROGRESS = 0.5;
/** Release velocity (px/ms) that commits a Sliding Tab switch regardless of progress. */
export const TAB_SWITCH_FLICK_VELOCITY = 0.35;

export interface TabTransitionState {
  readonly fromTabId: string;
  readonly toTabId: string;
  readonly fromIndex: number;
  readonly toIndex: number;
  /** +1 when the target Tab sits to the right of the source Tab, -1 otherwise. */
  readonly dir: -1 | 1;
}

export interface TabTransitionFrame extends TabTransitionState {
  readonly progress: number;
  readonly position: number;
  readonly destinationSlot: number;
  readonly cards: ReadonlyArray<{ readonly tabId: string; readonly slot: number }>;
}

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Horizontal offset of a card, in viewport widths. `slot` is the card's resting
 * slot relative to the incoming card (0 for the target, -dir for the source);
 * the strip translates by `dir` until the target reaches the viewport.
 */
export function computeCardOffset(slot: number, dir: -1 | 1, progress: number): number {
  return slot + dir * (1 - clampProgress(progress));
}

export function deriveTabDirection(fromIndex: number, toIndex: number): -1 | 1 | 0 {
  if (fromIndex === toIndex) return 0;
  return toIndex > fromIndex ? 1 : -1;
}

export function nextTabIndex(count: number, currentIndex: number, dir: -1 | 1): number {
  if (count <= 0) return -1;
  return (currentIndex + dir + count) % count;
}

export interface TabIndicatorGeometry {
  readonly left: number;
  readonly width: number;
}

export interface SwitchCommitInput {
  readonly progress: number;
  /** Signed pointer velocity in px/ms: positive means the pointer moved right. */
  readonly velocity: number;
  readonly dir: -1 | 1;
}

export function resolveSwitchCommit(input: SwitchCommitInput): boolean {
  if (clampProgress(input.progress) >= TAB_SWITCH_COMMIT_PROGRESS) return true;
  // dir +1 ("next") is dragged toward the left, so its matching velocity is negative.
  const directionalVelocity = input.dir === 1 ? -input.velocity : input.velocity;
  return directionalVelocity >= TAB_SWITCH_FLICK_VELOCITY;
}

/** Stable identity for an ordered Tab list; `\u0000` cannot appear in generated ids. */
export function tabIdsKey(tabs: ReadonlyArray<{ readonly id: string }>): string {
  return tabs.map((tab) => tab.id).join("\u0000");
}

let transitionState: TabTransitionState | null = null;
let cards: Array<{ tabId: string; slot: number }> = [];
let destinationSlot = 0;
// Move a cyclic target to the new edge only after both slots are offscreen,
// preserving one live View presentation per Tab.
let pendingRelocation: { tabId: string; slot: number; midpoint: number; dir: -1 | 1 } | null = null;
const motion = createMotionValue(0);
let cancelSettle: (() => void) | null = null;

function stopSettle(): void {
  cancelSettle?.();
  cancelSettle = null;
}
const stateListeners = new Set<(state: TabTransitionState | null) => void>();
const frameListeners = new Set<(frame: TabTransitionFrame | null) => void>();

function currentFrame(): TabTransitionFrame | null {
  if (transitionState === null) return null;
  const from = cards.find((card) => card.tabId === transitionState?.fromTabId)?.slot ?? 0;
  return {
    ...transitionState,
    progress: clampProgress((motion.value - from) / (destinationSlot - from || 1)),
    position: motion.value,
    destinationSlot,
    cards,
  };
}

export function getTabTransition(): TabTransitionState | null {
  return transitionState;
}

export function getTabTransitionFrame(): TabTransitionFrame | null {
  return currentFrame();
}

export function subscribeTabTransition(
  listener: (state: TabTransitionState | null) => void,
): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export function subscribeTabTransitionFrame(
  listener: (frame: TabTransitionFrame | null) => void,
): () => void {
  frameListeners.add(listener);
  return () => {
    frameListeners.delete(listener);
  };
}

function notifyState(): void {
  for (const listener of stateListeners) listener(transitionState);
}

function notifyFrame(): void {
  if (
    pendingRelocation !== null &&
    (pendingRelocation.dir === 1
      ? motion.value >= pendingRelocation.midpoint
      : motion.value <= pendingRelocation.midpoint)
  ) {
    cards = cards.map((card) =>
      card.tabId === pendingRelocation?.tabId
        ? { tabId: card.tabId, slot: pendingRelocation.slot }
        : card,
    );
    pendingRelocation = null;
  }
  const frame = currentFrame();
  for (const listener of frameListeners) listener(frame);
}

export function beginTabTransition(state: TabTransitionState, initialProgress = 0): void {
  stopSettle();
  transitionState = state;
  cards = [
    { tabId: state.fromTabId, slot: 0 },
    { tabId: state.toTabId, slot: state.dir },
  ];
  destinationSlot = state.dir;
  pendingRelocation = null;
  motion.setDirect(state.dir * clampProgress(initialProgress));
  notifyState();
  notifyFrame();
}

/** Redirect the live card strip, preserving its visible position and velocity. */
export function retargetTabTransition(state: TabTransitionState): void {
  if (transitionState === null) {
    beginTabTransition(state);
    return;
  }
  stopSettle();
  const existing = cards.find((card) => card.tabId === state.toTabId);
  if (existing === undefined) {
    const edge =
      state.dir === 1
        ? Math.max(...cards.map((card) => card.slot)) + 1
        : Math.min(...cards.map((card) => card.slot)) - 1;
    cards = [...cards, { tabId: state.toTabId, slot: edge }];
    destinationSlot = edge;
    pendingRelocation = null;
  } else if (state.dir === 1 ? existing.slot <= motion.value : existing.slot >= motion.value) {
    const edge =
      state.dir === 1
        ? Math.max(...cards.map((card) => card.slot)) + 1
        : Math.min(...cards.map((card) => card.slot)) - 1;
    destinationSlot = edge;
    pendingRelocation = {
      tabId: state.toTabId,
      slot: edge,
      midpoint: (existing.slot + edge) / 2,
      dir: state.dir,
    };
  } else {
    destinationSlot = existing.slot;
    pendingRelocation = null;
  }
  transitionState = state;
  notifyState();
  notifyFrame();
}

export function getTabTransitionCards(): ReadonlyArray<{
  readonly tabId: string;
  readonly slot: number;
}> {
  return cards;
}

export function interruptTabSettle(): void {
  stopSettle();
}

export function setTabTransitionPosition(position: number, velocity = 0): void {
  if (transitionState === null) return;
  motion.setDirect(position, velocity);
  notifyFrame();
}

export function setTabTransitionProgress(progress: number): void {
  if (transitionState === null) return;
  const clamped = clampProgress(progress);
  const from = cards.find((card) => card.tabId === transitionState?.fromTabId)?.slot ?? 0;
  motion.setDirect(from + (destinationSlot - from) * clamped);
  notifyFrame();
}

export function endTabTransition(): void {
  stopSettle();
  transitionState = null;
  cards = [];
  destinationSlot = 0;
  pendingRelocation = null;
  motion.setDirect(0);
  notifyState();
  notifyFrame();
}

/** Test seam: drop any in-flight transition and its listeners. */
export function resetTabTransitionForTest(): void {
  stopSettle();
  transitionState = null;
  cards = [];
  destinationSlot = 0;
  pendingRelocation = null;
  motion.setDirect(0);
  stateListeners.clear();
  frameListeners.clear();
}

/**
 * Settle an active transition toward source or target with a damped spring, then
 * clear it. A new input may take over its live position and velocity.
 */
export function animateTabTransitionTo(target: 0 | 1): () => void {
  stopSettle();
  if (transitionState === null) return () => {};
  if (skipAutomaticWorkbenchMotion()) {
    setTabTransitionProgress(target);
    endTabTransition();
    return () => {};
  }
  const targetTab = target === 1 ? transitionState.toTabId : transitionState.fromTabId;
  motion.setFrequency(24 / getAnimationDurationScale());
  const destination =
    target === 1 ? destinationSlot : (cards.find((card) => card.tabId === targetTab)?.slot ?? 0);
  if (Math.abs(destination - motion.value) < 1e-4) {
    motion.setDirect(destination);
    endTabTransition();
    return () => {};
  }
  const unsubscribe = motion.subscribe(() => {
    notifyFrame();
    if (motion.value === destination && transitionState !== null) endTabTransition();
  });
  const cancel = () => {
    unsubscribe();
    motion.stop();
  };
  cancelSettle = cancel;
  motion.setTarget(destination);
  return cancel;
}
