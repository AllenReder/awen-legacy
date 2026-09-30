import type { MouseEvent, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarTitlebarButtonProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly shortcut?: string;
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Fires when the pointer first rests on the control; used to prefetch its destination. */
  readonly onPointerEnter?: () => void;
  /** Fires when the control takes focus; used to prefetch its destination. */
  readonly onFocus?: () => void;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly ariaPressed?: boolean;
  readonly testId?: string;
  readonly tooltipSide?: "bottom" | "top";
}

/**
 * Standard titlebar control button matching macOS styling:
 * 28x28px, rounded corners, subtle hover, active 0.98 scale, no-drag.
 */
export function SidebarTitlebarButton({
  icon,
  label,
  shortcut,
  onClick,
  onPointerEnter,
  onFocus,
  className,
  ariaLabel,
  ariaPressed,
  testId,
  tooltipSide = "bottom",
}: SidebarTitlebarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel ?? label}
            aria-pressed={ariaPressed}
            data-testid={testId}
            onClick={onClick}
            onPointerEnter={onPointerEnter}
            onFocus={onFocus}
            className={cn(
              "flex size-[var(--workspace-titlebar-control-size)] shrink-0 items-center justify-center rounded-[var(--control-radius)] text-muted-foreground transition-all [transition-duration:calc(150ms*var(--motion-duration-scale,1))] ease-out hover:bg-sidebar-row-hover hover:text-foreground active:scale-[0.98] active:bg-sidebar-row-active [-webkit-app-region:no-drag]",
              className,
            )}
          >
            {icon}
          </button>
        }
      />
      <TooltipPopup side={tooltipSide} className="flex items-center gap-1.5">
        <span>{label}</span>
        {shortcut ? <span className="font-mono text-[10px] opacity-60">{shortcut}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
}
