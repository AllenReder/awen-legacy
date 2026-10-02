import type { ComponentProps } from "react";

import { GlassBackdrop } from "~/components/ui/GlassBackdrop";
import { cn } from "~/lib/utils";

/** One local frosted backdrop shared by the composer and its attached controls. */
function Shell({
  contextStrip = false,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { contextStrip?: boolean }) {
  return (
    <div
      data-slot="composer-shell"
      data-with-context={contextStrip || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-3xl",
        "rounded-[22px] [--chat-composer-drawer-inset:1.375rem] [--chat-composer-outline:var(--control-border)]",
        contextStrip &&
          "[--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem]",
        className,
      )}
      {...props}
    >
      <GlassBackdrop
        className={cn(
          // An attached banner carries its own glass; hide the shell-wide backdrop so
          // the material does not spill into the insets beside the narrower banner.
          "group-has-data-[composer-banner-surface=attached]/composer-surface:hidden",
          contextStrip && [
            // Keep one continuous material around the composer and its inset controls.
            "supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:rounded-none",
            "[clip-path:shape(from_0_22px,curve_to_22px_0_with_0_9.85px/9.85px_0,line_to_calc(100%-22px)_0,curve_to_100%_22px_with_calc(100%-9.85px)_0/100%_9.85px,line_to_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)),curve_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-var(--chat-composer-context-extension))_with_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477)/calc(100%-var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension)),line_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-16px),curve_to_calc(100%-var(--chat-composer-drawer-inset)-16px)_100%_with_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-7.16px)/calc(100%-var(--chat-composer-drawer-inset)-7.16px)_100%,line_to_calc(var(--chat-composer-drawer-inset)+16px)_100%,curve_to_var(--chat-composer-drawer-inset)_calc(100%-16px)_with_calc(var(--chat-composer-drawer-inset)+7.16px)_100%/var(--chat-composer-drawer-inset)_calc(100%-7.16px),line_to_var(--chat-composer-drawer-inset)_calc(100%-var(--chat-composer-context-extension)),curve_to_0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset))_with_calc(var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension))/0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477),line_to_0_22px,close)]",
          ],
        )}
      />
      {children}
    </div>
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline)";

// The bottom strip continues the outline, so leave the seam between its corners open.
const contextSeamClasses =
  "group-data-with-context/composer-surface:after:[clip-path:polygon(0_0,100%_0,100%_100%,calc(100%-22px)_100%,calc(100%-22px)_calc(100%-2px),22px_calc(100%-2px),22px_100%,0_100%)]";

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-[22px] shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] after:z-1 dark:shadow-none",
        outlineClasses,
        contextSeamClasses,
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Main({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "group relative z-10 rounded-[22px] p-px transition-colors [transition-duration:calc(200ms*var(--motion-duration-scale,1))]",
        outlineClasses,
        contextSeamClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    >
      {/* The shell-wide backdrop hides once a banner attaches, so the composer
          carries the material itself for the attached state. */}
      <GlassBackdrop className="hidden -z-1 group-has-data-[composer-banner-surface=attached]/composer-surface:block" />
      {children}
    </div>
  );
}

function ContextStrip({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative isolate mx-auto -mt-4 flex w-[calc(100%-2*var(--chat-composer-drawer-inset))] items-center gap-2 overflow-x-clip overflow-y-visible ps-1 pe-2 pt-5 pb-1",
        "before:absolute before:inset-0 before:-z-1 before:rounded-b-[16px] before:border before:border-(--chat-composer-outline) before:mask-[linear-gradient(to_bottom,transparent_0_1rem,black_1rem)] before:shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)]",
        className,
      )}
      {...props}
    >
      {/* The shell-wide backdrop hides once a banner attaches, so the strip keeps
          its own glass below the composer. */}
      <GlassBackdrop className="hidden -z-2 rounded-none rounded-b-[16px] mask-[linear-gradient(to_bottom,transparent_0_1rem,black_1rem)] group-has-data-[composer-banner-surface=attached]/composer-surface:block" />
      {children}
    </div>
  );
}

export const ComposerSurface = { Shell, Host, Main, ContextStrip };
