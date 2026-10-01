set -euo pipefail
mkdir -p release-assets
bundles="apps/desktop/dist-package"
shopt -s nullglob
files=("$bundles"/*.dmg)
if [[ ${#files[@]} -ne 1 ]]; then
  echo "Expected exactly one macOS DMG in $bundles, found ${#files[@]}." >&2
  exit 1
fi
file="${files[0]}"
if [[ "$SIGNING_MODE" == "developer-id" ]]; then
  xcrun stapler validate "$file"
fi
app="$bundles/mac/Awen.app"
if [[ "$ARCH" == "arm64" ]]; then app="$bundles/mac-arm64/Awen.app"; fi
codesign --verify --deep --strict --verbose=2 "$app"
test "$(lipo -archs "$app/Contents/MacOS/Awen")" = "$MACHO_ARCH"
test "$(lipo -archs "$app/Contents/Resources/runtime/node")" = "$MACHO_ARCH"
test "$(lipo -archs "$app/Contents/Resources/trackpad/awen-trackpad.node")" = "$MACHO_ARCH"
cp "$file" release-assets/
