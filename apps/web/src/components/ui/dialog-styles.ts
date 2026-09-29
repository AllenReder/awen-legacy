const DIALOG_BACKDROP_BASE_CLASS =
  "fixed inset-0 z-50 transition-opacity [transition-duration:calc(170ms*var(--motion-duration-scale,1))] data-ending-style:opacity-0 data-starting-style:opacity-0";

const DIALOG_BACKDROP_CLASS = `dialog-backdrop ${DIALOG_BACKDROP_BASE_CLASS}`;
const DIALOG_MEDIA_BACKDROP_CLASS = `${DIALOG_BACKDROP_BASE_CLASS} bg-black/75 backdrop-blur-none`;

// The static outer frame: isolates stacking, provides geometry, border, rounded corners,
// and elevation shadow. Does not animate transforms or use will-change-transform, so
// child backdrop-filter (GlassBackdrop) remains completely static and performs zero
// per-frame GPU re-rasterization.
const DIALOG_POPUP_BASE_CLASS =
  "-translate-y-[calc(1.25rem*var(--nested-dialogs))] relative isolate flex min-h-0 w-full min-w-0 scale-[calc(1-0.1*var(--nested-dialogs))] flex-col overflow-hidden opacity-[calc(1-0.1*var(--nested-dialogs))] outline-none transition-opacity [transition-duration:calc(170ms*var(--motion-duration-scale,1))] data-ending-style:opacity-0 data-starting-style:opacity-0 [-webkit-app-region:no-drag]";

const DIALOG_POPUP_CLASS = `${DIALOG_POPUP_BASE_CLASS} rounded-2xl border shadow-2xl`;
const DIALOG_MEDIA_POPUP_CLASS = `${DIALOG_POPUP_BASE_CLASS} max-h-[92vh] w-auto max-w-[92vw] overflow-visible rounded-none border border-transparent bg-transparent p-0 shadow-none`;

// The animated inner content layer: handles entrance and exit motion, scale, and offset
// with a tactile, high-damping deceleration curve.
const DIALOG_POPUP_CONTENT_CLASS =
  "relative z-[1] flex min-h-0 w-full min-w-0 flex-1 flex-col transition-[scale,opacity,translate] [transition-duration:calc(170ms*var(--motion-duration-scale,1))] [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] in-data-[nested]:in-data-[ending-style]:translate-y-8 in-data-[nested]:in-data-[starting-style]:translate-y-8 in-data-[nested-dialog-open]:origin-top in-data-[ending-style]:scale-[0.94] in-data-[starting-style]:scale-[0.94] in-data-[ending-style]:opacity-0 in-data-[starting-style]:opacity-0 max-sm:in-data-[ending-style]:translate-y-4 max-sm:in-data-[starting-style]:translate-y-4";

const DIALOG_MOBILE_SHEET_CLASS =
  "max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))]";

// Standard popover/menu content entrance motion curve and scale.
const POPOVER_CONTENT_MOTION_CLASS =
  "origin-(--transform-origin) transition-[scale,opacity] [transition-duration:calc(170ms*var(--motion-duration-scale,1))] [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] data-starting-style:scale-[0.94] data-ending-style:scale-[0.94] data-starting-style:opacity-0 data-ending-style:opacity-0 in-data-[starting-style]:scale-[0.94] in-data-[ending-style]:scale-[0.94] in-data-[starting-style]:opacity-0 in-data-[ending-style]:opacity-0";

export {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
  DIALOG_POPUP_CONTENT_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
  POPOVER_CONTENT_MOTION_CLASS,
};
