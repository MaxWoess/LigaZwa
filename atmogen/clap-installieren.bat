@echo off
rem Optional: Inhaltsanalyse mit CLAP nachinstallieren (PyTorch CPU + transformers, rund 1 GB).
rem Startet sich in einem Fenster neu, das offen bleibt, damit Meldungen lesbar sind.
if /i not "%~1"=="--run" (
  cmd /k ""%~f0" --run"
  exit /b
)
cd /d "%~dp0"
echo atmogen-Ordner: %cd%
if not exist .venv\Scripts\python.exe (
  echo.
  echo Die Python-Umgebung fehlt noch. Bitte zuerst einmal start.bat ausfuehren,
  echo warten bis sich der Browser oeffnet, dann dieses Fenster erneut starten.
  goto :ende
)
.venv\Scripts\python --version
echo Installiere PyTorch fuer die CPU und transformers, das kann einige Minuten dauern ...
.venv\Scripts\python -m pip install -r requirements-clap.txt
if errorlevel 1 goto :fehler
.venv\Scripts\python -c "import torch, transformers; print('CLAP-Pakete OK: torch', torch.__version__, '/ transformers', transformers.__version__)"
if errorlevel 1 goto :fehler
echo.
echo Fertig. Jetzt start.bat starten und im UI das Haekchen "Inhaltsanalyse mit CLAP" setzen.
goto :ende
:fehler
echo.
echo Die Installation ist fehlgeschlagen. Bitte die Meldungen oben an Claude schicken.
:ende
echo.
echo Dieses Fenster kann geschlossen werden.
