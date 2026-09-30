import { useLayoutEffect, useRef } from "react";
import { attachGlassSamplingUnderlay } from "../../materialGlassSampling";
import { cn } from "../../lib/utils";

/**
 * Frosted glass backdrop for popovers, modals, and dropdown overlays.
 * Animates itself beside the content; its ancestors keep their geometry and
 * opacity stable so backdrop filtering can still sample the application.
 */
export function GlassBackdrop({ className }: { className?: string }) {
  const surface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (surface.current) return attachGlassSamplingUnderlay(surface.current);
  }, []);
  return (
    <div
      ref={surface}
      aria-hidden="true"
      className={cn(
        "overlay-material material-surface-overlay pointer-events-none absolute inset-0 z-0 rounded-[inherit]",
        className,
      )}
    />
  );
}
