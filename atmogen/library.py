"""Sound-Bibliothek: einmal analysieren, danach durchsuchen.

Der Index liegt in ~/.atmogen/index/<hash>.json (nicht im Bibliotheksordner). Beim erneuten Scan
werden nur neue oder geänderte Dateien analysiert. Dateien ohne Endung (z. B. aus einem
Unity-Cache) werden am Dateikopf erkannt. IDs bleiben über Scans hinweg stabil, damit ein
gespeicherter plan.json gültig bleibt.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from core import AUDIO_EXT, db, sniff_ext

INDEX_DIR = Path.home() / ".atmogen" / "index"
ANALYZE_MAX_S = 90  # für die Messwerte reicht der Anfang langer Dateien
SKIP_EXT = {".json", ".txt", ".xml", ".png", ".jpg", ".jpeg", ".meta", ".db", ".dll", ".exe", ".asset",
            ".unity3d", ".manifest", ".log", ".ini", ".cfg", ".html", ".js", ".css"}


def is_audio_candidate(p: Path) -> bool:
    ext = p.suffix.lower()
    if ext in AUDIO_EXT:
        return True
    if ext in SKIP_EXT or p.stat().st_size < 2048:
        return False
    try:
        return sniff_ext(p) is not None
    except OSError:
        return False


def analyze_file(path: str) -> dict | None:
    """Läuft in Worker-Prozessen; liefert Messwerte oder None für Unlesbares."""
    try:
        info = sf.info(path)
        frames = min(info.frames, int(info.samplerate * ANALYZE_MAX_S))
        x, sr = sf.read(path, frames=frames, dtype="float32", always_2d=True)
    except Exception:  # noqa: BLE001 - kein Audio oder kaputt
        return None
    if len(x) == 0:
        return None
    mono = x.mean(axis=1)
    win = max(1, int(sr * 0.1))
    n = len(mono) // win
    if n == 0:
        return None
    frames_ = mono[: n * win].reshape(n, win)
    st_rms = 10 * np.log10(np.maximum(np.mean(frames_**2, axis=1), 1e-18))
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(mono**2)))
    return {
        "duration_s": round(info.frames / info.samplerate, 2),
        "channels": info.channels,
        "samplerate": info.samplerate,
        "rms_db": round(db(rms), 1),
        "peak_db": round(db(peak), 1),
        "crest_db": round(db(peak) - db(rms), 1),
        "dynamics_db": round(float(np.std(st_rms)), 1),
        "active_ratio": round(float(np.mean(st_rms > st_rms.max() - 20)), 2),
    }


class LibraryIndex:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        key = hashlib.sha1(str(self.root).lower().encode()).hexdigest()[:16]
        self.file = INDEX_DIR / f"{key}.json"
        self.emb_file = INDEX_DIR / f"{key}.clap.npz"
        self.entries: dict[int, dict] = {}
        self._emb: dict[int, np.ndarray] | None = None
        self.scanned_at: float | None = None
        self._load()

    # ------------------------------------------------------------------ Laden/Speichern
    def _load(self) -> None:
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        self.entries = {e["id"]: e for e in data.get("entries", [])}
        self.scanned_at = data.get("scanned_at")

    def _save(self) -> None:
        INDEX_DIR.mkdir(parents=True, exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"root": str(self.root), "scanned_at": self.scanned_at,
                                   "entries": sorted(self.entries.values(), key=lambda e: e["id"])},
                                  ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.file)

    # ------------------------------------------------------------------ Scan
    def scan(self, progress: Callable[[str, int, int], None] = lambda *a: None, workers: int | None = None) -> dict:
        if not self.root.is_dir():
            raise RuntimeError(f"Ordner nicht gefunden: {self.root}")
        progress("Suche Dateien …", 0, 0)
        by_rel = {e["rel"]: e for e in self.entries.values()}
        todo, keep = [], {}
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for name in filenames:
                p = Path(dirpath) / name
                try:
                    st = p.stat()
                except OSError:
                    continue
                rel = p.relative_to(self.root).as_posix()
                old = by_rel.get(rel)
                if old and old["size"] == st.st_size and old["mtime"] == int(st.st_mtime):
                    keep[old["id"]] = old
                elif is_audio_candidate(p):
                    todo.append((rel, st.st_size, int(st.st_mtime), old["id"] if old else None))

        todo.sort()
        workers = workers or max(1, (os.cpu_count() or 2) - 1)
        progress(f"Analysiere {len(todo)} Dateien …", 0, len(todo))
        feats_by_rel: dict[str, dict | None] = {}
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(analyze_file, str(self.root / t[0])): t[0] for t in todo}
            for i, fut in enumerate(as_completed(futures), 1):
                feats_by_rel[futures[fut]] = fut.result()
                if i % 25 == 0 or i == len(todo):
                    progress(f"Analysiere … {i}/{len(todo)}", i, len(todo))

        # neue IDs in Pfad-Reihenfolge vergeben, damit sie nicht vom Analysetempo abhängen
        next_id = max([*self.entries, -1]) + 1
        new_entries = dict(keep)
        added = failed = 0
        for rel, size, mtime, fid in todo:
            feats = feats_by_rel.get(rel)
            if not feats:
                failed += 1
                continue
            if fid is None:
                fid, next_id = next_id, next_id + 1
            new_entries[fid] = {"id": fid, "rel": rel, "size": size, "mtime": mtime, **feats}
            added += 1
        removed = len(self.entries) - len(keep) - sum(1 for t in todo if t[3] is not None)
        self.entries = new_entries
        self.scanned_at = time.time()
        self._save()
        return {"files": len(self.entries), "analyzed": added, "unreadable": failed, "removed": max(removed, 0),
                "hours": round(sum(e["duration_s"] for e in self.entries.values()) / 3600, 1)}

    # ------------------------------------------------------------------ Zugriff
    def path(self, fid: int) -> Path:
        return self.root / self.entries[fid]["rel"]

    def paths(self, ids) -> dict[int, Path]:
        return {i: self.path(i) for i in ids if i in self.entries}

    def in_folder(self, folder: str) -> list[dict]:
        folder = folder.strip("/").lower()
        return [e for e in self.entries.values()
                if not folder or e["rel"].lower().startswith(folder + "/") or e["rel"].lower() == folder]

    def catalog(self, entries: list[dict]) -> list[dict]:
        """Format wie core.analyze, für Heuristik und Anzeige."""
        keys = ("duration_s", "channels", "samplerate", "rms_db", "peak_db", "crest_db", "dynamics_db", "active_ratio")
        return [{"id": e["id"], "file": e["rel"], **{k: e[k] for k in keys}} for e in entries]

    @staticmethod
    def line(e: dict) -> str:
        kind = "durchg." if e["active_ratio"] > 0.7 else ("kurz" if e["duration_s"] < 4 else "vereinz.")
        ch = "st" if e["channels"] >= 2 else "mo"
        text = f"{e['id']}|{e['rel']}|{e['duration_s']:.1f}s {ch} {kind}|{e['rms_db']:.0f}dB"
        if e.get("tags"):
            text += f"|{', '.join(e['tags'])}; {e.get('space', '?')}"
        return text

    def folder_tree(self, folder: str = "", depth: int = 2, max_lines: int = 300) -> str:
        """Unterordner mit Dateianzahl und Gesamtdauer (für den Überblick)."""
        base = folder.strip("/")
        stats: dict[str, list[float]] = {}
        loose = 0
        for e in self.in_folder(base):
            rel = e["rel"][len(base) + 1:] if base else e["rel"]
            parts = rel.split("/")[:-1]
            if not parts:
                loose += 1
            for d in range(1, min(depth, len(parts)) + 1):
                s = stats.setdefault("/".join(parts[:d]), [0, 0.0])
                s[0] += 1
                s[1] += e["duration_s"]
        lines = [f"{'  ' * k.count('/')}{k.split('/')[-1]}/  ({n} Dateien, {dur / 60:.0f} min)"
                 for k, (n, dur) in sorted(stats.items())]
        if len(lines) > max_lines:
            lines = lines[:max_lines] + [f"… {len(lines) - max_lines} weitere Ordner (list_folder nutzen)"]
        head = f"Ordner '{base or '/'}': {loose} Dateien direkt darin"
        return "\n".join([head, *lines])

    def list_folder(self, folder: str, max_files: int = 40) -> str:
        base = folder.strip("/")
        direct = [e for e in self.in_folder(base) if e["rel"].rsplit("/", 1)[0] == base or (not base and "/" not in e["rel"])]
        out = [self.folder_tree(base, depth=1, max_lines=60), "", f"Dateien direkt in '{base or '/'}':"]
        out += [self.line(e) for e in sorted(direct, key=lambda e: e["rel"])[:max_files]]
        if len(direct) > max_files:
            out.append(f"… {len(direct) - max_files} weitere (search_library mit folder nutzen)")
        return "\n".join(out)

    def filtered(self, folder: str = "", min_duration: float = 0, max_duration: float = 0,
                 continuous: str = "any") -> list[dict]:
        out = []
        for e in self.in_folder(folder):
            if min_duration and e["duration_s"] < min_duration:
                continue
            if max_duration and e["duration_s"] > max_duration:
                continue
            if continuous == "yes" and e["active_ratio"] <= 0.7:
                continue
            if continuous == "no" and e["active_ratio"] > 0.7:
                continue
            out.append(e)
        return out

    def search(self, query: str, folder: str = "", min_duration: float = 0, max_duration: float = 0,
               continuous: str = "any", limit: int = 40) -> str:
        terms = [t for t in re.split(r"[\s,;|]+", query.lower()) if t]
        hits = []
        for e in self.filtered(folder, min_duration, max_duration, continuous):
            rel = e["rel"].lower()
            name = rel.rsplit("/", 1)[-1]
            score = sum(3 if t in name else 1 for t in terms if t in rel) if terms else 1
            if score:
                hits.append((score, e))
        hits.sort(key=lambda h: (-h[0], h[1]["rel"]))
        limit = max(1, min(int(limit or 20), 40))
        lines = [self.line(e) for _, e in hits[:limit]]
        more = f"\n… {len(hits) - limit} weitere Treffer" if len(hits) > limit else ""
        return (f"{len(hits)} Treffer für '{query}'" + (f" in '{folder}'" if folder else "") + ":\n"
                + "\n".join(lines) + more) if hits else f"Keine Treffer für '{query}'."

    # ------------------------------------------------------------------ CLAP (optional)
    def embeddings(self) -> dict[int, np.ndarray]:
        if self._emb is None:
            self._emb = {}
            try:
                with np.load(self.emb_file) as d:
                    self._emb = {int(i): v.astype(np.float32) for i, v in zip(d["ids"], d["emb"])}
            except (OSError, KeyError, ValueError):
                pass
        return self._emb

    def _save_emb(self) -> None:
        emb = self.embeddings()
        ids = np.array(sorted(emb), dtype=np.int64)
        mat = np.stack([emb[i] for i in ids]).astype(np.float16) if len(ids) else np.zeros((0, 512), np.float16)
        tmp = self.emb_file.with_suffix(".tmp.npz")
        with open(tmp, "wb") as f:
            np.savez(f, ids=ids, emb=mat)
        tmp.replace(self.emb_file)

    def clap_count(self) -> int:
        emb = self.embeddings()
        return sum(1 for e in self.entries.values() if e["id"] in emb and e.get("clap_mtime") == e["mtime"])

    def clap_scan(self, progress: Callable[[str, int, int], None] = lambda *a: None) -> dict:
        import clap

        progress("Lade CLAP-Modell (beim ersten Mal Download, ca. 800 MB) …", 0, 0)
        model = clap.get_model()
        emb = self.embeddings()
        for fid in [i for i in emb if i not in self.entries]:
            del emb[fid]
        todo = [e for e in self.entries.values() if e["id"] not in emb or e.get("clap_mtime") != e["mtime"]]
        vocab = model.embed_text(clap.VOCAB)
        spaces = model.embed_text(clap.SPACES)
        started = time.time()
        for i, e in enumerate(todo, 1):
            v = clap.embed_files(model, [str(self.root / e["rel"])])[0]
            if v is not None:
                emb[e["id"]] = v
                e["tags"] = [clap.VOCAB[j] for j in np.argsort(vocab @ v)[::-1][:3]]
                e["space"] = clap.SPACES[int(np.argmax(spaces @ v))]
                e["clap_mtime"] = e["mtime"]
            if i % 10 == 0 or i == len(todo):
                eta = (time.time() - started) / i * (len(todo) - i)
                progress(f"Inhaltsanalyse … {i}/{len(todo)} (noch ca. {eta / 60:.0f} min)", i, len(todo))
            if i % 200 == 0:  # Zwischenstand sichern, damit ein Abbruch nicht alles verliert
                self._save_emb()
                self._save()
        self._save_emb()
        self._save()
        return {"clap_analyzed": len(todo), "clap_files": self.clap_count()}

    def _emb_candidates(self, folder: str, min_duration: float, max_duration: float, continuous: str):
        emb = self.embeddings()
        cands = [e for e in self.filtered(folder, min_duration, max_duration, continuous) if e["id"] in emb]
        if not cands:
            return [], np.zeros((0, 1), np.float32)
        return cands, np.stack([emb[e["id"]] for e in cands])

    def search_sound(self, description: str, folder: str = "", min_duration: float = 0, max_duration: float = 0,
                     continuous: str = "any", limit: int = 30) -> str:
        import clap

        cands, mat = self._emb_candidates(folder, min_duration, max_duration, continuous)
        if not cands:
            return "Keine Dateien mit Inhaltsanalyse in diesem Bereich."
        q = clap.get_model().embed_text([description])[0]
        return self._ranked(cands, mat @ q, limit, f"Klang wie '{description}'")

    def similar(self, fid: int, folder: str = "", min_duration: float = 0, max_duration: float = 0,
                continuous: str = "any", limit: int = 20) -> str:
        emb = self.embeddings()
        if fid not in emb:
            return f"Datei {fid} hat keine Inhaltsanalyse."
        cands, mat = self._emb_candidates(folder, min_duration, max_duration, continuous)
        keep = [i for i, e in enumerate(cands) if e["id"] != fid]
        cands, mat = [cands[i] for i in keep], mat[keep]
        return self._ranked(cands, mat @ emb[fid], limit, f"ähnlich wie {fid} ({self.entries[fid]['rel']})")

    def _ranked(self, cands: list[dict], sims: np.ndarray, limit: int, title: str) -> str:
        limit = max(1, min(int(limit or 20), 40))
        order = np.argsort(sims)[::-1][:limit]
        lines = [f"Ähnlichkeit {sims[i]:.2f} | {self.line(cands[i])}" for i in order]
        return f"{title}, beste {len(lines)} von {len(cands)}:\n" + "\n".join(lines)

    def fit_check(self, ids: list[int]) -> str:
        """Wie gut passen die Dateien klanglich zusammen? Markiert Ausreißer."""
        emb = self.embeddings()
        ids = [i for i in dict.fromkeys(ids) if i in emb]
        if len(ids) < 2:
            return "Zu wenige Dateien mit Inhaltsanalyse für einen Vergleich."
        mat = np.stack([emb[i] for i in ids])
        sim = mat @ mat.T
        mean = (sim.sum(axis=1) - 1) / (len(ids) - 1)
        median = float(np.median(mean))
        spaces = [self.entries[i].get("space", "?") for i in ids]
        common = max(set(spaces), key=spaces.count)
        lines = [f"Raumcharakter überwiegend: {common}; mittlere Ähnlichkeit {median:.2f}"]
        for k in np.argsort(mean):
            fid = ids[k]
            flags = []
            if mean[k] < median - 0.12:
                flags.append("klingt deutlich anders als der Rest")
            if spaces[k] != common:
                flags.append(f"anderer Raum ({spaces[k]})")
            lines.append(f"{fid} | {self.entries[fid]['rel']} | Ähnlichkeit zum Rest {mean[k]:.2f}"
                         + (f" | ACHTUNG: {', '.join(flags)}" if flags else ""))
        return "\n".join(lines)
