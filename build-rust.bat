@echo off
setlocal enabledelayedexpansion
rem ============================================================================
rem  build-rust.bat - build the native addon for this platform
rem
rem  Runs the @napi-rs/cli-driven build (release) and places the binary where
rem  the extension loads it from: native\<platform>\git-graph.node.
rem  Cross-compile for another platform with: build-rust.bat --target <triple>
rem ============================================================================

cd /d "%~dp0"

echo [1/3] Checking prerequisites...
where node >nul 2>&1 || (echo   node is required & goto :fail)
where cargo >nul 2>&1 || (echo   cargo / Rust is required & goto :fail)

echo [2/3] Installing npm dependencies...
if not exist node_modules (
    call npm install || goto :fail
) else (
    echo   node_modules present, skipping. (delete the folder to force a reinstall)
)

echo [3/3] Building the native addon (release)...
call npm run build:native -- --release || goto :fail

echo.
echo Done. The addon is in native\, ready to be packaged (build-vsix-and-install.bat).
endlocal
exit /b 0

:fail
echo.
echo BUILD FAILED - see the output above.
endlocal
exit /b 1
