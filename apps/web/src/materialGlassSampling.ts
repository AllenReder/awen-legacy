let nextAnchor = 0;

/**
 * Chromium blends a filtered translucent backdrop over its unfiltered source.
 * Give only the popup's sampling area an opaque base below application content;
 * the rest of the native window remains translucent. CSS anchors track geometry.
 */
export function attachGlassSamplingUnderlay(surface: HTMLElement): () => void {
  if (typeof CSS === "undefined" || !CSS.supports("anchor-name", "--awen-glass")) {
    return () => {};
  }
  const root = document.documentElement;
  const frame = surface.parentElement ?? surface;
  const anchor = `--awen-glass-${++nextAnchor}`;
  const previousAnchor = frame.style.getPropertyValue("anchor-name");
  frame.style.setProperty("anchor-name", previousAnchor ? `${previousAnchor}, ${anchor}` : anchor);
  const underlay = document.createElement("div");
  underlay.dataset.glassSamplingUnderlay = "";
  underlay.setAttribute("aria-hidden", "true");
  underlay.style.cssText = `position:fixed;position-anchor:${anchor};left:anchor(left);top:anchor(top);width:anchor-size(width);height:anchor-size(height);z-index:-1;pointer-events:none;background:var(--background);`;
  let animationFrame: number | null = null;
  const syncAppearance = () => {
    const style = getComputedStyle(surface);
    underlay.style.borderRadius = style.borderRadius;
    underlay.style.clipPath = style.clipPath;
    underlay.style.opacity = style.opacity;
    underlay.style.scale = style.scale;
    underlay.style.transformOrigin = style.transformOrigin;
  };
  syncAppearance();
  document.body.appendChild(underlay);

  const transparency = window.matchMedia("(prefers-reduced-transparency: reduce)");
  const sync = () => {
    syncAppearance();
    underlay.hidden =
      !root.classList.contains("material-stage-native") ||
      transparency.matches ||
      !surface.isConnected ||
      surface.getClientRects().length === 0 ||
      Number.parseFloat(getComputedStyle(root).getPropertyValue("--glass-blur")) <= 0;
  };
  sync();
  // The native sampling base must not flash in before the visible material.
  // Mirror only the short material transition; do not measure the pane layout.
  const animate = () => {
    if (animationFrame !== null) return;
    const tick = () => {
      animationFrame = null;
      syncAppearance();
      if (
        surface
          .getAnimations()
          .some((animation) => animation.playState === "running" || animation.pending)
      )
        animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
  };
  surface.addEventListener("transitionrun", animate);
  surface.addEventListener("transitionend", syncAppearance);
  surface.addEventListener("transitioncancel", syncAppearance);
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
  observer.observe(surface, { attributes: true, attributeFilter: ["class", "style"] });
  if (surface.parentElement)
    observer.observe(surface.parentElement, {
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "data-open",
        "data-closed",
        "data-with-context",
      ],
    });
  const resize = new ResizeObserver(sync);
  resize.observe(surface);
  transparency.addEventListener("change", sync);
  return () => {
    observer.disconnect();
    resize.disconnect();
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    surface.removeEventListener("transitionrun", animate);
    surface.removeEventListener("transitionend", syncAppearance);
    surface.removeEventListener("transitioncancel", syncAppearance);
    transparency.removeEventListener("change", sync);
    underlay.remove();
    if (previousAnchor) frame.style.setProperty("anchor-name", previousAnchor);
    else frame.style.removeProperty("anchor-name");
  };
}
