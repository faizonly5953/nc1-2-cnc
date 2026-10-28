@echo off
setlocal
title NC1 ke G-code F2100B

set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python belum terpasang.
  echo Download dari https://www.python.org/downloads/ lalu install,
  echo centang "Add python.exe to PATH" saat instalasi.
  pause
  exit /b 1
)

%PY% -c "import ezdxf, matplotlib" >nul 2>nul
if errorlevel 1 (
  echo Memasang modul ezdxf dan matplotlib ^(sekali saja, butuh internet^)...
  %PY% -m pip install --user ezdxf matplotlib
)

if "%~1"=="" (
  echo.
  echo  Cara pakai: seret satu atau beberapa file .nc1
  echo  ^(atau satu folder^) ke ikon KONVERSI.bat ini.
  echo.
  echo  Hasil .TXT dan _preview.png muncul di folder yang sama dengan gambar.
  echo  Pengaturan ada di dwg2cnc.ini
  echo.
  pause
  exit /b 0
)

%PY% "%~dp0nc1tocnc.py" %*
echo.
pause
