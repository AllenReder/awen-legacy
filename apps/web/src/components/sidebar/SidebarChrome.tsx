import { ArrowLeftIcon, SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { useCanGoBack, useLocation, useNavigate, useRouter } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { isMacPlatform } from "../../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { SidebarFooter, SidebarHeader, useSidebar } from "../ui/sidebar";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarTitlebarButton } from "./SidebarTitlebarControl";
import { SidebarUpdateArchitectureWarning } from "./SidebarUpdatePill";

export interface SidebarChromeHeaderProps {
  readonly mode?: "main" | "settings";
}

export const SidebarChromeHeader = memo(function SidebarChromeHeader() {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center bg-transparent p-0"
      data-sidebar-header=""
      style={{
        paddingLeft: "var(--sidebar-trigger-left)",
        paddingRight: "calc(var(--sidebar-action-right-gap) - var(--sidebar-edge-width))",
      }}
    >
      <div
        className="size-[var(--workspace-titlebar-control-size)] shrink-0 pointer-events-none"
        data-slot="sidebar-header-toggle-placeholder"
        data-testid="sidebar-toggle-placeholder"
      />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-2 hidden rounded-full px-1.5 text-muted-foreground @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
      <div className="flex-1 min-w-0 h-full pointer-events-none" />
      <div
        className="size-[var(--workspace-titlebar-control-size)] shrink-0 pointer-events-none"
        data-slot="sidebar-header-action-placeholder"
        data-testid="sidebar-action-placeholder"
      />
    </SidebarHeader>
  );
});

export function SidebarActionControl({
  pathname,
  mode,
}: {
  readonly pathname?: string;
  readonly mode?: "main" | "settings";
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const { open } = useSidebar();
  const isMac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
  const locationPath = useLocation({ select: (location) => location.pathname });
  const currentPath = pathname ?? locationPath;
  const isOnSettings =
    mode === "settings" || currentPath === "/settings" || currentPath.startsWith("/settings/");

  const handleSettingsClick = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  // The Settings subtree is a lazy route chunk (its panel module alone is
  // ~280 kB). `defaultPreload: "intent"` only fires for a <Link>, and this
  // control is a plain button, so the first click otherwise pays the whole
  // fetch+execute and the settings UI paints late (issue #140). Prefetch the
  // concrete page on pointer-enter/focus so the load lands before the click.
  const preloadSettingsRoute = useCallback(() => {
    const preload = router.preloadRoute({ to: "/settings/general" });
    void preload?.catch(() => undefined);
  }, [router]);

  const handleBackClick = useCallback(() => {
    if (canGoBack && typeof window !== "undefined") {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  const dockLeft = "var(--sidebar-collapsed-action-left)";
  const expandedLeft =
    "calc(var(--sidebar-width) - var(--workspace-titlebar-control-size) - var(--sidebar-action-right-gap))";

  return (
    <div
      className="pointer-events-none fixed top-0 z-50 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]"
      data-sidebar-action-control=""
      style={{
        left: `var(--sidebar-motion-action-left, ${open ? expandedLeft : dockLeft})`,
      }}
    >
      {isOnSettings ? (
        <SidebarTitlebarButton
          icon={<ArrowLeftIcon className="size-4" />}
          label="Back to workspace"
          shortcut={isMac ? "⌘, / Esc" : "Ctrl+, / Esc"}
          onClick={handleBackClick}
          className="pointer-events-auto"
          testId="sidebar-back-button"
        />
      ) : (
        <SidebarTitlebarButton
          icon={<SettingsIcon className="size-4" />}
          label="Settings"
          shortcut={isMac ? "⌘," : "Ctrl+,"}
          onClick={handleSettingsClick}
          onPointerEnter={preloadSettingsRoute}
          onFocus={preloadSettingsRoute}
          className="pointer-events-auto"
          testId="sidebar-settings-button"
        />
      )}
    </div>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter
      data-testid="sidebar-footer"
      className="border-t border-sidebar-border/40 px-[var(--sidebar-content-inset)] py-1.5 empty:hidden"
    >
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
    </SidebarFooter>
  );
});
