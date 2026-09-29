@echo off
echo ============================================
echo   Dual Video Player - Installer Build
echo ============================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Skip code signing (avoids winCodeSign symlink error)
set CSC_IDENTITY_AUTO_DISCOVERY=false
set CSC_LINK=

:: Clear broken winCodeSign cache
echo [0/3] Cleaning broken cache...
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
    rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" 2>nul
)

echo [1/3] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

echo.
echo [2/3] Building installer EXE (NSIS, code signing skipped)...
call npx electron-builder --win nsis --x64 -c.win.signAndEditExecutable=false
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo [3/3] Build complete!
echo.
echo Output files are in the "dist" folder:
dir /b dist\*.exe 2>nul
echo.
echo ============================================
echo   Installer build successful!
echo ============================================
pause
