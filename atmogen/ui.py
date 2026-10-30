#!/usr/bin/env python3
"""atmogen UI: lokale Weboberfläche. Start mit `python ui.py`, danach öffnet sich der Browser.

Der Server lauscht nur auf 127.0.0.1. Ein eingegebener API-Key bleibt im Speicher; mit "merken"
landet er in ~/.atmogen/config.json (Klartext, nur für den eigenen Rechner gedacht).
Lange Aufgaben (Scan, Planen, Rendern) laufen als Jobs im Hintergrund; das UI fragt den Stand ab.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import core
from library import LibraryIndex

HERE = Path(__file__).resolve().parent
CONFIG = Path.home() / ".atmogen" / "config.json"
PORT = int(os.environ.get("ATMOGEN_PORT", "8765"))

state = {"api_key": None, "indexes": {}, "out_dirs": set(), "jobs": {}}
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


def get_index(root: str) -> LibraryIndex:
    key = str(Path(root).expanduser().resolve()).lower()
    with lock:
        if key not in state["indexes"]:
            state["indexes"][key] = LibraryIndex(root)
        return state["indexes"][key]


# --------------------------------------------------------------------------- Jobs


def start_job(fn, data: dict) -> str:
    jid = uuid.uuid4().hex[:10]
    job = {"status": "running", "log": [], "progress": None, "result": None, "error": None}
    state["jobs"][jid] = job

    def log(msg: str) -> None:
        job["log"].append(msg)

    def progress(msg: str, done: int, total: int) -> None:
        job["progress"] = {"msg": msg, "done": done, "total": total}

    def run() -> None:
        try:
            job["result"] = fn(data, log, progress)
            job["status"] = "done"
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job["error"] = f"{type(e).__name__}: {e}"
            job["status"] = "error"

    threading.Thread(target=run, daemon=True).start()
    return jid


def job_scan(data: dict, log, progress) -> dict:
    index = get_index(data["root"])
    if data.get("clap"):
        import clap

        err = clap.missing_dependencies()
        if err:
            raise RuntimeError(err)
    stats = index.scan(progress)
    if data.get("clap"):
        stats |= index.clap_scan(progress)
    return stats | library_info(index)


def job_plan(data: dict, log, progress) -> dict:
    index = get_index(data["root"])
    if not index.entries:
        raise RuntimeError("Bibliothek ist noch nicht analysiert.")
    folder = data.get("folder", "").strip().strip("/\\").replace("\\", "/")
    scenes = [s for s in data.get("scenes", []) if s.strip()] or ["wenig los", "mittel", "voll"]
    length = float(data.get("length", 120))
    if data.get("use_llm", True):
        key, src = api_key()
        if src is None:
            raise RuntimeError("Kein API-Key: bitte eingeben oder 'ohne Claude' wählen.")
        from planner import plan_from_library

        log(f"Claude stellt die Atmo aus {len(index.in_folder(folder))} Dateien zusammen …")
        plan = plan_from_library(index, data.get("request", ""), scenes, length, folder, key, log)
    else:
        if not folder:
            raise RuntimeError("Ohne Claude bitte einen Unterordner angeben, der nur die passenden Sounds enthält.")
        plan = core.plan_heuristic(index.catalog(index.in_folder(folder)), scenes)
    return {"plan": plan, "files": plan_files(index, plan)}


def job_render(data: dict, log, progress) -> dict:
    index = get_index(data["root"])
    plan = data["plan"]
    out = Path(data["out"]).expanduser().resolve()
    with lock:
        state["out_dirs"].add(out)
    used = {f["id"] for f in plan["files"]}
    results = core.render_all(
        plan, index.paths(used), out,
        length=float(data.get("length", 120)), sr=int(data.get("sr", 48000)), seed=int(data.get("seed", 1)),
        loop=bool(data.get("loop", True)), aaf_mode=data.get("aaf_mode", "none"),
        aaf_layout=data.get("aaf_layout", "dualmono"), reaper_lua=bool(data.get("reaper_lua")),
        rpp=bool(data.get("rpp", True)), log=log,
    )
    return {"results": results, "out": str(out), "files": plan_files(index, plan)}


def plan_files(index: LibraryIndex, plan: dict) -> list[dict]:
    out = []
    for f in plan["files"]:
        e = index.entries.get(f["id"])
        if e:
            out.append({"id": f["id"], "rel": e["rel"], "duration_s": e["duration_s"], "role": f["role"],
                        "category": f["category"], "description": f.get("description", ""),
                        "tags": e.get("tags", []), "space": e.get("space", "")})
    return out


def library_info(index: LibraryIndex) -> dict:
    if not index.entries:
        return {"indexed": False}
    return {"indexed": True, "files": len(index.entries), "scanned_at": index.scanned_at,
            "clap_files": index.clap_count(),
            "hours": round(sum(e["duration_s"] for e in index.entries.values()) / 3600, 1),
            "tree": index.folder_tree("", depth=2, max_lines=200)}


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
                self._json({"key_source": api_key()[1]})
            elif url.path == "/api/library":
                self._json(library_info(get_index(q["root"])))
            elif url.path == "/api/job":
                job = state["jobs"].get(q.get("id", ""))
                self._json(job if job else {"status": "error", "error": "Job unbekannt"})
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
        try:
            data = self._body()
            if url.path == "/api/key":
                self._json(set_key(data))
            elif url.path in ("/api/scan", "/api/plan", "/api/render"):
                fn = {"/api/scan": job_scan, "/api/plan": job_plan, "/api/render": job_render}[url.path]
                self._json({"job": start_job(fn, data)})
            elif url.path == "/api/reveal":
                reveal(Path(data["path"]))
                self._json({"ok": True})
            else:
                self._json({"error": "nicht gefunden"}, 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": f"{type(e).__name__}: {e}"}, 500)

    def _file(self, path: Path):
        path = path.resolve()
        if not any(path.is_relative_to(d) for d in state["out_dirs"]) or not path.is_file():
            self._json({"error": "Datei nicht freigegeben"}, 403)
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav" if path.suffix == ".wav" else "application/octet-stream")
        self.send_header("Content-Length", str(path.stat().st_size))
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
