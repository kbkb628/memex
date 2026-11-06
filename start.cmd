@echo off
rem Double-click this to run memex locally. Close the window to stop it.
rem Everything below is ASCII on purpose: this repo lives under a path with
rem non-ASCII characters, and a batch file saved with the wrong codepage
rem turns into garbage before cmd.exe ever runs a line.

cd /d "%~dp0"
title memex - local

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install it first: https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist .dev.vars (
  echo .dev.vars is missing.
  echo Copy .dev.vars.example to .dev.vars and fill in DEEPSEEK_API_KEY.
  pause
  exit /b 1
)

echo.
echo Starting on http://127.0.0.1:8787
echo Keep this window open. Closing it stops the agent.
echo.

call npm run dev

echo.
echo The dev server stopped.
pause
