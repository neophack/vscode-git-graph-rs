@echo off
setlocal enabledelayedexpansion
rem ============================================================================
rem  build-vsix-and-install.bat - package the extension and install it
rem
rem  Compiles the TypeScript and the webview, packages the universal vsix
rem  (every native\<platform>\git-graph.node that is present, bundled into one
rem  package) and installs it into VS Code. Build the native addon first with
rem  build-rust.bat (or build-and-install.bat for the full chain including
rem  tests).
rem
rem  Also packages one smaller VSIX per built platform (only that platform's
rem  engine, via scripts/package-platforms.mjs) alongside the universal one -
rem  the same split .github/workflows/release.yml ships on GitHub Releases.
rem  Only the universal vsix is installed locally, since it works regardless
rem  of which platform's engine matches this machine; the per-platform ones
rem  are for distributing/publishing separately (see README's "Publishing a
rem  release").
rem ============================================================================

cd /d "%~dp0"
set "VSCODE_CMD="

where code >nul 2>&1 && set "VSCODE_CMD=code"
if not defined VSCODE_CMD (
    where code-insiders >nul 2>&1 && set "VSCODE_CMD=code-insiders"
)

echo [1/5] Checking prerequisites...
where node >nul 2>&1 || (echo   node is required & goto :fail)
if not defined VSCODE_CMD (
    echo   WARNING: neither 'code' nor 'code-insiders' found on PATH,
    echo   the vsix will be built but not installed.
)

echo [2/5] Installing npm dependencies...
if not exist node_modules (
    call npm install || goto :fail
) else (
    echo   node_modules present, skipping. (delete the folder to force a reinstall)
)

echo [3/5] Compiling the extension and the webview...
call npm run compile || goto :fail

echo [4/5] Packaging the universal vsix...
for /f "delims=" %%i in ('dir /b /o-d *.vsix 2^>nul') do (
    del "%%i" 2>nul
)
call npm run package || goto :fail

set "VSIX="
for /f "delims=" %%i in ('dir /b /o-d *.vsix 2^>nul') do (
    if not defined VSIX set "VSIX=%%i"
)
if not defined VSIX (
    echo   no vsix was produced & goto :fail
)
echo   packaged: !VSIX!

if defined VSCODE_CMD (
    echo Installing into VS Code: %VSCODE_CMD%
    call %VSCODE_CMD% --install-extension "!VSIX!" --force || goto :fail
    echo.
    echo Done. Reload the VS Code window to activate the new version.
) else (
    echo.
    echo Done. Install manually with:
    echo   code --install-extension "!VSIX!"
)

rem This is the local install, already done above with the universal vsix - a per-platform
rem packaging failure here (e.g. no native\*\git-graph.node built yet) does not undo it, so it
rem only warns instead of failing the whole script.
echo.
echo [5/5] Packaging per-platform vsix files (only the engines currently built)...
call node scripts\package-platforms.mjs
if errorlevel 1 (
    echo   WARNING: per-platform packaging failed - the installed universal vsix above is unaffected.
)

endlocal
exit /b 0

:fail
echo.
echo BUILD FAILED - see the output above.
endlocal
exit /b 1
