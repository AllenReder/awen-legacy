set -euo pipefail
# The DMG is what users install, so the daemon inside it has to answer
# /api/auth/session before the artifact leaves the runner. A runtime
# whose dependency layout did not survive packaging fails here.
file="release-assets/Awen-$VERSION-macos-$ARCH.dmg"
mount="$(mktemp -d)"
home="$(mktemp -d)"
runtime=""
installed="$(mktemp -d)"
cleanup() {
  if [[ -n "$runtime" ]]; then
    "$runtime/node" "$runtime/dist/bin.mjs" daemon stop --json --confirm --base-dir "$home" >/dev/null 2>&1 || true
  fi
  hdiutil detach -quiet "$mount" 2>/dev/null || true
  rmdir "$mount" 2>/dev/null || true
  rm -rf "$home" "$installed"
}
trap cleanup EXIT
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mount" "$file"
ditto "$mount/Awen.app" "$installed/Awen.app"
codesign --verify --deep --strict "$installed/Awen.app"
runtime="$installed/Awen.app/Contents/Resources/runtime"
export AWEN_NO_BROWSER=1
if ! started="$("$runtime/node" "$runtime/dist/bin.mjs" daemon start --json --base-dir "$home" 2>"$home/daemon-start.stderr")"; then
  echo "The packaged daemon failed to start:" >&2
  cat "$home/daemon-start.stderr" >&2
  exit 1
fi
cat "$home/daemon-start.stderr" || true
echo "$started"
origin="$(printf '%s\n' "$started" | sed -n 's/.*"origin":"\([^"]*\)".*/\1/p' | tail -n 1)"
test -n "$origin"
session="$(curl -fsS "${origin}api/auth/session")"
echo "$session"
case "$session" in
  *'"policy":"desktop-managed-local"'*) ;;
  *)
    echo "Unexpected /api/auth/session payload." >&2
    exit 1
    ;;
esac
echo "The packaged daemon answered /api/auth/session from $origin."
AWEN_SMOKE_RUNTIME="$runtime" node apps/desktop/scripts/smoke-test.mjs --executable "$installed/Awen.app/Contents/MacOS/Awen"
