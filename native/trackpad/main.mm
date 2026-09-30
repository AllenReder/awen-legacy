#import <AppKit/AppKit.h>
#include <node_api.h>
#include <map>
#include <cstdint>

struct Packet {
  uint64_t gesture, sequence;
  const char *phase;
  double dx, dy, time, x, y;
};
struct Watch {
  __weak NSView *view;
  id monitor;
  napi_threadsafe_function callback;
  uint64_t gesture = 0, sequence = 0;
  bool direct = false;
};
static std::map<uint64_t, Watch *> watches;
static uint64_t nextWatch = 0;
static void Deliver(napi_env env, napi_value callback, void *, void *data) {
  Packet *packet = static_cast<Packet *>(data);
  if (env && callback) {
    napi_value object, value, receiver, ignored;
    napi_create_object(env, &object);
    const auto number = [&](const char *name, double amount) {
      napi_create_double(env, amount, &value);
      napi_set_named_property(env, object, name, value);
    };
    number("gestureId", packet->gesture); number("sequence", packet->sequence);
    number("deltaX", packet->dx); number("deltaY", packet->dy);
    number("time", packet->time); number("x", packet->x); number("y", packet->y);
    napi_create_string_utf8(env, packet->phase, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, object, "phase", value);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &object, &ignored);
  }
  delete packet;
}
static void Stop(uint64_t id) {
  auto found = watches.find(id);
  if (found == watches.end()) return;
  Watch *watch = found->second;
  [NSEvent removeMonitor:watch->monitor];
  napi_release_threadsafe_function(watch->callback, napi_tsfn_abort);
  watches.erase(found);
  delete watch;
}
static void Cleanup(void *) {
  while (!watches.empty()) Stop(watches.begin()->first);
}
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], resource;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  void *bytes = nullptr; size_t length = 0;
  if (count != 2 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Expected an NSView handle and callback"); return nullptr;
  }
  NSView *view = (__bridge NSView *)(*static_cast<void **>(bytes));
  if (!view || !view.window) { napi_throw_error(env, nullptr, "Native window is not ready"); return nullptr; }
  Watch *watch = new Watch;
  watch->view = view;
  napi_create_string_utf8(env, "AwenTrackpad", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_threadsafe_function(env, args[1], nullptr, resource, 0, 1, nullptr, nullptr, nullptr, Deliver, &watch->callback) != napi_ok) {
    delete watch; napi_throw_error(env, nullptr, "Cannot create trackpad callback"); return nullptr;
  }
  watch->monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent *(NSEvent *event) {
    NSView *target = watch->view;
    if (!target || event.window != target.window || !event.hasPreciseScrollingDeltas ||
        (event.modifierFlags & (NSEventModifierFlagControl | NSEventModifierFlagShift | NSEventModifierFlagCommand | NSEventModifierFlagOption))) return event;
    const NSEventPhase phase = event.phase, momentum = event.momentumPhase;
    const char *kind = nullptr;
    if (phase & NSEventPhaseCancelled) { kind = "cancel"; watch->direct = false; }
    else if (momentum & NSEventPhaseEnded) { kind = "finish"; watch->direct = false; }
    else if (momentum != NSEventPhaseNone) { kind = "momentum"; watch->direct = false; }
    else if ((phase & NSEventPhaseBegan) || ((phase & NSEventPhaseChanged) && !watch->direct)) {
      kind = "begin"; ++watch->gesture; watch->direct = true;
    } else if (phase & NSEventPhaseEnded) { kind = "end"; watch->direct = false; }
    else if (phase & NSEventPhaseChanged) kind = "update";
    if (!kind) return event;
    NSPoint point = [target convertPoint:event.locationInWindow fromView:nil];
    double y = target.isFlipped ? point.y : NSHeight(target.bounds) - point.y;
    Packet *packet = new Packet {watch->gesture, ++watch->sequence, kind,
      -event.scrollingDeltaX, -event.scrollingDeltaY, event.timestamp * 1000, point.x, y};
    if (napi_call_threadsafe_function(watch->callback, packet, napi_tsfn_nonblocking) != napi_ok) delete packet;
    return event; // Observation never consumes AppKit input.
  }];
  const uint64_t id = ++nextWatch;
  watches[id] = watch;
  napi_value result; napi_create_double(env, id, &result); return result;
}
static napi_value StopExport(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg, result;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  double id = 0; napi_get_value_double(env, arg, &id); Stop(static_cast<uint64_t>(id));
  napi_get_undefined(env, &result); return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, StopExport, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, properties);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}
NAPI_MODULE(awen_trackpad, Init)
