import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";
import { PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { SidebarTitlebarButton } from "./sidebar/SidebarTitlebarControl";
import { SidebarActionControl } from "./sidebar/SidebarChrome";
import { createSidebarPresentation } from "./sidebar/sidebarPresentation";
import { getPrefersReducedMotion } from "../workbench/workbenchMotion";
import { useClientSettings } from "../hooks/useSettings";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { isMacPlatform } from "../lib/utils";
import { useWindowChromeGeometry } from "../lib/windowChrome";
import type { WindowChromeGeometry } from "@awen/shared/windowChromeGeometry";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "../panelAnimations";
import { AwenSidebar } from "./AwenSidebar";
import { MaterialSurface } from "./MaterialSurface";
import { WorkbenchDragProvider } from "../workbench/workbenchDrag";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { useProjects } from "../state/entities";
import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function readPreferredThreadSidebarWidth(): number | null {
  try {
    return getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite);
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return null;
  }
}

function SidebarControl() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const isOpen = useSidebarVisibility();
  const isMac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (resolveShortcutCommand(event, keybindings) !== "sidebar.toggle") return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, toggleSidebar]);

  return (
    <div
      className="pointer-events-none fixed top-0 z-50 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]"
      data-sidebar-control=""
      style={{
        left: "var(--sidebar-trigger-left)",
      }}
    >
      <SidebarTitlebarButton
        icon={
          isOpen ? <PanelLeftCloseIcon className="size-4" /> : <PanelLeftIcon className="size-4" />
        }
        label="Toggle main sidebar"
        shortcut={shortcutLabel || (isMac ? "⌘B" : "Ctrl+B")}
        ariaLabel="Toggle main sidebar"
        ariaPressed={isOpen}
        onClick={toggleSidebar}
        className="pointer-events-auto"
        testId="fixed-sidebar-trigger"
      />
    </div>
  );
}

// Settings swaps the thread sidebar out of the tree. Keep the lightweight
// project projection subscribed so returning to a draft never renders the
// zero-project state while the environment snapshot reconnects.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

function SidebarMotionController({
  enabled,
  width,
  durationMs,
  geometry,
  onPresentationReady,
}: {
  enabled: boolean;
  width: number;
  durationMs: number;
  geometry: WindowChromeGeometry;
  onPresentationReady: (presentation: ReturnType<typeof createSidebarPresentation>) => void;
}) {
  const open = useSidebarVisibility();
  const marker = useRef<HTMLSpanElement>(null);
  const presentation = useRef<ReturnType<typeof createSidebarPresentation> | null>(null);
  const latest = useRef({ geometry, open });
  useLayoutEffect(() => {
    latest.current = { geometry, open };
  }, [geometry, open]);
  useLayoutEffect(() => {
    const wrapper = marker.current?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!wrapper) return;
    const current = latest.current;
    presentation.current = createSidebarPresentation(wrapper, current.geometry, current.open);
    onPresentationReady(presentation.current);
    return () => {
      presentation.current?.dispose();
      presentation.current = null;
    };
  }, [onPresentationReady]);
  useLayoutEffect(() => {
    presentation.current?.update({
      open,
      enabled: enabled && !getPrefersReducedMotion(),
      width,
      durationMs,
      geometry,
    });
  }, [durationMs, enabled, geometry, open, width]);
  return <span ref={marker} hidden />;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const animationDurationScale = useClientSettings((settings) => settings.animationDurationScale);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  // Settings routes show the settings nav in place of whichever thread
  // sidebar is active.
  const pathname = useLocation({ select: (location) => location.pathname });
  const panelAnimationsSuppressed = usePanelNavigationSuppression(pathname);
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const geometry = useWindowChromeGeometry();
  const sidebarMotion = useRef<ReturnType<typeof createSidebarPresentation> | null>(null);
  const onPresentationReady = useCallback(
    (presentation: ReturnType<typeof createSidebarPresentation>) => {
      sidebarMotion.current = presentation;
    },
    [],
  );
  const [preferredSidebarWidth, setPreferredSidebarWidth] = useState(
    readPreferredThreadSidebarWidth,
  );
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(
    viewportWidth,
    geometry.minimumSidebarWidth,
  );
  const sidebarWidth = resolveInitialThreadSidebarWidth(
    preferredSidebarWidth,
    viewportWidth,
    geometry.minimumSidebarWidth,
  );
  const commitSidebarWidth = (width: number) => {
    setPreferredSidebarWidth(width);
    try {
      setLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, width, Schema.Finite);
    } catch (error) {
      console.error("Could not persist sidebar width.", error);
    }
  };
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setPreferredSidebarWidth(null);
  };
  const sidebarProviderStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
  } as CSSProperties;

  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      "--motion-duration-scale",
      String(animationDurationScale),
    );
    document.documentElement.dataset.motionOff =
      animationDurationScale === 0 || prefersReducedMotion ? "true" : "false";
  }, [animationDurationScale, prefersReducedMotion]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key === "," || event.code === "Comma") &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (isSettingsRoute) {
          if (canGoBack) {
            window.history.back();
          } else {
            void navigate({ to: "/" });
          }
        } else {
          void navigate({ to: "/settings" });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [canGoBack, navigate, pathname]);

  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      <WorkbenchDragProvider>
        <SidebarProvider
          className="h-dvh! min-h-0!"
          data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
          defaultOpen
          style={sidebarProviderStyle}
        >
          <SidebarMotionController
            enabled={routePanelAnimationsActive}
            width={sidebarWidth}
            durationMs={panelAnimationDurationMs}
            geometry={geometry}
            onPresentationReady={onPresentationReady}
          />
          <ProjectProjectionRetention />
          <Sidebar
            side="left"
            collapsible="offcanvas"
            data-app-sidebar=""
            className="border-0! text-sidebar-foreground"
            resizable={{
              maxWidth: sidebarMaximumWidth,
              minWidth: geometry.minimumSidebarWidth,
              shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
                nextWidth <= currentWidth ||
                wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
              onResize: commitSidebarWidth,
              onResizeFrame: (width) => sidebarMotion.current?.resize(width),
            }}
          >
            {/* Paint the translucent edge over the tint, not over the bare Glass Stage. */}
            <MaterialSurface
              kind="sidebar"
              className="flex h-full min-h-0 w-full flex-col border-r border-[var(--material-edge)]"
            >
              {isOnSettings ? <SettingsSidebarNav pathname={pathname} /> : <AwenSidebar />}
            </MaterialSurface>
            <SidebarRail onDoubleClick={resetSidebarWidth} />
          </Sidebar>
          {children}
          <SidebarControl />
          <SidebarActionControl pathname={pathname} />
        </SidebarProvider>
      </WorkbenchDragProvider>
    </PanelAnimationSuppressionProvider>
  );
}
