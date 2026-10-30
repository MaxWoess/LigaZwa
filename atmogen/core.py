"""atmogen core: Analyse, Planung (Claude oder Heuristik), Platzierung, Render und Export.

Datenmodell: Eine Szene besteht aus Clips (Bed-/Layer-Segmente und Events). Jeder Clip wird
"gebacken" (Tonhöhe, Gain, Pan, Fades eingerechnet). Dieselben gebackenen Clips landen im
Stereo-Mix und in den Session-Exporten (AAF, REAPER), daher klingt die Session exakt wie die WAV.

Für das Überblenden zwischen Szenen im interaktiven System gilt:
  - alle Szenen sind gleich lang,
  - Beds und Layer nutzen in jeder Szene dieselben Segmente (gleiche Startpunkte, gleiche
    Panoramaposition) und unterscheiden sich nur im Pegel bzw. darin, ob sie dabei sind,
  - mit loop=True ist jede Szene nahtlos loopbar: Layer werden zyklisch gecrossfadet und Events,
    die über das Ende hinausragen, laufen am Anfang weiter.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import sys
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

MODEL = "claude-opus-5-5"
AUDIO_EXT = {".wav", ".ogg", ".mp3", ".flac", ".aif", ".aiff", ".opus"}
XFADE_S = 2.0                # Crossfade an Layer-Nähten und am Loop-Punkt
BED_TARGET_RMS_DB = -28.0    # durchgehende Sounds werden vor dem Mix auf diesen RMS gebracht
EVENT_TARGET_PEAK_DB = -6.0  # Einzelereignisse auf diesen Spitzenpegel
OUTPUT_PEAK_DB = -1.0

Log = Callable[[str], None]

# --------------------------------------------------------------------------- Dateien & Analyse


def sniff_ext(path: Path) -> str | None:
    with open(path, "rb") as f:
        h = f.read(12)
    if h[:4] == b"OggS":
        return ".ogg"
    if h[:4] == b"RIFF" and h[8:12] == b"WAVE":
        return ".wav"
    if h[:4] == b"fLaC":
        return ".flac"
    if h[:4] == b"FORM":
        return ".aiff"
    if h[:3] == b"ID3" or (len(h) > 1 and h[0] == 0xFF and h[1] >= 0xE0):
        return ".mp3"
    return None


def collect_files(src: Path, media_dir: Path) -> list[Path]:
    """Alle Audiodateien; solche ohne passende Endung werden mit Endung nach media_dir kopiert."""
    out = []
    for p in sorted(src.rglob("*")):
        if not p.is_file():
            continue
        if p.suffix.lower() in AUDIO_EXT:
            out.append(p)
            continue
        ext = sniff_ext(p)
        if ext:
            media_dir.mkdir(parents=True, exist_ok=True)
            dst = media_dir / (p.name + ext)
            if not dst.exists():
                shutil.copyfile(p, dst)
            out.append(dst)
    return out


def load_stereo(path: Path) -> tuple[np.ndarray, int]:
    x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    return x[:, :2], sr


def db(v: float) -> float:
    return 20 * math.log10(max(v, 1e-9))


def analyze(path: Path, rel: str, idx: int, log: Log = print) -> dict | None:
    try:
        x, sr = load_stereo(path)
    except Exception as e:  # noqa: BLE001 - unlesbare Datei überspringen
        log(f"übersprungen ({e}): {rel}")
        return None
    mono = x.mean(axis=1)
    win = max(1, int(sr * 0.1))
    n = len(mono) // win
    if n == 0:
        return None
    frames = mono[: n * win].reshape(n, win)
    st_rms = 10 * np.log10(np.maximum(np.mean(frames**2, axis=1), 1e-18))
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(mono**2)))
    return {
        "id": idx,
        "file": rel,
        "duration_s": round(len(x) / sr, 2),
        "channels": sf.info(str(path)).channels,
        "samplerate": sr,
        "rms_db": round(db(rms), 1),
        "peak_db": round(db(peak), 1),
        "crest_db": round(db(peak) - db(rms), 1),
        "dynamics_db": round(float(np.std(st_rms)), 1),
        # Anteil der 100-ms-Fenster, die höchstens 20 dB unter dem lautesten liegen:
        # nahe 1 = durchgehender Sound, klein = einzelnes Ereignis mit Stille drumherum
        "active_ratio": round(float(np.mean(st_rms > st_rms.max() - 20)), 2),
    }


def scan_source(source: Path, work: Path, log: Log = print) -> tuple[list[dict], dict[int, Path]]:
    files = collect_files(source, work / "media")
    catalog, paths = [], {}
    for p in files:
        rel = str(p.relative_to(source)) if p.is_relative_to(source) else p.name
        a = analyze(p, rel, len(catalog), log)
        if a:
            catalog.append(a)
            paths[a["id"]] = p
    return catalog, paths


# --------------------------------------------------------------------------- Planung mit Claude

def _obj(props: dict) -> dict:
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


NUM, INT, STR = {"type": "number"}, {"type": "integer"}, {"type": "string"}
PLAN_SCHEMA = _obj({
    "files": {"type": "array", "items": _obj({
        "id": INT,
        "role": {"type": "string", "enum": ["bed", "layer", "event", "skip"]},
        "category": STR,
        "description": STR,
    })},
    "scenes": {"type": "array", "items": _obj({
        "name": STR,
        "slug": STR,
        "notes": STR,
        "beds": {"type": "array", "items": _obj({"id": INT, "gain_db": NUM})},
        "layers": {"type": "array", "items": _obj({"id": INT, "gain_db": NUM, "pan": NUM, "width": NUM})},
        "event_groups": {"type": "array", "items": _obj({
            "category": STR, "ids": {"type": "array", "items": INT}, "rate_per_min": NUM,
            "gain_db_min": NUM, "gain_db_max": NUM, "pan_spread": NUM, "min_gap_s": NUM, "pitch_var": NUM,
        })},
    })},
})

SYSTEM_PROMPT = f"""Du bist Sounddesigner für Atmosphären (Ambiences) und planst Mischungen aus einer
Sammlung von Einzelsounds. Ein Programm setzt deinen Plan danach exakt um; du lieferst nur den Plan.

Einsatz: Die Szenen sind Zustände derselben Umgebung in einem interaktiven Musiksystem. Ein Regler
blendet zwischen ihnen über (z. B. wie viele Menschen im Raum sind). Jede Szene loopt nahtlos, hat
also keinen Anfang und kein Ende, keine Intros, keine Ausklänge.
Damit das Überblenden glaubwürdig bleibt:
- Beds sind in allen Szenen dieselben (Pegel darf sich leicht ändern).
- Ein Layer, der in mehreren Szenen vorkommt, behält überall dieselbe pan und width; dichtere Szenen
  fügen Layer hinzu und heben Pegel an, statt Layer umzusetzen.
- Die Szenen unterscheiden sich klar und stufenlos plausibel in der Dichte.

Rollen pro Datei:
- bed: durchgehender Grundsound (Roomtone, Luft, Klimaanlage). Läuft über die ganze Länge.
- layer: durchgehende, aber belebte Schicht (Stimmengemurmel, Walla, Küchenbetrieb). Wird aus
  Segmenten mit zufälligen Startpunkten zusammengesetzt; mehrere Layer an verschiedenen
  Panoramapositionen ergeben eine dichtere Menge.
- event: einzelnes Ereignis (Glas, Teller, Besteck, Husten, Lachen, Stuhlrücken). Wird zufällig verteilt.
- skip: passt nicht in die Szenen oder ist unbrauchbar.
Kurze Dateien mit kleinem active_ratio sind fast immer Events. Einen Husten oder ein einzelnes
Lachen niemals als bed/layer verwenden.

Pegel: Vor dem Mix werden bed/layer auf {BED_TARGET_RMS_DB:.0f} dBFS RMS und Events auf
{EVENT_TARGET_PEAK_DB:.0f} dBFS Peak normalisiert. gain_db ist relativ dazu (typisch -20 bis +3).
pan: -1 links bis +1 rechts. width: Stereobreite eines Layers (0 mono bis 1 original).
rate_per_min: mittlere Ereignisse pro Minute der Gruppe. min_gap_s: Mindestabstand zwischen zwei
Events derselben Gruppe. pan_spread: Events streuen zufällig in [-pan_spread, +pan_spread].
pitch_var: maximale Abspielraten-Abweichung (0.03 = ±3 %), damit Wiederholungen nicht auffallen.
Auffällige Ereignisse (Husten, Lachen, Scherben) sparsam einsetzen, sonst erkennt man den Loop.

Gib genau eine Szene pro gewünschter Szene in derselben Reihenfolge zurück. slug: kurzer
Dateiname in Kleinbuchstaben ohne Leerzeichen. notes: ein Satz zu deiner Idee für die Szene."""


def plan_with_claude(catalog: list[dict], scenes: list[str], length: float, instructions: str = "",
                     api_key: str | None = None) -> dict:
    import anthropic

    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()
    user = (
        f"Länge jeder Szene: {length:.0f} Sekunden.\n"
        "Szenen (in dieser Reihenfolge):\n" + "\n".join(f"- {s}" for s in scenes)
    )
    if instructions.strip():
        user += "\n\nWünsche zum Klang der Session:\n" + instructions.strip()
    user += "\n\nDateien (Messwerte vom Analysator):\n" + json.dumps(catalog, ensure_ascii=False, indent=1)

    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=32000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": PLAN_SCHEMA}},
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user}],
    ) as stream:
        response = stream.get_final_message()
    if response.stop_reason == "refusal":
        raise RuntimeError("Claude hat die Anfrage abgelehnt; ohne Claude (Heuristik) geht es trotzdem.")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Antwort abgeschnitten (max_tokens); weniger Dateien oder Szenen probieren.")
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)


# --------------------------------------------------------------------------- Heuristik ohne LLM

KEYWORDS = [
    ("bed", "roomtone", ["roomtone", "room tone", "room", "air", "ambien", "ambi", "hum", "hvac", "fridge", "tone"]),
    ("layer", "crowd", ["murmur", "walla", "crowd", "chatter", "people", "talk", "voices", "babble"]),
    ("event", "glass", ["glass", "glas", "clink", "toast", "cheers"]),
    ("event", "plates", ["plate", "teller", "dish", "geschirr", "bowl"]),
    ("event", "cutlery", ["cutlery", "besteck", "fork", "knife", "spoon", "gabel", "messer"]),
    ("event", "cough", ["cough", "husten", "sneeze"]),
    ("event", "laugh", ["laugh", "lach"]),
    ("event", "chair", ["chair", "stuhl"]),
    ("event", "door", ["door", "tür", "tuer", "bell"]),
]
RARE = {"cough", "laugh", "door"}


def slugify(s: str, fallback: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_") or fallback


def plan_heuristic(catalog: list[dict], scenes: list[str]) -> dict:
    files = []
    for f in catalog:
        name = f["file"].lower()
        role, cat = None, None
        for r, c, words in KEYWORDS:
            if any(w in name for w in words):
                role, cat = r, c
                break
        if role is None:
            continuous = f["duration_s"] >= 15 and f["active_ratio"] > 0.7
            role, cat = ("layer", "misc_layer") if continuous else ("event", "misc")
        if role in ("bed", "layer") and f["duration_s"] < 5:
            role = "event"
        files.append({"id": f["id"], "role": role, "category": cat, "description": "heuristisch"})

    beds = [f for f in files if f["role"] == "bed"]
    layers = [f for f in files if f["role"] == "layer"]
    cats: dict[str, list[int]] = {}
    for f in files:
        if f["role"] == "event":
            cats.setdefault(f["category"], []).append(f["id"])
    # feste Panoramapositionen pro Layer, damit Überblenden nicht springt
    pans = np.linspace(-0.7, 0.7, len(layers)) if len(layers) > 1 else [0.3]
    order = sorted(range(len(layers)), key=lambda i: abs(pans[i]), reverse=True)  # außen zuerst

    out_scenes = []
    n = len(scenes)
    for i, name in enumerate(scenes):
        k = i / (n - 1) if n > 1 else 0.5  # 0 = ruhig ... 1 = voll
        n_layers = max(1, round(1 + k * (len(layers) - 1))) if layers else 0
        groups = []
        for cat, ids in cats.items():
            base = 0.5 + 2 * k if cat in RARE else 2 + 14 * k
            groups.append({
                "category": cat, "ids": ids, "rate_per_min": round(base, 1),
                "gain_db_min": -14 + 4 * k, "gain_db_max": -6 + 4 * k,
                "pan_spread": round(0.5 + 0.4 * k, 2), "min_gap_s": 4.0 if cat in RARE else 0.6,
                "pitch_var": 0.03,
            })
        out_scenes.append({
            "name": name,
            "slug": slugify(name, f"szene_{i + 1}"),
            "notes": f"heuristisch, Dichte {k:.2f}",
            "beds": [{"id": b["id"], "gain_db": -3.0} for b in beds],
            "layers": [
                {"id": layers[j]["id"], "gain_db": round(-10 + 6 * k, 1), "pan": float(pans[j]), "width": 0.8}
                for j in sorted(order[:n_layers])
            ],
            "event_groups": groups,
        })
    return {"files": files, "scenes": out_scenes}


# --------------------------------------------------------------------------- DSP-Bausteine


def resample(x: np.ndarray, sr_in: float, sr_out: float, rate: float = 1.0) -> np.ndarray:
    step = sr_in * rate / sr_out
    if abs(step - 1.0) < 1e-9:
        return x
    n_out = int(len(x) / step)
    t = np.arange(n_out) * step
    src = np.arange(len(x))
    return np.stack([np.interp(t, src, x[:, c]) for c in range(x.shape[1])], axis=1).astype(np.float32)


def fade_curves(n: int) -> tuple[np.ndarray, np.ndarray]:
    """Equal-power Ein- und Ausblendkurve (für unkorrelierte Signale gleichbleibende Lautheit)."""
    t = np.linspace(0, np.pi / 2, n, dtype=np.float32)[:, None]
    return np.sin(t), np.cos(t)


def pan_width(x: np.ndarray, pan: float, width: float = 1.0) -> np.ndarray:
    mid = (x[:, 0] + x[:, 1]) * 0.5
    side = (x[:, 0] - x[:, 1]) * 0.5 * float(np.clip(width, 0, 1))
    left, right = mid + side, mid - side
    a = (float(np.clip(pan, -1, 1)) + 1) * np.pi / 4
    return np.stack([left * np.cos(a) * math.sqrt(2), right * np.sin(a) * math.sqrt(2)], axis=1)


class Library:
    """Lädt Dateien einmal, resampled auf die Zielrate und kennt die Normalisierungs-Gains."""

    def __init__(self, paths: dict[int, Path], roles: dict[int, str], sr: int):
        self.paths, self.roles, self.sr = paths, roles, sr
        self._audio: dict[int, np.ndarray] = {}
        self._norm: dict[int, float] = {}

    def audio(self, fid: int) -> np.ndarray:
        if fid not in self._audio:
            x, sr = load_stereo(self.paths[fid])
            self._audio[fid] = resample(x, sr, self.sr)
        return self._audio[fid]

    def duration(self, fid: int) -> float:
        return len(self.audio(fid)) / self.sr

    def norm_db(self, fid: int) -> float:
        if fid not in self._norm:
            x = self.audio(fid)
            if self.roles.get(fid) == "event":
                self._norm[fid] = EVENT_TARGET_PEAK_DB - db(float(np.max(np.abs(x))))
            else:
                self._norm[fid] = BED_TARGET_RMS_DB - db(float(np.sqrt(np.mean(x**2))))
        return self._norm[fid]


# --------------------------------------------------------------------------- Platzierung


def continuous_segments(dur: float, length: float, rng: np.random.Generator) -> list[tuple[float, float, float, float]]:
    """Teilt eine durchgehende Spur in k gleich lange, überlappende Segmente.

    Das letzte Segment endet bei length + xfade; mit Loop wandert dieser Überhang an den Anfang
    und crossfadet dort mit dem ersten Segment. Liefert (pos, src_offs, len, xfade).
    """
    xf = min(XFADE_S, dur / 3)
    k = max(1, math.ceil(length / max(dur - xf, 1e-3)))
    seg_len = min(length / k + xf, dur)
    out = []
    for i in range(k):
        offs = float(rng.uniform(0, max(dur - seg_len, 0)))
        out.append((i * length / k, offs, seg_len, xf))
    return out


def consistent_layer_settings(plan: dict) -> dict[int, tuple[float, float]]:
    """pan/width pro Layer aus der ersten Szene, in der er vorkommt, für alle Szenen übernehmen."""
    fixed: dict[int, tuple[float, float]] = {}
    for scene in plan["scenes"]:
        for e in scene["layers"]:
            fixed.setdefault(e["id"], (float(e["pan"]), float(e["width"])))
    return fixed


def build_clips(scene: dict, scene_idx: int, lib: Library, length: float, seed: int,
                layer_pw: dict[int, tuple[float, float]]) -> list[dict]:
    clips = []
    for kind, entries in (("Bed", scene["beds"]), ("Layer", scene["layers"])):
        for e in entries:
            fid = e["id"]
            if fid not in lib.paths:
                continue
            # Zufall hängt nur von Seed und Datei ab: in jeder Szene dieselben Segmente
            rng = np.random.default_rng([seed, fid])
            pan, width = layer_pw.get(fid, (0.0, 1.0)) if kind == "Layer" else (0.0, 1.0)
            for pos, offs, seg_len, xf in continuous_segments(lib.duration(fid), length, rng):
                clips.append({
                    "track": f"{kind}: {lib.paths[fid].stem}", "file": fid, "pos": pos, "offs": offs,
                    "len": seg_len, "rate": 1.0, "gain_db": lib.norm_db(fid) + e["gain_db"],
                    "pan": pan, "width": width, "fade_in": xf, "fade_out": xf,
                })
    rng = np.random.default_rng([seed, 100_000 + scene_idx])
    for g in scene["event_groups"]:
        ids = [i for i in g["ids"] if i in lib.paths]
        if not ids or g["rate_per_min"] <= 0:
            continue
        t, last_t, last_id = 0.0, -1e9, None
        while True:
            t += rng.exponential(60.0 / g["rate_per_min"])
            t = max(t, last_t + g["min_gap_s"])
            if t >= length:
                break
            choices = [i for i in ids if i != last_id] or ids
            fid = int(rng.choice(choices))
            rate = float(1 + rng.uniform(-g["pitch_var"], g["pitch_var"]))
            clips.append({
                "track": f"Events: {g['category']}", "file": fid, "pos": t, "offs": 0.0,
                "len": min(lib.duration(fid) / rate, length), "rate": rate,
                "gain_db": lib.norm_db(fid) + float(rng.uniform(g["gain_db_min"], g["gain_db_max"])),
                "pan": float(rng.uniform(-g["pan_spread"], g["pan_spread"])), "width": 1.0,
                "fade_in": 0.002, "fade_out": 0.01,
            })
            last_t, last_id = t, fid
    return clips


def bake(clip: dict, lib: Library, master_db: float) -> np.ndarray:
    x = lib.audio(clip["file"])
    sr = lib.sr
    if clip["rate"] != 1.0:
        x = resample(x, sr, sr, clip["rate"])
    start = int(clip["offs"] * sr)
    seg = x[start : start + int(clip["len"] * sr)].copy()
    for key, rising in (("fade_in", True), ("fade_out", False)):
        n = min(int(clip[key] * sr), len(seg) // 2)
        if n > 0:
            fin, fout = fade_curves(n)
            if rising:
                seg[:n] *= fin
            else:
                seg[-n:] *= fout
    return pan_width(seg, clip["pan"], clip["width"]) * (10 ** ((clip["gain_db"] + master_db) / 20))


def place(pos: float, arr: np.ndarray, n: int, sr: int, loop: bool) -> list[tuple[int, np.ndarray]]:
    """Teilt einen Clip am Szenenende: mit Loop läuft der Überhang am Anfang weiter."""
    p = int(round(pos * sr))
    if p + len(arr) <= n:
        return [(p, arr)]
    head = arr[: n - p]
    if loop:
        return [(p, head), (0, arr[n - p :])]
    head = head.copy()
    f = min(int(0.05 * sr), len(head))
    if f > 0:
        head[-f:] *= np.linspace(1, 0, f, dtype=np.float32)[:, None]
    return [(p, head)]


# --------------------------------------------------------------------------- Gesamtablauf


def render_all(plan: dict, paths: dict[int, Path], out: Path, *, length: float = 120.0, sr: int = 48000,
               seed: int = 1, loop: bool = True, aaf_mode: str = "none", aaf_layout: str = "dualmono",
               reaper_lua: bool = False, log: Log = print) -> list[dict]:
    """Rendert alle Szenen; aaf_mode: none | embedded | linked. Liefert pro Szene die erzeugten Dateien."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")
    roles = {f["id"]: f["role"] for f in plan["files"]}
    usable = {i: p for i, p in paths.items() if roles.get(i, "skip") != "skip"}
    lib = Library(usable, roles, sr)
    layer_pw = consistent_layer_settings(plan)
    n = int(round(length * sr))

    scenes = []
    for i, scene in enumerate(plan["scenes"]):
        clips = build_clips(scene, i, lib, length, seed, layer_pw)
        scenes.append((scene, clips))

    # Pass 1: Mix für den gemeinsamen Master-Gain, damit "voll" lauter bleibt als "ruhig"
    log("Rendere Szenen ...")
    peak = 0.0
    for scene, clips in scenes:
        mix = np.zeros((n, 2), dtype=np.float32)
        for c in clips:
            for p, piece in place(c["pos"], bake(c, lib, 0.0), n, sr, loop):
                mix[p : p + len(piece)] += piece
        peak = max(peak, float(np.max(np.abs(mix))))
    master_db = min(0.0, OUTPUT_PEAK_DB - db(peak))

    # Pass 2: endgültiger Mix plus gebackene Clips für die Session-Exporte
    results = []
    want_clips = aaf_mode != "none" or reaper_lua
    for idx, (scene, clips) in enumerate(scenes):
        slug = re.sub(r"[^A-Za-z0-9_-]+", "_", scene.get("slug") or "") or f"szene_{idx + 1}"
        slug = f"{idx + 1:02d}_{slug}"
        clip_dir = out / f"{slug}_clips"
        if want_clips:
            shutil.rmtree(clip_dir, ignore_errors=True)
            clip_dir.mkdir(parents=True)
        mix = np.zeros((n, 2), dtype=np.float32)
        placed = []  # (track, pos_samples, len_samples, wav_paths)
        for ci, c in enumerate(clips):
            for pi, (p, piece) in enumerate(place(c["pos"], bake(c, lib, master_db), n, sr, loop)):
                mix[p : p + len(piece)] += piece
                if want_clips and len(piece) > 0:
                    placed.append((c["track"], p, len(piece), write_clip(clip_dir, f"c{ci:04d}_{pi}", piece, sr, aaf_layout)))
        wav = out / f"{slug}.wav"
        sf.write(str(wav), mix, sr, subtype="PCM_24")
        res = {"name": scene["name"], "slug": slug, "notes": scene.get("notes", ""), "wav": str(wav),
               "tracks": len({c["track"] for c in clips}),
               "events": sum(1 for c in clips if c["track"].startswith("Events"))}
        if aaf_mode != "none":
            from aafexport import write_aaf

            aaf = out / f"{slug}.aaf"
            write_aaf(aaf, scene["name"], placed, sr, embed=(aaf_mode == "embedded"))
            res["aaf"] = str(aaf)
        if reaper_lua:
            lua = out / f"{slug}.reaper.lua"
            write_reaper_plan(lua, scene["name"], placed, length, sr)
            res["reaper_lua"] = str(lua)
        if want_clips and aaf_mode == "embedded" and not reaper_lua:
            shutil.rmtree(clip_dir, ignore_errors=True)  # steckt jetzt im AAF
        results.append(res)
        log(f"-> {wav.name}  ({res['tracks']} Spuren, {res['events']} Events)  {res['notes']}")
    log(f"Master-Gain {master_db:+.1f} dB, Ausgabe in {out.resolve()}")
    return results


def write_clip(clip_dir: Path, name: str, piece: np.ndarray, sr: int, layout: str) -> list[Path]:
    if layout == "stereo":
        p = clip_dir / f"{name}.wav"
        sf.write(str(p), piece, sr, subtype="PCM_24")
        return [p]
    paths = []
    for ch, suffix in ((0, "L"), (1, "R")):
        p = clip_dir / f"{name}.{suffix}.wav"
        sf.write(str(p), piece[:, ch], sr, subtype="PCM_24")
        paths.append(p)
    return paths


def lua_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def write_reaper_plan(path: Path, name: str, placed: list, length: float, sr: int) -> None:
    """Bauplan für BuildScene.lua. Clips sind gebacken; Mono-Paare werden pro Kanal hart gepannt."""
    by_track: dict[str, list[str]] = {}
    for track, pos, ln, wavs in placed:
        for wav, pan in zip(wavs, (-1.0, 1.0) if len(wavs) == 2 else (0.0,)):
            by_track.setdefault(track, []).append(
                f"      {{ file = {lua_str(str(wav.resolve()))}, pos = {pos / sr:.6f}, len = {ln / sr:.6f}, pan = {pan} }},")
    lines = ["return {", f"  name = {lua_str(name)},", f"  length = {length},", "  tracks = {"]
    for track, items in by_track.items():
        lines += [f"    {{ name = {lua_str(track)}, items = {{", *items, "    } },"]
    lines += ["  },", "}", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def load_source(source: Path, work: Path, log: Log = print) -> tuple[list[dict], dict[int, Path]]:
    catalog, paths = scan_source(source, work, log)
    if not catalog:
        raise RuntimeError("Keine lesbaren Audiodateien gefunden.")
    work.mkdir(parents=True, exist_ok=True)
    (work / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")
    return catalog, paths


def log_stderr(msg: str) -> None:
    print(msg, file=sys.stderr)
