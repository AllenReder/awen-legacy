import { OVERLAY_CONTENT_MOTION_CLASS, OVERLAY_MODAL_FRAME_CLASS } from "./overlayStyles";
const DIALOG_BACKDROP_BASE_CLASS =
  "fixed inset-0 z-50 transition-opacity [transition-duration:calc(170ms*var(--motion-duration-scale,1))] data-ending-style:opacity-0 data-starting-style:opacity-0";

const DIALOG_BACKDROP_CLASS = `dialog-backdrop ${DIALOG_BACKDROP_BASE_CLASS}`;
const DIALOG_MEDIA_BACKDROP_CLASS = `${DIALOG_BACKDROP_BASE_CLASS} bg-black/75 backdrop-blur-none`;

// The static outer frame: isolates stacking, provides geometry, border, rounded corners,
// and elevation shadow. It never transforms or fades as a sampling ancestor;
// GlassBackdrop and content animate independently inside this stable geometry.
const DIALOG_POPUP_BASE_CLASS =
  "relative isolate flex min-h-0 w-full min-w-0 flex-col overflow-hidden outline-none [-webkit-app-region:no-drag]";

const DIALOG_POPUP_CLASS = `${DIALOG_POPUP_BASE_CLASS} ${OVERLAY_MODAL_FRAME_CLASS}`;
const DIALOG_MEDIA_POPUP_CLASS = `${DIALOG_POPUP_BASE_CLASS} max-h-[92vh] w-auto max-w-[92vw] overflow-visible rounded-none border border-transparent bg-transparent p-0 shadow-none`;

// The animated inner content layer: handles entrance and exit motion, scale, and offset
// with a tactile, high-damping deceleration curve.
const DIALOG_POPUP_CONTENT_CLASS = `${OVERLAY_CONTENT_MOTION_CLASS} overlay-content-modal flex min-h-0 w-full min-w-0 flex-1 flex-col`;

const DIALOG_MOBILE_SHEET_CLASS =
  "max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))]";

// Standard popover/menu content entrance motion curve and scale.
const POPOVER_CONTENT_MOTION_CLASS = OVERLAY_CONTENT_MOTION_CLASS;

export {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
  DIALOG_POPUP_CONTENT_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
  POPOVER_CONTENT_MOTION_CLASS,
};
