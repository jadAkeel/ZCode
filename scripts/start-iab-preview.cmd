@echo off
setlocal
set "APP_ROOT=%~dp0"
set "APP_EXE=%APP_ROOT%artifacts\win-unpacked\ZCode Preview.exe"
set "PROFILE_ROOT=%APP_ROOT%profile"
if not exist "%APP_EXE%" (
  echo ZCode Preview build not found: "%APP_EXE%"
  exit /b 1
)
if exist "%PROFILE_ROOT%" if not exist "%PROFILE_ROOT%\.iab-preview-profile" (
  echo Refusing to reuse an existing unmarked profile directory: "%PROFILE_ROOT%"
  exit /b 1
)
if not exist "%PROFILE_ROOT%" (
  mkdir "%PROFILE_ROOT%"
  if errorlevel 1 exit /b 1
)
if not exist "%PROFILE_ROOT%\.iab-preview-profile" echo Isolated ZCode IAB Preview profile>"%PROFILE_ROOT%\.iab-preview-profile"
if not exist "%PROFILE_ROOT%\.iab-preview-profile" exit /b 1
set "HOME=%PROFILE_ROOT%"
set "USERPROFILE=%PROFILE_ROOT%"
set "ZCODE_HOME=%PROFILE_ROOT%\.zcode"
set "ZCODE_DATA_BASE_DIR=%PROFILE_ROOT%"
set "ZCODE_DESKTOP_HOME_DIR=%PROFILE_ROOT%"
set "ZCODE_DESKTOP_APPLICATION_NAME=ZCode IAB Preview"
set "ZCODE_DESKTOP_USER_DATA_DIR=%PROFILE_ROOT%\electron"
set "ZCODE_DESKTOP_SESSION_DATA_DIR=%PROFILE_ROOT%\electron-session"
set "ZCODE_DESKTOP_SKIP_OS_INTEGRATION=1"
set "ELECTRON_RUN_AS_NODE="
start "" /D "%APP_ROOT%artifacts\win-unpacked" "%APP_EXE%"
endlocal
