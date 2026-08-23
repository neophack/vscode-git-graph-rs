@echo off
setlocal enabledelayedexpansion
rem ============================================================================
rem  build-rust.bat - build the native addon for EVERY platform the extension
rem  ships for, not just this one.
rem
rem    build-rust.bat                    build all six targets (release)
rem    build-rust.bat --only <triple>    build a single target
rem    build-rust.bat --debug            debug instead of release
rem
rem  How each target is produced from a Windows host:
rem
rem    x86_64-pc-windows-msvc            native MSVC
rem    aarch64-pc-windows-msvc           rust-lld + the Windows SDK's arm64
rem                                      libraries + the ARM64 CRT vsix from
rem                                      cargo-xwin's cache (no VS "ARM64
rem                                      build tools" component, no symlink
rem                                      privileges needed - see
rem                                      scripts/build-addon.mjs)
rem    x86_64-unknown-linux-gnu          cargo-zigbuild (zig cross-links glibc)
rem    aarch64-unknown-linux-gnu         cargo-zigbuild
rem    x86_64-apple-darwin               cargo-zigbuild (zig bundles the macOS
rem    aarch64-apple-darwin              libc, so no Apple SDK is needed)
rem
rem  zig comes from the pip `ziglang` package (`pip install ziglang`) or from
rem  the PATH. Each target is built independently: one failure does not stop
rem  the others, and the exit code reports whether everything succeeded.
rem ============================================================================

cd /d "%~dp0"

set "RELEASE=--release"
set "ONLY="
:parse
if "%~1"=="" goto :parsed
if /i "%~1"=="--only" ( set "ONLY=%~2" & shift & shift & goto :parse )
if /i "%~1"=="--debug" ( set "RELEASE=" & shift & goto :parse )
echo Unknown option: %~1
goto :usage
:parsed

echo [1/4] Checking prerequisites...
where node >nul 2>&1 || (echo   node is required & goto :fail)
where cargo >nul 2>&1 || (echo   cargo / Rust is required & goto :fail)

echo [2/4] Installing npm dependencies...
if not exist node_modules (
    call npm install || goto :fail
) else (
    echo   node_modules present, skipping. ^(delete the folder to force a reinstall^)
)

echo [3/4] Checking cross toolchains...
rem zig, for the Linux and macOS targets. cargo-zigbuild finds the pip
rem `ziglang` package automatically; a standalone zig on the PATH works too.
python -m ziglang version >nul 2>&1
if errorlevel 1 (
    where zig >nul 2>&1
    if errorlevel 1 (
        echo   WARNING: zig not found - the Linux and macOS targets will fail.
        echo   Install it with: pip install ziglang
    ) else (
        echo   zig found on PATH.
    )
) else (
    echo   zig found via the ziglang package.
)
rem The Windows arm64 target needs no extra install: rust-lld ships with the
rem Rust toolchain and the CRT vsix is fetched through cargo-xwin's cache.

echo [4/4] Building targets (%RELEASE%)...
set /a BUILT=0
set /a FAILED=0

rem ---- The six targets, each through the toolchain that suits it ---------------------
call :build x86_64-pc-windows-msvc ""
call :build aarch64-pc-windows-msvc "--cross-compile"
call :build x86_64-unknown-linux-gnu "--cross-compile"
call :build aarch64-unknown-linux-gnu "--cross-compile"
call :build x86_64-apple-darwin "--cross-compile"
call :build aarch64-apple-darwin "--cross-compile"

echo.
if %FAILED% GTR 0 (
    echo BUILD FINISHED WITH FAILURES: %BUILT% built, %FAILED% failed.
    endlocal
    exit /b 1
)
echo BUILD OK: %BUILT% target^(s^) built into native\.
echo The binaries are ready to be packaged ^(build-vsix-and-install.bat^).
endlocal
exit /b 0

rem ---- build one target ---------------------------------------------------------------
:build <triple> <extra-flags>
if not "%ONLY%"=="" if /i not "%~1"=="%ONLY%" exit /b 0
echo.
echo === %~1 ===
call node scripts\build-addon.mjs %RELEASE% --target %~1 %~2
if errorlevel 1 (
    set /a FAILED+=1
    echo   FAILED: %~1 ^(the other targets continue^)
) else (
    set /a BUILT+=1
)
exit /b 0

:usage
echo Usage: build-rust.bat [--only ^<triple^>] [--debug]
echo Targets: x86_64-pc-windows-msvc aarch64-pc-windows-msvc x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-apple-darwin aarch64-apple-darwin
exit /b 1

:fail
echo.
echo BUILD FAILED - see the output above.
endlocal
exit /b 1
