@echo off
rem atmogen starten. Beim ersten Mal wird eine eigene Python-Umgebung eingerichtet.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Richte atmogen ein, das dauert beim ersten Mal ein paar Minuten ...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if not exist .venv\Scripts\python.exe (
    echo Python wurde nicht gefunden. Bitte von python.org installieren und "Add python.exe to PATH" anhaken.
    pause
    exit /b 1
  )
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python ui.py
pause
