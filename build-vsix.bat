@echo off
setlocal enabledelayedexpansion
rem ============================================================================
rem  build-vsix.bat - compile and package the extension into a VSIX
rem
rem    build-vsix.bat                 production build + package the VSIX
rem    build-vsix.bat native          rebuild the native engine (release) first
rem    build-vsix.bat automation      package the automation-enabled VSIX
rem    build-vsix.bat install         also install the VSIX into VS Code
rem    build-vsix.bat native install  (arguments combine in any order)
rem
rem  All work is delegated to the npm scripts (build:native:release, package,
rem  package:automation); this wrapper only sequences them and reports the
rem  artifact. Without "native" the VSIX ships whichever engines are already
rem  built under native\<platform>\ (none is fine: the extension falls back to
rem  the git CLI backend).
rem ============================================================================

cd /d "%~dp0"

set "NATIVE="
set "AUTOMATION="
set "INSTALL="
for %%a in (%*) do (
	if /i "%%~a"=="native" (
		set "NATIVE=1"
	) else if /i "%%~a"=="automation" (
		set "AUTOMATION=1"
	) else if /i "%%~a"=="install" (
		set "INSTALL=1"
	) else (
		echo Unknown argument: %%~a
		echo Usage: build-vsix.bat [native] [automation] [install]
		exit /b 1
	)
)

set "VSCODE_CMD="
where code >nul 2>&1 && set "VSCODE_CMD=code"
if not defined VSCODE_CMD (
	where code-insiders >nul 2>&1 && set "VSCODE_CMD=code-insiders"
)

echo [1/4] Checking prerequisites...
where node >nul 2>&1 || (echo   ERROR: node is required & goto :fail)
if defined NATIVE (
	where cargo >nul 2>&1 || (echo   ERROR: cargo is required for "native" & goto :fail)
)
if defined INSTALL if not defined VSCODE_CMD (
	echo   ERROR: "install" was asked for but neither 'code' nor 'code-insiders' is on PATH.
	goto :fail
)

rem A node_modules left over from an older package.json can lack the build tools,
rem so probe for them rather than for the folder alone.
echo [2/4] Installing npm dependencies...
set "NEED_INSTALL="
if not exist node_modules\esbuild set "NEED_INSTALL=1"
if not exist node_modules\@vscode\vsce set "NEED_INSTALL=1"
if defined NEED_INSTALL (
	call npm install || goto :fail
) else (
	echo   build tools present, skipping. ^(run npm install to refresh^)
)

if defined NATIVE (
	echo [3/4] Building the native engine ^(release^)...
	call npm run build:native:release || goto :fail
) else (
	echo [3/4] Skipping the native engine build ^(pass "native" to rebuild it^).
)

rem Stale root VSIXs would otherwise be picked up as "the newest" below.
del /q git-graph-rs-*.vsix >nul 2>&1

if defined AUTOMATION (
	echo [4/4] Packaging the automation VSIX ^(production build + vsce^)...
	call npm run package:automation || goto :fail
) else (
	echo [4/4] Packaging the VSIX ^(production build + vsce^)...
	call npm run package || goto :fail
)

set "VSIX="
for /f "delims=" %%i in ('dir /b /o-d git-graph-rs-*.vsix 2^>nul') do (
	if not defined VSIX set "VSIX=%%i"
)
if not defined VSIX (
	echo   ERROR: no vsix was produced
	goto :fail
)
echo   packaged: !VSIX!

if defined INSTALL (
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
