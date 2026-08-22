@echo off
setlocal enabledelayedexpansion
rem ============================================================================
rem  build-vsix-and-install.bat - package the extension and install it
rem
rem  Compiles the TypeScript and the webview, packages the vsix (including the
rem  native binaries under native\) and installs it into VS Code. Build the
rem  native addon first with build-rust.bat (or build-and-install.bat for the
rem  full chain including tests).
rem ============================================================================

cd /d "%~dp0"
set "VSCODE_CMD="

where code >nul 2>&1 && set "VSCODE_CMD=code"
if not defined VSCODE_CMD (
    where code-insiders >nul 2>&1 && set "VSCODE_CMD=code-insiders"
)

echo [1/4] Checking prerequisites...
where node >nul 2>&1 || (echo   node is required & goto :fail)
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

echo [4/4] Packaging the vsix...
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

endlocal
exit /b 0

:fail
echo.
echo BUILD FAILED - see the output above.
endlocal
exit /b 1
