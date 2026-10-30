@echo off
rem Optional: Inhaltsanalyse mit CLAP nachinstallieren (PyTorch CPU + transformers, rund 1 GB).
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Bitte zuerst einmal start.bat ausfuehren.
  pause
  exit /b 1
)
.venv\Scripts\python -m pip install -r requirements-clap.txt
echo Fertig. Jetzt start.bat starten und im UI das Haekchen "Inhaltsanalyse mit CLAP" setzen.
pause
