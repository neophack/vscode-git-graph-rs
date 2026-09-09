@echo off
setlocal enabledelayedexpansion
rem ============================================================================
rem  build-vsix-win-and-install.bat - package a Windows-only vsix and install it
rem
rem  The Windows-only counterpart of build-vsix-and-install.bat: compiles the
rem  TypeScript and the webview, then packages (via scripts/package-platforms.mjs)
rem  and installs a vsix carrying only this machine's Windows engine
rem  (native\<platform>\git-graph.node) instead of the universal bundle with
rem  every built engine - a smaller package and less packaging work in the local
rem  dev loop. Build the native addon first with build-rust.bat (or
rem  build-and-install.bat for the full chain including tests).
rem ============================================================================

cd /d "%~dp0"
set "VSCODE_CMD="

where code >nul 2>&1 && set "VSCODE_CMD=code"
if not defined VSCODE_CMD (
    where code-insiders >nul 2>&1 && set "VSCODE_CMD=code-insiders"
)

rem Pick the engine matching this machine; VS Code's own architecture follows
rem the OS's. PROCESSOR_ARCHITEW6432 is only set from a 32-bit process and then
rem names the real OS architecture, so prefer it when present.
set "ARCH=%PROCESSOR_ARCHITEW6432%"
if not defined ARCH set "ARCH=%PROCESSOR_ARCHITECTURE%"
set "WIN_PLATFORM=win32-x64-msvc"
if /i "%ARCH%"=="ARM64" set "WIN_PLATFORM=win32-arm64-msvc"

echo [1/4] Checking prerequisites...
where node >nul 2>&1 || (echo   node is required & goto :fail)
if not exist "native\%WIN_PLATFORM%\git-graph.node" (
    echo   native\%WIN_PLATFORM%\git-graph.node is missing.
    echo   Build the engine first with build-rust.bat ^(or build-and-install.bat^).
    goto :fail
)
if not defined VSCODE_CMD (
    echo   WARNING: neither 'code' nor 'code-insiders' found on PATH,
    echo   the vsix will be built but not installed.
)

echo [2/4] Installing npm dependencies...
if not exist node_modules (
    call npm install || goto :fail
) else (
    echo   node_modules present, skipping. (delete the folder to force a reinstall)
)

echo [3/4] Compiling the extension and the webview...
call npm run compile || goto :fail

echo [4/4] Packaging the %WIN_PLATFORM% vsix...
rem Only this platform's stale vsix files are cleared - artifacts of the
rem universal and other-platform packaging runs are left alone.
for /f "delims=" %%i in ('dir /b /o-d "git-graph-rs-*-%WIN_PLATFORM%.vsix" 2^>nul') do (
    del "%%i" 2>nul
)
call node scripts\package-platforms.mjs %WIN_PLATFORM% || goto :fail

set "VSIX="
for /f "delims=" %%i in ('dir /b /o-d "git-graph-rs-*-%WIN_PLATFORM%.vsix" 2^>nul') do (
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

endlocal
exit /b 0

:fail
echo.
echo BUILD FAILED - see the output above.
endlocal
exit /b 1
