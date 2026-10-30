#!/usr/bin/env python3
"""atmogen UI: lokale Weboberfläche. Start mit `python ui.py`, danach öffnet sich der Browser.

Der Server lauscht nur auf 127.0.0.1. Ein eingegebener API-Key bleibt im Speicher; mit "merken"
landet er in ~/.atmogen/config.json (Klartext, nur für den eigenen Rechner gedacht).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import core

HERE = Path(__file__).resolve().parent
CONFIG = Path.home() / ".atmogen" / "config.json"
PORT = int(os.environ.get("ATMOGEN_PORT", "8765"))

state = {"api_key": None, "sources": {}, "out_dirs": set()}
lock = threading.Lock()


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    try:
        CONFIG.chmod(0o600)
    except OSError:
        pass


def api_key() -> tuple[str | None, str | None]:
    if state["api_key"]:
        return state["api_key"], "eingegeben"
    if load_config().get("api_key"):
        return load_config()["api_key"], "gespeichert"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return None, "Umgebungsvariable"  # SDK liest sie selbst
    return None, None


def source_entry(source: str, out: str, log) -> dict:
    """Analysiert einen Quellordner einmal pro Sitzung (bzw. erneut, wenn sich das Ziel ändert)."""
    key = (str(Path(source).resolve()), str(Path(out).resolve()))
    with lock:
        entry = state["sources"].get(key)
    if entry is None:
        catalog, paths = core.load_source(Path(source), Path(out), log)
        entry = {"catalog": catalog, "paths": paths}
        with lock:
            state["sources"][key] = entry
    return entry


# --------------------------------------------------------------------------- Handler


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # ruhige Konsole
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path in ("/", "/index.html"):
                body = (HERE / "ui" / "index.html").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif url.path == "/api/state":
                _, src = api_key()
                self._json({"key_source": src})
            elif url.path == "/api/browse":
                self._json(browse(q.get("path") or str(Path.home())))
            elif url.path == "/api/file":
                self._file(Path(q.get("path", "")))
            else:
                self._json({"error": "nicht gefunden"}, 404)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        url = urlparse(self.path)
        logs: list[str] = []
        try:
            data = self._body()
            if url.path == "/api/key":
                self._json(set_key(data))
            elif url.path == "/api/plan":
                self._json(plan(data, logs.append) | {"log": logs})
            elif url.path == "/api/render":
                self._json(render(data, logs.append) | {"log": logs})
            elif url.path == "/api/reveal":
                reveal(Path(data["path"]))
                self._json({"ok": True})
            else:
                self._json({"error": "nicht gefunden"}, 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": f"{type(e).__name__}: {e}", "log": logs}, 500)

    def _file(self, path: Path):
        path = path.resolve()
        if not any(path.is_relative_to(d) for d in state["out_dirs"]) or not path.is_file():
            self._json({"error": "Datei nicht freigegeben"}, 403)
            return
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav" if path.suffix == ".wav" else "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(path, "rb") as f:
            while chunk := f.read(1 << 20):
                self.wfile.write(chunk)


# --------------------------------------------------------------------------- Aktionen


def browse(path: str) -> dict:
    p = Path(path).expanduser()
    if not p.is_dir():
        p = Path.home()
    p = p.resolve()
    dirs, audio = [], 0
    try:
        for c in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if c.name.startswith("."):
                continue
            if c.is_dir():
                dirs.append(c.name)
            elif c.suffix.lower() in core.AUDIO_EXT:
                audio += 1
    except PermissionError:
        pass
    roots = [f"{d}:\\" for d in "CDEFGHIJ" if Path(f"{d}:\\").exists()] if os.name == "nt" else ["/"]
    return {"path": str(p), "parent": str(p.parent), "dirs": dirs, "audio_count": audio, "roots": roots}


def set_key(data: dict) -> dict:
    key = (data.get("api_key") or "").strip()
    state["api_key"] = key or None
    cfg = load_config()
    if data.get("remember") and key:
        cfg["api_key"] = key
        save_config(cfg)
    elif not data.get("remember") and "api_key" in cfg:
        cfg.pop("api_key")
        save_config(cfg)
    return {"key_source": api_key()[1]}


def plan(data: dict, log) -> dict:
    entry = source_entry(data["source"], data["out"], log)
    scenes = [s for s in data.get("scenes", []) if s.strip()] or ["wenig los", "mittel", "voll"]
    if data.get("use_llm", True):
        key, src = api_key()
        if src is None:
            raise RuntimeError("Kein API-Key: bitte eingeben oder 'ohne Claude' wählen.")
        log(f"Claude plant {len(scenes)} Szenen ...")
        p = core.plan_with_claude(entry["catalog"], scenes, float(data.get("length", 120)),
                                  data.get("instructions", ""), key)
    else:
        p = core.plan_heuristic(entry["catalog"], scenes)
    return {"plan": p, "catalog": entry["catalog"]}


def render(data: dict, log) -> dict:
    entry = source_entry(data["source"], data["out"], log)
    out = Path(data["out"]).resolve()
    with lock:
        state["out_dirs"].add(out)
    results = core.render_all(
        data["plan"], entry["paths"], out,
        length=float(data.get("length", 120)), sr=int(data.get("sr", 48000)), seed=int(data.get("seed", 1)),
        loop=bool(data.get("loop", True)), aaf_mode=data.get("aaf_mode", "none"),
        aaf_layout=data.get("aaf_layout", "dualmono"), reaper_lua=bool(data.get("reaper_lua")), log=log,
    )
    return {"results": results, "out": str(out)}


def reveal(path: Path) -> None:
    path = path.resolve()
    if not any(path.is_relative_to(d) for d in state["out_dirs"]):
        raise RuntimeError("Ordner nicht freigegeben")
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606 - lokaler Ordner aus eigener Ausgabe
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"atmogen läuft auf {url}  (beenden mit Strg+C)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
