#!/bin/sh
#
# Build a release tarball of the darpan CLI and print its sha256 + formula values.
#
# Usage:
#   scripts/package.sh [version]
#
# version defaults to the latest git tag (with any leading "v" stripped).
# The tarball contains darpan-<version>/bin/darpan (+ README, LICENSE) so the
# Homebrew formula's `bin.install "bin/darpan"` works after extraction.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)"
fi
[ -n "$VERSION" ] || { echo "usage: scripts/package.sh <version>   (e.g. 0.1.0)" >&2; exit 1; }

PKG="darpan-$VERSION"
DIST="$ROOT/dist"
STAGE="$DIST/$PKG"

rm -rf "$STAGE"
mkdir -p "$STAGE/bin"

# Copy the CLI, stamping the version so `darpan version` matches the release.
sed "s/^DARPAN_CLI_VERSION=.*/DARPAN_CLI_VERSION=\"$VERSION\"/" bin/darpan > "$STAGE/bin/darpan"
chmod +x "$STAGE/bin/darpan"
[ -f README.md ] && cp README.md "$STAGE/"
[ -f LICENSE ]   && cp LICENSE   "$STAGE/"

TARBALL="$DIST/$PKG.tar.gz"
tar -czf "$TARBALL" -C "$DIST" "$PKG"

if command -v shasum >/dev/null 2>&1; then
  SHA=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
else
  SHA=$(sha256sum "$TARBALL" | awk '{print $1}')
fi

echo "tarball: $TARBALL"
echo "sha256:  $SHA"
echo "url:     https://github.com/drpn-ai/darpan-cli/releases/download/v$VERSION/$PKG.tar.gz"
