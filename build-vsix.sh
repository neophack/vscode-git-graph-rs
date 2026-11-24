#!/usr/bin/env bash
# ============================================================================
#  build-vsix.sh - compile, package, and optionally install the VSIX on macOS
#
#    ./build-vsix.sh                 production build + package the VSIX
#    ./build-vsix.sh native          rebuild the native engine (release) first
#    ./build-vsix.sh automation      package the automation-enabled VSIX
#    ./build-vsix.sh install         also install the VSIX into VS Code
#    ./build-vsix.sh native install  (arguments combine in any order)
#
#  All work is delegated to the npm scripts (build:native:release, package,
#  package:automation); this wrapper sequences them and reports the artifact.
#  Without "native" the VSIX ships whichever engines are already built under
#  native/<platform>/ (none is fine: the extension falls back to the git CLI
#  backend).
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")"

on_error() {
	echo ""
	echo "BUILD FAILED - see the output above." >&2
	exit 1
}
trap on_error ERR

usage() {
	echo "Usage: ./build-vsix.sh [native] [automation] [install]"
}

NATIVE=0
AUTOMATION=0
INSTALL=0

for arg in "$@"; do
	lower="$(printf '%s' "$arg" | tr '[:upper:]' '[:lower:]')"
	case "$lower" in
		native)
			NATIVE=1
			;;
		automation)
			AUTOMATION=1
			;;
		install)
			INSTALL=1
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown argument: $arg" >&2
			usage >&2
			exit 1
			;;
	esac
done

# Non-login shells on macOS often omit rustup's default bin directory.
if ! command -v cargo >/dev/null 2>&1 && [ -d "$HOME/.cargo/bin" ]; then
	export PATH="$HOME/.cargo/bin:$PATH"
fi

# Locate the VS Code CLI on PATH first, then fall back to standard macOS app bundles.
find_vscode_cli() {
	if command -v code >/dev/null 2>&1; then
		command -v code
		return 0
	fi
	if command -v code-insiders >/dev/null 2>&1; then
		command -v code-insiders
		return 0
	fi
	for candidate in \
		"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
		"$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
		"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" \
		"$HOME/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"; do
		if [ -x "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

VSCODE_CMD=""
if VSCODE_CMD="$(find_vscode_cli)"; then
	:
else
	VSCODE_CMD=""
fi

echo "[1/4] Checking prerequisites..."
if ! command -v node >/dev/null 2>&1; then
	echo "  ERROR: node is required" >&2
	false
fi
if ! command -v npm >/dev/null 2>&1; then
	echo "  ERROR: npm is required" >&2
	false
fi
if [ "$NATIVE" -eq 1 ] && ! command -v cargo >/dev/null 2>&1; then
	echo "  ERROR: cargo is required for \"native\"" >&2
	false
fi
if [ "$INSTALL" -eq 1 ] && [ -z "$VSCODE_CMD" ]; then
	echo "  ERROR: \"install\" was asked for but neither 'code', 'code-insiders', nor a macOS VS Code app bundle was found." >&2
	false
fi

# A node_modules left over from an older package-lock.json can lack build or
# typecheck dependencies (such as vitest), so refresh whenever required tools
# are missing or package-lock.json is newer than the installed snapshot.
echo "[2/4] Installing npm dependencies..."
if [ ! -d "node_modules/esbuild" ] \
	|| [ ! -d "node_modules/@vscode/vsce" ] \
	|| [ ! -d "node_modules/vitest" ] \
	|| [ ! -f "node_modules/.package-lock.json" ] \
	|| [ "package-lock.json" -nt "node_modules/.package-lock.json" ]; then
	npm install
else
	echo "  build tools present, skipping. (run npm install to refresh)"
fi

if [ "$NATIVE" -eq 1 ]; then
	echo "[3/4] Building the native engine (release)..."
	npm run build:native:release
else
	echo "[3/4] Skipping the native engine build (pass \"native\" to rebuild it)."
fi

# Stale root VSIXs would otherwise be picked up as "the newest" below.
rm -f git-graph-rs-*.vsix

if [ "$AUTOMATION" -eq 1 ]; then
	echo "[4/4] Packaging the automation VSIX (production build + vsce)..."
	npm run package:automation
else
	echo "[4/4] Packaging the VSIX (production build + vsce)..."
	npm run package
fi

VSIX="$(ls -t git-graph-rs-*.vsix 2>/dev/null | head -n 1 || true)"
if [ -z "$VSIX" ]; then
	echo "  ERROR: no vsix was produced" >&2
	false
fi
echo "  packaged: $VSIX"

if [ "$INSTALL" -eq 1 ]; then
	echo "Installing into VS Code: $VSCODE_CMD"
	"$VSCODE_CMD" --install-extension "$VSIX" --force
	echo ""
	echo "Done. Reload the VS Code window to activate the new version."
else
	echo ""
	echo "Done. Install manually with:"
	echo "  code --install-extension \"$VSIX\""
fi
