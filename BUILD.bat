@echo off
echo ========================================
echo   Dual Video Player - Build Script
echo ========================================
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo [1/2] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo ERROR: npm install failed!
        pause
        exit /b 1
    )
    echo.
) else (
    echo [1/2] Dependencies already installed, skipping...
    echo.
)

echo [2/2] Building portable exe...
call npx electron-builder --win portable --x64
if errorlevel 1 (
    echo ERROR: Build failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Build complete!
echo   Output: dist\DualVideoPlayer.exe
echo ========================================
pause
