@echo off
setlocal enabledelayedexpansion
rem ============================================================================
rem  build-vsix-and-install.bat [win] - package the extension and install it
rem
rem  Compiles the TypeScript and the webview, then packages and installs a vsix:
rem
rem    (default)  the universal vsix - every native\<platform>\git-graph.node
rem               that is present, bundled into one package. Also packages one
rem               smaller VSIX per built platform (scripts/package-platforms.mjs)
rem               alongside it - the same split .github/workflows/release.yml
rem               ships on GitHub Releases. Only the universal vsix is installed
rem               locally, since it works regardless of which platform's engine
rem               matches this machine.
rem    win        a vsix carrying only this machine's Windows engine - a smaller
rem               package and less packaging work in the local dev loop. The
rem               native addon must be built first (build-rust.bat).
rem
rem  Build the native addon first with build-rust.bat (or build-and-install.bat
rem  for the full chain including tests).
rem ============================================================================

cd /d "%~dp0"
set "VSCODE_CMD="

where code >nul 2>&1 && set "VSCODE_CMD=code"
if not defined VSCODE_CMD (
    where code-insiders >nul 2>&1 && set "VSCODE_CMD=code-insiders"
)

rem The optional "win" argument packages only this machine's Windows engine.
set "WIN_MODE="
if /i "%~1"=="win" set "WIN_MODE=1"

set "ARCH=%PROCESSOR_ARCHITEW6432%"
if not defined ARCH set "ARCH=%PROCESSOR_ARCHITECTURE%"
set "WIN_PLATFORM=win32-x64-msvc"
if /i "%ARCH%"=="ARM64" set "WIN_PLATFORM=win32-arm64-msvc"

echo [1/5] Checking prerequisites...
where node >nul 2>&1 || (echo   node is required & goto :fail)
if defined WIN_MODE if not exist "native\%WIN_PLATFORM%\git-graph.node" (
    echo   native\%WIN_PLATFORM%\git-graph.node is missing.
    echo   Build the engine first with build-rust.bat ^(or build-and-install.bat^).
    goto :fail
)
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

if defined WIN_MODE goto :package-win

echo [4/5] Packaging the universal vsix...
for /f "delims=" %%i in ('dir /b /o-d *.vsix 2^>nul') do (
    del "%%i" 2>nul
)
call npm run package || goto :fail

set "VSIX="
for /f "delims=" %%i in ('dir /b /o-d *.vsix 2^>nul') do (
    if not defined VSIX set "VSIX=%%i"
)
goto :package-done

:package-win
echo [4/5] Packaging the %WIN_PLATFORM% vsix...
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

:package-done
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

rem The local install is already done above with the packaged vsix - a per-platform
rem packaging failure here (e.g. no native\*\git-graph.node built yet) does not undo it, so it
rem only warns instead of failing the whole script. (Skipped for the win mode, which
rem packages exactly the one per-platform vsix that was installed.)
if defined WIN_MODE goto :skip-platforms
echo.
echo [5/5] Packaging per-platform vsix files (only the engines currently built)...
call node scripts\package-platforms.mjs
:skip-platforms
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
