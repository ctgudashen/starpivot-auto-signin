@echo off
rem StarPivot RI daily check-in launcher (Windows Task Scheduler entry point).
rem Runs from the project root and locates node.exe automatically.
rem NOTE: keep this file ASCII-only (cmd parses .bat as GBK; CJK can break it).

rem -- project root = parent of this script's folder (scripts\) --
cd /d "%~dp0.."

set "NODE="

rem ---------- 1) node.exe from PATH (recommended) ----------
for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%i"

rem ---------- 2) common install locations ----------
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem ---------- 3) WorkBuddy managed node (portable: uses %USERPROFILE%) ----------
set "NODEBASE=%USERPROFILE%\.workbuddy\binaries\node\versions"
if not defined NODE if exist "%NODEBASE%\current" (
  for /f "usebackq delims=" %%v in ("%NODEBASE%\current") do set "NODEV=%%v"
)
if not defined NODE if defined NODEV if exist "%NODEBASE%\%NODEV%\node.exe" set "NODE=%NODEBASE%\%NODEV%\node.exe"
if not defined NODE for /d %%d in ("%NODEBASE%\22.*") do if exist "%%d\node.exe" set "NODE=%%d\node.exe"

rem ---------- 4) last resort ----------
if not defined NODE set "NODE=node"

"%NODE%" checkin.mjs
