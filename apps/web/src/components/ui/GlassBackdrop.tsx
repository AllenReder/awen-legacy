import { cn } from "../../lib/utils";

/**
 * Frosted glass backdrop for popovers, modals, and dropdown overlays.
 * Kept on a static frame layer so backdrop blur is not re-rasterized during motion.
 */
export function GlassBackdrop({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "material-surface-overlay pointer-events-none absolute inset-0 z-0 rounded-[inherit]",
        className,
      )}
    />
  );
}
