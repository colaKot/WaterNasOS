@echo off
rem Pack the WaterNasOS Electron server into an unpacked directory (dist_vN).
rem Usage: build_server_pack.bat [dist_vN]   (default dist_v9)
rem
rem Why the three -c overrides (see docs/ dev quickref, section 9.8):
rem   -c.win.signAndEditExecutable=false  repo-external nascab.pfx does not exist;
rem                                       without this electron-builder tries signtool and downloads winCodeSign
rem   -c.npmRebuild=false                 postinstall @electron/rebuild only accepts VS<=2022; this box has VS2026 (18)
rem   -c.electronDist=node_modules\electron\dist   already-unpacked electron => zero download
rem
rem Standalone: kill any running WaterNasOSServer.exe first, it locks icudtl.dat (EBUSY unlink).
rem Output goes to a log file because tool/bridge_cli.py buffers the child's stdout until exit.
setlocal
set OUT=%~1
if "%OUT%"=="" set OUT=dist_v9
set LOG=G:\work\_patch_backup\logs\server_pack.log
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
cd /d G:\work\nascab\electron_server
rem 第 2 个参数传 nokill 可跳过 taskkill（打「新输出目录」时不需要关掉正在跑的实例）
if /I not "%~2"=="nokill" taskkill /F /IM WaterNasOSServer.exe >nul 2>&1
echo ==== pack start %DATE% %TIME% out=%OUT% ==== > "%LOG%"
"C:\Program Files\nodejs\node.exe" node_modules\electron-builder\out\cli\cli.js --win --x64 --dir -c.win.signAndEditExecutable=false -c.npmRebuild=false -c.electronDist=node_modules\electron\dist -c.directories.output=%OUT% >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
rem --- 图标 + 版本资源：上面的 signAndEditExecutable=false 会让 electron-builder 跳过 rcedit，
rem     于是打包出的 exe 保留 electron 出厂默认图标（文件图标 / 任务栏图标都是它），
rem     且 exe 的版本资源还是 electron 出厂值（FileDescription=Electron），
rem     导致 Windows 任务管理器「进程」页显示的应用名是 Electron 而不是 WaterNasOSServer。
rem     这里在构建成功后用 rcedit 把 libs\logo.ico 和版本字符串补写进 win-unpacked 下的主 exe。
if "%RC%"=="0" call :set_icon
echo ==== EXITCODE=%RC% %DATE% %TIME% ==== >> "%LOG%"
rem ⚠️ 必须 exit /b 带出真实退出码（见 build_web.bat 同处注释）。
endlocal & exit /b %RC%

:set_icon
set RCEDIT=node_modules\electron-winstaller\vendor\rcedit.exe
if not exist "%RCEDIT%" (
  echo [icon] rcedit.exe not found, skip >> "%LOG%"
  goto :eof
)
for %%F in ("%OUT%\win-unpacked\*.exe") do (
  echo [icon] set-icon %%~nxF ^<- libs\logo.ico >> "%LOG%"
  "%RCEDIT%" "%%~fF" --set-icon "libs\logo.ico" >> "%LOG%" 2>&1
  rem Task Manager (processes page) shows the exe FileDescription; without these
  rem strings it stays "Electron". PRODUCT=package.json build.productName.
  echo [ver] set-version-string %%~nxF >> "%LOG%"
  "%RCEDIT%" "%%~fF" --set-version-string CompanyName "NasCab" --set-version-string FileDescription "WaterNasOSServer" --set-version-string ProductName "WaterNasOSServer" --set-version-string InternalName "WaterNasOSServer" --set-version-string OriginalFilename "%%~nxF" --set-version-string LegalCopyright "Copyright (C) NasCab. GPL-3.0." >> "%LOG%" 2>&1
)
goto :eof
