@echo off
rem atmogen starten. Beim ersten Mal wird eine eigene Python-Umgebung eingerichtet.
rem Startet sich in einem Fenster neu, das offen bleibt, damit Meldungen lesbar sind.
if /i not "%~1"=="--run" (
  cmd /k ""%~f0" --run"
  exit /b
)
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Richte atmogen ein, das dauert beim ersten Mal ein paar Minuten ...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if not exist .venv\Scripts\python.exe goto :keinpython
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt
  if errorlevel 1 goto :fehler
)
echo atmogen laeuft. Dieses Fenster offen lassen; schliessen beendet atmogen.
.venv\Scripts\python ui.py
goto :ende
:keinpython
echo.
echo Python wurde nicht gefunden. Bitte Python 3.12 von python.org installieren
echo und im Installer "Add python.exe to PATH" anhaken. Danach start.bat erneut starten.
goto :ende
:fehler
echo.
echo Die Einrichtung ist fehlgeschlagen. Bitte die Meldungen oben an Claude schicken.
echo Beim naechsten Start von start.bat wird die Einrichtung neu versucht.
rmdir /s /q .venv 2>nul
:ende
