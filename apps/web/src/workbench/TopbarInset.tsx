/** Shared window-control reservation for Tabs and Settings navigation. */
export function TopbarInset() {
  return (
    <div
      className="flex shrink-0 items-center overflow-hidden [-webkit-app-region:no-drag]"
      data-slot="workbench-tabs-inset-spacer"
      style={{ width: "var(--sidebar-motion-tabs-inset, 0px)" }}
    >
      <div
        className="flex h-full w-full items-center justify-end"
        style={{
          paddingRight: "var(--sidebar-separator-right-gap)",
          opacity: "calc(1 - var(--sidebar-motion-progress, 1))",
        }}
      >
        <div
          className="h-3.5 w-px bg-border/60 shrink-0"
          data-slot="workbench-titlebar-separator"
        />
      </div>
    </div>
  );
}
