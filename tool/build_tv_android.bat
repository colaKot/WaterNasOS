@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  WaterNasOS Android TV build (Windows)
REM  Usage: tool\build_tv_android.bat [debug|release]
REM  Output: tv_android\app\build\outputs\apk\<variant>\app-<variant>-signed.apk
REM          and a copy in G:\work\_dist\
REM ============================================================

set "ROOT=%~dp0.."
for %%i in ("%ROOT%") do set "ROOT=%%~fi"
pushd "%ROOT%\tv_android" || exit /b 1

set "JAVA_HOME=G:\work\_toolchain\jdk17\jdk-17.0.20.1+1"
set "SDK=G:\work\_toolchain\android-sdk"
set "BT=%SDK%\build-tools\36.0.0"
set "KS=%USERPROFILE%\.android\debug.keystore"
set "VARIANT=%~1"
if "%VARIANT%"=="" set "VARIANT=release"

if not exist "%JAVA_HOME%\bin\java.exe" (
    echo [ERROR] JDK not found: %JAVA_HOME%
    popd & exit /b 1
)
if not exist "%SDK%\platforms\android-36" (
    echo [ERROR] Android SDK platform 36 not found: %SDK%
    popd & exit /b 1
)

REM local.properties is gitignored; create only when missing.
REM NOTE: no backslash-escaped colon here - AGP resolves sdk.dir literally,
REM "G\:/path" makes it throw "filename/directory/volume syntax is incorrect".
if not exist local.properties (
    > local.properties echo sdk.dir=G:/work/_toolchain/android-sdk
)

REM gradle.properties pins a macOS java.home -> override via -D
call gradlew.bat assemble%VARIANT% "-Dorg.gradle.java.home=%JAVA_HOME%" --console=plain
if errorlevel 1 (
    echo [ERROR] gradle build failed
    popd & exit /b 1
)

set "OUT=app\build\outputs\apk\%VARIANT%"
if /i "%VARIANT%"=="release" (
    set "UNSIGNED=%OUT%\app-release-unsigned.apk"
    set "SIGNED=%OUT%\app-release-signed.apk"
) else (
    echo [OK] debug variant is already signed by gradle: %OUT%\app-debug.apk
    popd & exit /b 0
)

if not exist "%UNSIGNED%" (
    echo [ERROR] unsigned apk missing: %UNSIGNED%
    popd & exit /b 1
)

"%BT%\zipalign.exe" -p -f 4 "%UNSIGNED%" "%OUT%\_aligned.apk"
if errorlevel 1 ( echo [ERROR] zipalign failed & popd & exit /b 1 )

REM call is mandatory: a bare .bat invocation never returns control to this script
call "%BT%\apksigner.bat" sign --ks "%KS%" --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android --out "%SIGNED%" "%OUT%\_aligned.apk"
set "SIGNRC=%errorlevel%"
del /q "%OUT%\_aligned.apk" 2>nul
if not "%SIGNRC%"=="0" ( echo [ERROR] apksigner failed & popd & exit /b 1 )

call "%BT%\apksigner.bat" verify "%SIGNED%"
if errorlevel 1 ( echo [ERROR] signature verify failed & popd & exit /b 1 )

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set "STAMP=%%i"
if not exist "G:\work\_dist" mkdir "G:\work\_dist"
copy /y "%SIGNED%" "G:\work\_dist\WaterNasOS-TV-2.0.0-!STAMP!.apk" >nul
echo.
echo [OK] %CD%\%SIGNED%
echo [OK] G:\work\_dist\WaterNasOS-TV-2.0.0-!STAMP!.apk
popd
endlocal
