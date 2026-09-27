#!/bin/sh
# ============================================================================
#  build-and-install.sh [automation] - full build and install of the Git Graph (Rust) extension
#
#  The macOS/Linux twin of build-and-install.bat: runs the whole chain —
#  native addon (release) -> TypeScript -> webview -> tests -> vsix package ->
#  install into VS Code. Each step is checked, and the script stops at the
#  first failure so a stale vsix can never be installed.
#
#  Pass "automation" as the first argument to package the AUTOMATION-enabled
#  vsix instead (npm run package:automation - ships the in-process test
#  runner, the Run Automation Test button and the report page).
# ============================================================================

cd "$(dirname "$0")" || exit 1

fail() {
	echo
	echo "BUILD FAILED - see the output above."
	exit 1
}

# The VS Code CLI is not on the PATH by default on macOS (it takes the
# "Shell Command: Install 'code' command in PATH" command to put it there),
# so the standard app-bundle locations are checked as a fallback.
VSCODE_CMD=$(command -v code 2>/dev/null || command -v code-insiders 2>/dev/null || true)
if [ -z "$VSCODE_CMD" ]; then
	for candidate in \
		"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
		"$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
		"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders" \
		"$HOME/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"
	do
		if [ -x "$candidate" ]; then
			VSCODE_CMD=$candidate
			break
		fi
	done
fi

# rustup's canonical location, for shells whose PATH does not carry it.
if ! command -v cargo >/dev/null 2>&1 && [ -x "$HOME/.cargo/bin/cargo" ]; then
	PATH="$HOME/.cargo/bin:$PATH"
	export PATH
fi

echo "[1/6] Checking prerequisites..."
command -v node >/dev/null 2>&1 || { echo "  node is required"; fail; }
command -v cargo >/dev/null 2>&1 || { echo "  cargo / Rust is required"; fail; }
if [ -z "$VSCODE_CMD" ]; then
	echo "  WARNING: neither 'code' nor 'code-insiders' found on PATH or in /Applications,"
	echo "  the vsix will be built but not installed."
fi

echo "[2/6] Installing npm dependencies..."
if [ ! -d node_modules ]; then
	npm install || fail
else
	echo "  node_modules present, skipping. (delete the folder to force a reinstall)"
fi

echo "[3/6] Building the native addon (release)..."
npm run build:native -- --release || fail

echo "[4/6] Compiling the extension and the webview..."
npm run compile || fail

echo "[5/6] Running the test suite..."
npm test || fail

# The packaging step honours the optional "automation" argument (see the header).
PACKAGE_SCRIPT=package
ARG=$(printf '%s' "${1-}" | tr '[:upper:]' '[:lower:]')
if [ "$ARG" = "automation" ]; then
	PACKAGE_SCRIPT=package:automation
fi

echo "[6/6] Packaging the vsix (npm run $PACKAGE_SCRIPT)..."
rm -f ./*.vsix
npm run "$PACKAGE_SCRIPT" || fail

VSIX=$(ls -t ./*.vsix 2>/dev/null | head -n 1)
if [ -z "$VSIX" ]; then
	echo "  no vsix was produced"
	fail
fi
echo "  packaged: $VSIX"

if [ -n "$VSCODE_CMD" ]; then
	echo "Installing into VS Code: $VSCODE_CMD"
	"$VSCODE_CMD" --install-extension "$VSIX" --force || fail
	echo
	echo "Done. Reload the VS Code window to activate the new version."
else
	echo
	echo "Done. Install manually with:"
	echo "  code --install-extension $VSIX"
fi
