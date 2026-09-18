@echo off
setlocal enabledelayedexpansion
rem ============================================================================
rem  build-and-install-automation.bat - full build of the AUTOMATION-enabled Git Graph (Rust) extension
rem
rem  Identical to build-and-install.bat (native addon (release) -> TypeScript ->
rem  webview -> tests -> vsix -> install), except the packaging step uses
rem  `npm run package:automation`: the vsix SHIPS the automation-testing
rem  capability — the in-process suite runner, the Run Automation Test button in
rem  the editor title bar and the report page. The original bats and CI package
rem  WITHOUT it.
rem ============================================================================

cd /d "%~dp0"
set "VSCODE_CMD="

where code >nul 2>&1 && set "VSCODE_CMD=code"
if not defined VSCODE_CMD (
    where code-insiders >nul 2>&1 && set "VSCODE_CMD=code-insiders"
)

echo [1/6] Checking prerequisites...
where node >nul 2>&1 || (echo   node is required & goto :fail)
where cargo >nul 2>&1 || (echo   cargo / Rust is required & goto :fail)
if not defined VSCODE_CMD (
    echo   WARNING: neither 'code' nor 'code-insiders' found on PATH,
    echo   the vsix will be built but not installed.
)

echo [2/6] Installing npm dependencies...
if not exist node_modules (
    call npm install || goto :fail
) else (
    echo   node_modules present, skipping. (delete the folder to force a reinstall)
)

echo [3/6] Building the native addon (release)...
call npm run build:native -- --release || goto :fail

echo [4/6] Compiling the extension and the webview...
call npm run compile || goto :fail

echo [5/6] Running the test suite...
call npm test || goto :fail

echo [6/6] Packaging the AUTOMATION-enabled vsix...
for /f "delims=" %%i in ('dir /b /o-d *.vsix 2^>nul') do (
    del "%%i" 2>nul
)
call npm run package:automation || goto :fail

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
