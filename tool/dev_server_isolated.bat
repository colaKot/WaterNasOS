@echo off
REM ============================================================
REM  WaterNasOS dev instance launcher (isolated from the daily one)
REM
REM  WHY THIS EXISTS
REM    The server uses Electron's app.requestSingleInstanceLock().
REM    The lock key is Electron's userData dir, which defaults to
REM    %APPDATA%\nascab_os_server and does NOT honour the
REM    userDataFolder env var. So changing userDataFolder alone only
REM    splits the database/cache; a second instance would still be
REM    rejected by the singleton lock and exit immediately.
REM
REM    The server (since 2026-10-12) fixes this: when userDataFolder
REM    is set, it calls app.setPath('userData', ...) BEFORE taking
REM    the lock, so lock key + database + cache + logs all line up
REM    and the two instances can coexist.
REM
REM  WHAT THIS SCRIPT DOES
REM    Gives the dev instance its own:
REM      - data dir (database / nascabos_cache / logs / config)
REM      - HTTP / HTTPS ports (so it does not fight for 6789 / 6799)
REM
REM  USAGE - run in a NORMAL cmd window (not double-click, not in an IDE pipe):
REM    tool\dev_server_isolated.bat
REM    tool\dev_server_isolated.bat --dist dist_v17
REM    tool\dev_server_isolated.bat --port 7789 --https-port 7799
REM    tool\dev_server_isolated.bat --data G:\work\nascab\_devdata
REM
REM  NOTE: the daily/production instance needs no change - just start it normally.
REM ============================================================
setlocal EnableDelayedExpansion
set "ROOT=%~dp0.."
set "ROOT=%ROOT:~0,-1%"

set "DEV_DATA=%ROOT%\_devdata"
set "DEV_PORT=7789"
set "DEV_HTTPS_PORT=7799"
set "DIST=dist_v16"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--data"       ( set "DEV_DATA=%~2"       & shift & shift & goto parse )
if /i "%~1"=="--port"       ( set "DEV_PORT=%~2"        & shift & shift & goto parse )
if /i "%~1"=="--https-port" ( set "DEV_HTTPS_PORT=%~2"  & shift & shift & goto parse )
if /i "%~1"=="--dist"       ( set "DIST=%~2"            & shift & shift & goto parse )
echo [ERROR] unknown arg: %~1
echo         usage: --data ^<dir^>  --port ^<n^>  --https-port ^<n^>  --dist ^<dist_vN^>
exit /b 1
:parsed

set "EXE="
for %%N in (GNasCabServer.exe WaterNasOSServer.exe) do (
  if exist "%ROOT%\electron_server\%DIST%\win-unpacked\%%N" set "EXE=%ROOT%\electron_server\%DIST%\win-unpacked\%%N"
)
if "%EXE%"=="" (
  echo [ERROR] server exe not found under:
  echo           %ROOT%\electron_server\%DIST%\win-unpacked\
  echo         build first, or pass --dist ^<dist_vN^>
  exit /b 1
)

if not exist "%DEV_DATA%" mkdir "%DEV_DATA%"

echo ============================================================
echo  WaterNasOS dev instance (isolated)
echo ------------------------------------------------------------
echo   exe        : %EXE%
echo   data dir   : %DEV_DATA%
echo   HTTP port  : %DEV_PORT%
echo   HTTPS port : %DEV_HTTPS_PORT%
echo ------------------------------------------------------------
echo   The daily instance is unaffected: userData and ports differ,
echo   so the singleton lock key (= userData) does not collide.
echo ============================================================
echo.

set "userDataFolder=%DEV_DATA%"
set "PORT=%DEV_PORT%"
set "HTTPS_PORT=%DEV_HTTPS_PORT%"

pushd "%ROOT%\electron_server"
"%EXE%"
set "RC=%ERRORLEVEL%"
popd

echo.
echo [dev_server_isolated] exit code = %RC%
exit /b %RC%
