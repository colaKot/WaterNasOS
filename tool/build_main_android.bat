@echo off
rem Build the Android app for the MAIN client -- flutter_client / WaterNasOS.
rem Cloned from tool/build_photo_android.bat, which is the proven recipe on this
rem machine. Only the project dir and the log file differ.
rem
rem Prereqs that are NOT in the repo -- both gitignored -- and must exist:
rem   android/local.properties -> sdk.dir=G:\work\_toolchain\android-sdk
rem                               the system SDK has no NDK 28.2.13676358
rem   android/key.properties   -> release signing; without it the generated
rem                               signingConfig has a null storeFile and Gradle
rem                               fails with "Keystore file not set".
rem   .dart_tool/hooks_runner/shared/pdfium_dart/build/chromium_7811/
rem     android-arm64/libpdfium.so
rem       pdfium_dart's build hook fetches this from github.com, which is
rem       unreachable here -- "PDFium download failed ... errno 121". The hook
rem       short-circuits when the output file already exists, so a pre-seeded
rem       copy skips the download entirely. Extract it from the offline pool:
rem         G:\work\_toolchain\pdfium\pdfium-android-arm64.tgz  ->  lib/libpdfium.so
rem       Only arm64 is pre-seeded, hence --target-platform below.
rem
rem The Android SDK/JDK live under G:\work\_toolchain -- the zero-download pool --
rem so they are exported here instead of relying on the caller's PATH.
rem
rem --no-tree-shake-icons is what keeps the kernel from stalling on this project.
rem Verified 2026-10-09 on photo_client: without it the same build hangs with an
rem idle dartvm.
setlocal

set FLUTTER=G:\work\_toolchain\flutter-sdk\flutter\bin\flutter.bat
set ANDROID_HOME=G:\work\_toolchain\android-sdk
set ANDROID_SDK_ROOT=G:\work\_toolchain\android-sdk
rem NOTE: the JDK folder has an extra version directory inside it.
rem G:\work\_toolchain\jdk17 is the parent; the actual JDK 17.0.20.1 lives one
rem level deeper, so JAVA_HOME must point at the inner directory.
set JAVA_HOME=G:\work\_toolchain\jdk17\jdk-17.0.20.1+1
set PATH=%JAVA_HOME%\bin;%PATH%
set PUB_HOSTED_URL=https://pub.flutter-io.cn
set FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn
set LOG=G:\work\_patch_backup\logs\build_main_android.log

cd /d G:\work\nascab\flutter_client
echo ==== main android start %DATE% %TIME% ====
> "%LOG%" echo ==== main android %DATE% %TIME% ====
rem Gradle 8.12 rejects Java 25 and the machine default is 25.0.3, which fails
rem with "Gradle build failed due to Java/Gradle incompatibility". JAVA_HOME
rem alone is not enough because Flutter prefers its own configured JDK, so pin
rem it explicitly.
call "%FLUTTER%" config --jdk-dir="%JAVA_HOME%" >> "%LOG%" 2>&1
rem Gradle 8.12 -- the version pinned in android/gradle/wrapper -- is below
rem Flutter 3.47.5's minimum of 8.14. Upgrading the wrapper would need a
rem download, and this machine is on the zero-download resource pool where only
rem gradle-8.12-all is cached. Skip the dependency-validation check instead.
call "%FLUTTER%" build apk --release --no-tree-shake-icons --no-pub ^
  --target-platform android-arm64 ^
  --android-skip-build-dependency-validation >> "%LOG%" 2>&1
rem  Do NOT name this variable RC. Windows treats RC as the resource compiler
rem path and Gradle reads it, so setting RC to an exit code makes the build fail
rem with "Could not find the compiler specified in the environment variable RC".
rem  Avoid parentheses in rem lines too: an unescaped one aborts the whole batch
rem file with ". was unexpected at this time", even inside a comment.
set BUILD_RC=%ERRORLEVEL%
if "%BUILD_RC%"=="0" (
  >> "%LOG%" echo BUILD_OK main android
  echo BUILD_OK main android
) else (
  >> "%LOG%" echo BUILD_FAIL main android rc=%BUILD_RC%
  echo BUILD_FAIL main android rc=%BUILD_RC%
)
exit /b 0
