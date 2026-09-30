import { useEffect, useState, type ReactElement } from "react";

import { isElectron } from "../../env";
import { cn, usesCustomWindowChrome } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  defaultWindowOperations,
  isDesktopEnvironment,
  type WindowBridgeOperations,
} from "../../lib/windowControls";

export interface WindowControlsProps {
  readonly className?: string;
  readonly forceVisible?: boolean;
  readonly operations?: WindowBridgeOperations;
}

function WindowControlTooltip({
  children,
  label,
}: {
  readonly children: ReactElement;
  readonly label: string;
}) {
  if (typeof window === "undefined") return children;
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function WindowControls({
  className,
  forceVisible = false,
  operations = defaultWindowOperations,
}: WindowControlsProps) {
  const isCustomChromePlatform =
    typeof navigator !== "undefined" && usesCustomWindowChrome(navigator.platform);
  const shouldRender =
    forceVisible || (!isElectron && isDesktopEnvironment() && isCustomChromePlatform);

  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!shouldRender) return;
    let active = true;

    const syncState = () => {
      void operations.isMaximized().then((maximized) => {
        if (active) setIsMaximized(maximized);
      });
      void operations.isFullscreen().then((fullscreen) => {
        if (active) setIsFullscreen(fullscreen);
      });
    };

    syncState();
    const unsubscribe = operations.onResized?.(syncState);

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [operations, shouldRender]);

  if (!shouldRender || isFullscreen) {
    return null;
  }

  return (
    <div
      className={cn("flex h-full shrink-0 items-stretch [-webkit-app-region:no-drag]", className)}
      data-slot="window-controls"
    >
      <WindowControlTooltip label="Minimize">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => void operations.minimize()}
          className="flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15 select-none focus:outline-none [-webkit-app-region:no-drag]"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="size-2.5">
            <path fill="currentColor" d="M0 5h10v1H0z" />
          </svg>
        </button>
      </WindowControlTooltip>

      <WindowControlTooltip label={isMaximized ? "Restore" : "Maximize"}>
        <button
          type="button"
          aria-label={isMaximized ? "Restore" : "Maximize"}
          onClick={() => {
            setIsMaximized((prev) => !prev);
            void operations.toggleMaximize().then(() => {
              void operations.isMaximized().then((maximized) => {
                setIsMaximized(maximized);
              });
            });
          }}
          className="flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15 select-none focus:outline-none [-webkit-app-region:no-drag]"
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" className="size-2.5">
              <path fill="none" stroke="currentColor" strokeWidth="1" d="M2.5 2.5V0.5h7v7H7.5" />
              <rect
                width="7"
                height="7"
                x="0.5"
                y="2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" className="size-2.5">
              <rect
                width="9"
                height="9"
                x="0.5"
                y="0.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </button>
      </WindowControlTooltip>

      <WindowControlTooltip label="Close">
        <button
          type="button"
          aria-label="Close"
          onClick={() => void operations.close()}
          className="flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-[var(--window-control-close-hover,#e81123)] hover:text-white active:bg-[var(--window-control-close-active,#c4101f)] active:text-white select-none focus:outline-none [-webkit-app-region:no-drag]"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="size-2.5">
            <path stroke="currentColor" strokeWidth="1" d="M1 1l8 8m0-8L1 9" />
          </svg>
        </button>
      </WindowControlTooltip>
    </div>
  );
}
