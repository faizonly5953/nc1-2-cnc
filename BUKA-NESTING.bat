@echo off
setlocal
title NC1 Auto Nesting
set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY (
  echo Python belum terpasang. Install dari https://www.python.org/downloads/
  pause
  exit /b 1
)
%PY% -c "import ezdxf" >nul 2>nul
if errorlevel 1 (
  echo Memasang modul ezdxf ^(sekali saja, butuh internet^)...
  %PY% -m pip install --user ezdxf matplotlib
)
start "" http://127.0.0.1:8768/nest.html
%PY% "%~dp0server.py"
pause
