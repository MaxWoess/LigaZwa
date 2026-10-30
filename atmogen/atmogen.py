#!/usr/bin/env python3
"""atmogen - baut aus einem Ordner mit Einzelsounds mehrere Atmo-Varianten.

Ablauf:
  1. Analyse:   jede Audiodatei wird vermessen (Länge, Pegel, Dynamik, wie "durchgehend" sie ist).
  2. Planung:   Claude ordnet jede Datei einer Rolle zu (bed / layer / event / skip) und entwirft
                pro Szene eine Mischung (welche Layer, welche Events wie oft, Pegel, Panorama).
                Ohne API-Key: --no-llm nutzt eine einfache Heuristik.
  3. Engine:    platziert deterministisch (Seed) alle Elemente auf einer Zeitachse:
                Beds/Layer geloopt mit Zufallsoffset und Crossfade-Nähten, Events als
                Poisson-Prozess mit Mindestabstand, Pan-, Gain- und Tonhöhen-Variation.
  4. Ausgabe:   pro Szene eine Stereo-WAV (24 bit) + <szene>.reaper.lua für BuildScene.lua,
                das die Szene als editierbare REAPER-Session aufbaut.

Der Plan wird als plan.json gespeichert. Er lässt sich von Hand anpassen und mit --plan
erneut rendern, ohne Claude noch einmal zu fragen.

Beispiel:
  python atmogen.py ./restaurant_sounds -o ./out --length 120 \
      --scene "Restaurant, wenig los" --scene "Restaurant, mittel" --scene "Restaurant, voll"
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

MODEL = "claude-opus-5-5"
AUDIO_EXT = {".wav", ".ogg", ".mp3", ".flac", ".aif", ".aiff", ".opus"}
LOOP_XFADE_S = 2.0
BED_TARGET_RMS_DB = -28.0    # durchgehende Sounds werden vor dem Mix auf diesen RMS gebracht
EVENT_TARGET_PEAK_DB = -6.0  # Einzelereignisse auf diesen Spitzenpegel
OUTPUT_PEAK_DB = -1.0

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


def analyze(path: Path, rel: str, idx: int) -> dict | None:
    try:
        x, sr = load_stereo(path)
    except Exception as e:  # noqa: BLE001 - unlesbare Datei überspringen
        print(f"  übersprungen ({e}): {rel}", file=sys.stderr)
        return None
    info = sf.info(str(path))
    mono = x.mean(axis=1)
    win = max(1, int(sr * 0.1))
    n = len(mono) // win
    if n == 0:
        return None
    frames = mono[: n * win].reshape(n, win)
    st_rms = np.array([db(float(np.sqrt(np.mean(f**2)))) for f in frames])
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(mono**2)))
    return {
        "id": idx,
        "file": rel,
        "duration_s": round(len(x) / sr, 2),
        "channels": info.channels,
        "samplerate": sr,
        "rms_db": round(db(rms), 1),
        "peak_db": round(db(peak), 1),
        "crest_db": round(db(peak) - db(rms), 1),
        "dynamics_db": round(float(np.std(st_rms)), 1),
        # Anteil der 100-ms-Fenster, die höchstens 20 dB unter dem lautesten liegen:
        # nahe 1 = durchgehender Sound, klein = einzelnes Ereignis mit Stille drumherum
        "active_ratio": round(float(np.mean(st_rms > st_rms.max() - 20)), 2),
    }


# --------------------------------------------------------------------------- Planung mit Claude

PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["files", "scenes"],
    "properties": {
        "files": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "role", "category", "description"],
                "properties": {
                    "id": {"type": "integer"},
                    "role": {"type": "string", "enum": ["bed", "layer", "event", "skip"]},
                    "category": {"type": "string"},
                    "description": {"type": "string"},
                },
            },
        },
        "scenes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "slug", "beds", "layers", "event_groups", "notes"],
                "properties": {
                    "name": {"type": "string"},
                    "slug": {"type": "string"},
                    "notes": {"type": "string"},
                    "beds": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["id", "gain_db"],
                            "properties": {"id": {"type": "integer"}, "gain_db": {"type": "number"}},
                        },
                    },
                    "layers": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["id", "gain_db", "pan", "width"],
                            "properties": {
                                "id": {"type": "integer"},
                                "gain_db": {"type": "number"},
                                "pan": {"type": "number"},
                                "width": {"type": "number"},
                            },
                        },
                    },
                    "event_groups": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": [
                                "category", "ids", "rate_per_min", "gain_db_min", "gain_db_max",
                                "pan_spread", "min_gap_s", "pitch_var",
                            ],
                            "properties": {
                                "category": {"type": "string"},
                                "ids": {"type": "array", "items": {"type": "integer"}},
                                "rate_per_min": {"type": "number"},
                                "gain_db_min": {"type": "number"},
                                "gain_db_max": {"type": "number"},
                                "pan_spread": {"type": "number"},
                                "min_gap_s": {"type": "number"},
                                "pitch_var": {"type": "number"},
                            },
                        },
                    },
                },
            },
        },
    },
}

SYSTEM_PROMPT = f"""Du bist Sounddesigner für Atmosphären (Ambiences) und planst Mischungen aus einer
Sammlung von Einzelsounds. Ein Programm setzt deinen Plan danach exakt um; du lieferst nur den Plan.

Rollen pro Datei:
- bed: durchgehender Grundsound (Roomtone, Luft, Klimaanlage). Wird über die ganze Länge geloopt.
- layer: durchgehende, aber belebte Schicht (Stimmengemurmel, Walla, Küchenbetrieb). Geloopt mit
  zufälligem Startpunkt; mehrere Layer an verschiedenen Panoramapositionen ergeben eine dichtere Menge.
- event: einzelnes Ereignis (Glas, Teller, Besteck, Husten, Lachen, Stuhlrücken). Wird zufällig verteilt.
- skip: passt nicht in die Szenen oder ist unbrauchbar.
Kurze Dateien mit kleinem active_ratio sind fast immer Events. Einen Husten oder ein einzelnes Lachen
niemals als bed/layer loopen.

Pegel: Vor dem Mix werden bed/layer auf {BED_TARGET_RMS_DB:.0f} dBFS RMS und Events auf
{EVENT_TARGET_PEAK_DB:.0f} dBFS Peak normalisiert. gain_db ist relativ dazu (typisch -20 bis +3).
pan: -1 links bis +1 rechts. width: Stereobreite eines Layers (0 mono bis 1 original).
rate_per_min: mittlere Ereignisse pro Minute der Gruppe. min_gap_s: Mindestabstand zwischen zwei
Events derselben Gruppe. pan_spread: Events streuen zufällig in [-pan_spread, +pan_spread].
pitch_var: maximale Abspielraten-Abweichung (0.03 = ±3 %), damit Wiederholungen nicht auffallen.

Szenen sollen glaubwürdig klingen und sich klar in der Dichte unterscheiden, aber aus denselben
Dateien bestehen. Ruhige Szenen: wenige, leisere, eher seitliche Layer und seltene Events; volle
Szenen: alle passenden Layer breit verteilt, häufige und überlappende Events. Ereignisse, die
auffallen (Husten, Lachen, Scherben), sparsam einsetzen. slug: kurzer Dateiname in
Kleinbuchstaben, ohne Leerzeichen. notes: ein Satz zu deiner Idee für die Szene."""


def plan_with_claude(catalog: list[dict], scenes: list[str], length: float) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    user = (
        f"Länge jeder Szene: {length:.0f} Sekunden.\n"
        f"Szenen (in dieser Reihenfolge):\n" + "\n".join(f"- {s}" for s in scenes)
        + "\n\nDateien (Messwerte vom Analysator):\n"
        + json.dumps(catalog, ensure_ascii=False, indent=1)
    )
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
        raise SystemExit("Claude hat die Anfrage abgelehnt; mit --no-llm geht es ohne Modell.")
    if response.stop_reason == "max_tokens":
        raise SystemExit("Antwort abgeschnitten (max_tokens); weniger Dateien oder Szenen probieren.")
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

    out_scenes = []
    n = len(scenes)
    for i, name in enumerate(scenes):
        k = i / (n - 1) if n > 1 else 0.5  # 0 = ruhig ... 1 = voll
        n_layers = max(1, round(1 + k * (len(layers) - 1))) if layers else 0
        pans = np.linspace(-0.7, 0.7, n_layers) if n_layers > 1 else [0.4]
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
            "slug": re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or f"szene_{i + 1}",
            "notes": f"heuristisch, Dichte {k:.2f}",
            "beds": [{"id": b["id"], "gain_db": -3.0} for b in beds],
            "layers": [
                {"id": l["id"], "gain_db": round(-10 + 6 * k, 1), "pan": float(p), "width": 0.6 + 0.4 * k}
                for l, p in zip(layers[:n_layers], pans)
            ],
            "event_groups": groups,
        })
    return {"files": files, "scenes": out_scenes}


# --------------------------------------------------------------------------- Engine


class Library:
    """Lädt Dateien einmal, resampled auf die Zielrate und kennt die Normalisierungs-Gains."""

    def __init__(self, paths: dict[int, Path], roles: dict[int, str], sr: int):
        self.paths, self.roles, self.sr = paths, roles, sr
        self._cache: dict[int, np.ndarray] = {}

    def audio(self, fid: int) -> np.ndarray:
        if fid not in self._cache:
            x, sr = load_stereo(self.paths[fid])
            self._cache[fid] = resample(x, sr, self.sr)
        return self._cache[fid]

    def norm_db(self, fid: int) -> float:
        x = self.audio(fid)
        if self.roles[fid] == "event":
            return EVENT_TARGET_PEAK_DB - db(float(np.max(np.abs(x))))
        return BED_TARGET_RMS_DB - db(float(np.sqrt(np.mean(x**2))))


def resample(x: np.ndarray, sr_in: float, sr_out: float, rate: float = 1.0) -> np.ndarray:
    step = sr_in * rate / sr_out
    if abs(step - 1.0) < 1e-9:
        return x
    n_out = int(len(x) / step)
    t = np.arange(n_out) * step
    src = np.arange(len(x))
    return np.stack([np.interp(t, src, x[:, c]) for c in range(x.shape[1])], axis=1).astype(np.float32)


def eq_power_fades(n: int) -> tuple[np.ndarray, np.ndarray]:
    t = np.linspace(0, np.pi / 2, n, dtype=np.float32)[:, None]
    return np.sin(t), np.cos(t)


def loop_fill(x: np.ndarray, n: int, offset: int, xfade: int) -> np.ndarray:
    """Füllt n Samples mit x ab offset, Nähte equal-power gecrossfadet."""
    xfade = min(xfade, len(x) // 3)
    out = np.zeros((n, 2), dtype=np.float32)
    fin, fout = eq_power_fades(xfade) if xfade > 0 else (None, None)
    pos, seg = 0, x[offset:]
    first = True
    while pos < n:
        s = seg.copy()
        if xfade > 0 and len(s) > 2 * xfade:
            if not first:
                s[:xfade] *= fin
            s[-xfade:] *= fout
        take = min(len(s), n - pos)
        out[pos : pos + take] += s[:take]
        pos += max(len(s) - xfade, 1)
        seg, first = x, False
    return out


def pan_width(x: np.ndarray, pan: float, width: float = 1.0) -> np.ndarray:
    mid = (x[:, 0] + x[:, 1]) * 0.5
    side = (x[:, 0] - x[:, 1]) * 0.5 * np.clip(width, 0, 1)
    l, r = mid + side, mid - side
    a = (np.clip(pan, -1, 1) + 1) * np.pi / 4
    return np.stack([l * np.cos(a) * math.sqrt(2), r * np.sin(a) * math.sqrt(2)], axis=1)


def build_timeline(scene: dict, lib: Library, length: float, rng: np.random.Generator) -> list[dict]:
    """Legt alle Items einer Szene fest. Ergebnis wird sowohl gerendert als auch nach REAPER exportiert."""
    tracks = []
    for kind, entries in (("bed", scene["beds"]), ("layer", scene["layers"])):
        for e in entries:
            fid = e["id"]
            if fid not in lib.paths:
                continue
            dur = len(lib.audio(fid)) / lib.sr
            tracks.append({
                "name": f"{kind.capitalize()}: {lib.paths[fid].stem}",
                "items": [{
                    "file": fid, "pos": 0.0, "len": length, "loop": True,
                    "offs": float(rng.uniform(0, max(dur - LOOP_XFADE_S * 2, 0))),
                    "rate": 1.0, "gain_db": lib.norm_db(fid) + e["gain_db"],
                    "pan": float(e.get("pan", 0.0)), "width": float(e.get("width", 1.0)),
                    "fade": LOOP_XFADE_S,
                }],
            })
    for g in scene["event_groups"]:
        ids = [i for i in g["ids"] if i in lib.paths]
        if not ids or g["rate_per_min"] <= 0:
            continue
        items, t, last_t, last_id = [], 0.0, -1e9, None
        while True:
            t += rng.exponential(60.0 / g["rate_per_min"])
            t = max(t, last_t + g["min_gap_s"])
            if t >= length - 0.2:
                break
            choices = [i for i in ids if i != last_id] or ids
            fid = int(rng.choice(choices))
            rate = float(1 + rng.uniform(-g["pitch_var"], g["pitch_var"]))
            dur = len(lib.audio(fid)) / lib.sr / rate
            items.append({
                "file": fid, "pos": round(t, 3), "len": min(dur, length - t), "loop": False,
                "offs": 0.0, "rate": rate,
                "gain_db": lib.norm_db(fid) + float(rng.uniform(g["gain_db_min"], g["gain_db_max"])),
                "pan": float(rng.uniform(-g["pan_spread"], g["pan_spread"])), "width": 1.0,
                "fade": 0.01,
            })
            last_t, last_id = t, fid
        if items:
            tracks.append({"name": f"Events: {g['category']}", "items": items})
    return tracks


def render(tracks: list[dict], lib: Library, length: float) -> np.ndarray:
    n = int(length * lib.sr)
    mix = np.zeros((n, 2), dtype=np.float32)
    for tr in tracks:
        for it in tr["items"]:
            x = lib.audio(it["file"])
            start = int(it["pos"] * lib.sr)
            m = min(int(it["len"] * lib.sr), n - start)
            if m <= 0:
                continue
            if it["loop"]:
                seg = loop_fill(x, m, int(it["offs"] * lib.sr), int(LOOP_XFADE_S * lib.sr))
                f = min(int(it["fade"] * lib.sr), m // 2)
                if f > 0:
                    fin, fout = eq_power_fades(f)
                    seg[:f] *= fin
                    seg[-f:] *= fout
            else:
                seg = resample(x, lib.sr, lib.sr, it["rate"])[:m].copy()
                f = min(int(it["fade"] * lib.sr), len(seg) // 2)
                if f > 0:
                    seg[-f:] *= np.linspace(1, 0, f, dtype=np.float32)[:, None]
            seg = pan_width(seg, it["pan"], it["width"]) * (10 ** (it["gain_db"] / 20))
            mix[start : start + len(seg)] += seg
    return mix


# --------------------------------------------------------------------------- REAPER-Export


def lua_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def write_reaper_plan(path: Path, scene: dict, tracks: list[dict], lib: Library, length: float, master_db: float):
    lines = ["return {", f"  name = {lua_str(scene['name'])},", f"  length = {length},",
             f"  master_gain_db = {master_db:.2f},", "  tracks = {"]
    for tr in tracks:
        lines.append(f"    {{ name = {lua_str(tr['name'])}, items = {{")
        for it in tr["items"]:
            lines.append(
                "      { "
                f"file = {lua_str(str(lib.paths[it['file']].resolve()))}, pos = {it['pos']:.3f}, "
                f"len = {it['len']:.3f}, offs = {it['offs']:.3f}, rate = {it['rate']:.4f}, "
                f"gain_db = {it['gain_db']:.2f}, pan = {it['pan']:.3f}, "
                f"loop = {'true' if it['loop'] else 'false'}, fade = {it['fade']:.3f} }},"
            )
        lines.append("    } },")
    lines += ["  },", "}", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


# --------------------------------------------------------------------------- Hauptprogramm


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="Ordner mit den Einzelsounds")
    ap.add_argument("-o", "--out", type=Path, default=Path("atmogen_out"))
    ap.add_argument("--scene", action="append", help="Szenenbeschreibung, mehrfach angeben")
    ap.add_argument("--length", type=float, default=120.0, help="Länge jeder Szene in Sekunden")
    ap.add_argument("--sr", type=int, default=48000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--plan", type=Path, help="vorhandenen plan.json verwenden statt neu zu planen")
    ap.add_argument("--no-llm", action="store_true", help="Heuristik statt Claude")
    args = ap.parse_args()

    scenes = args.scene or ["wenig los", "mittel", "voll"]
    args.out.mkdir(parents=True, exist_ok=True)

    print("Analysiere Dateien ...")
    files = collect_files(args.source, args.out / "media")
    catalog, paths = [], {}
    for p in files:
        rel = str(p.relative_to(args.source)) if p.is_relative_to(args.source) else p.name
        a = analyze(p, rel, len(catalog))
        if a:
            catalog.append(a)
            paths[a["id"]] = p
    if not catalog:
        raise SystemExit("Keine lesbaren Audiodateien gefunden.")
    (args.out / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  {len(catalog)} Dateien")

    if args.plan:
        plan = json.loads(args.plan.read_text(encoding="utf-8"))
    elif args.no_llm:
        plan = plan_heuristic(catalog, scenes)
    else:
        print(f"Plane {len(scenes)} Szenen mit Claude ...")
        plan = plan_with_claude(catalog, scenes, args.length)
    (args.out / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")

    roles = {f["id"]: f["role"] for f in plan["files"]}
    usable = {i: p for i, p in paths.items() if roles.get(i, "skip") != "skip"}
    lib = Library(usable, roles, args.sr)
    for f in plan["files"]:
        if f["id"] in paths:
            print(f"  {f['role']:<6} {f['category']:<14} {catalog[f['id']]['file']}")

    rendered = []
    for i, scene in enumerate(plan["scenes"]):
        rng = np.random.default_rng(args.seed + i)
        tracks = build_timeline(scene, lib, args.length, rng)
        mix = render(tracks, lib, args.length)
        rendered.append((scene, tracks, mix))

    # Ein gemeinsamer Gain für alle Szenen, damit "voll" lauter bleibt als "ruhig"
    peak = max(float(np.max(np.abs(m))) for _, _, m in rendered)
    master_db = min(0.0, OUTPUT_PEAK_DB - db(peak))
    for scene, tracks, mix in rendered:
        slug = re.sub(r"[^A-Za-z0-9_-]+", "_", scene["slug"]) or "szene"
        sf.write(str(args.out / f"{slug}.wav"), mix * (10 ** (master_db / 20)), args.sr, subtype="PCM_24")
        write_reaper_plan(args.out / f"{slug}.reaper.lua", scene, tracks, lib, args.length, master_db)
        n_events = sum(len(t["items"]) for t in tracks if t["name"].startswith("Events"))
        print(f"-> {slug}.wav  ({len(tracks)} Spuren, {n_events} Events)  {scene.get('notes', '')}")
    print(f"Master-Gain {master_db:+.1f} dB, Ausgabe in {args.out.resolve()}")


if __name__ == "__main__":
    main()
