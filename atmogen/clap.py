"""Inhaltsanalyse mit CLAP (Audio-Text-Modell, läuft lokal auf der CPU).

CLAP bildet Audio und Text in denselben Vektorraum ab. Damit kann man nach Klang suchen
("muffled crowd in a small room"), ähnliche Sounds finden und prüfen, ob Sounds nach demselben
Raum klingen. Optional: braucht `pip install -r requirements-clap.txt` (PyTorch + transformers)
und lädt beim ersten Start das Modell (rund 800 MB) von Hugging Face.
"""

from __future__ import annotations

import os
import threading

import numpy as np
import soundfile as sf

from core import resample

MODEL_ID = "laion/larger_clap_general"
SR = 48000
WIN_S = 10          # CLAP sieht 10-Sekunden-Fenster
MAX_WINDOWS = 3     # lange Dateien: Anfang, Mitte, Ende gemittelt

# Schlagwörter für die automatische Beschreibung jeder Datei
VOCAB = [
    "crowd chatter", "murmuring crowd indoors", "busy restaurant", "quiet restaurant", "cafe ambience",
    "bar crowd", "tavern", "people talking", "single person speaking", "laughter", "cheering crowd",
    "applause", "coughing", "footsteps", "chair scraping", "door opening", "door closing", "door creak",
    "glasses clinking", "cutlery on plates", "dishes clattering", "pouring liquid", "kitchen noise",
    "sizzling food", "cash register", "coins", "room tone", "air conditioning hum", "electrical hum",
    "fridge hum", "ventilation", "clock ticking", "fireplace crackling", "candle", "rain on window",
    "heavy rain", "light rain", "thunder", "wind", "strong wind howling", "leaves rustling", "birds singing",
    "forest ambience", "night insects", "crickets", "frogs", "owl", "water stream", "river", "ocean waves",
    "harbor", "seagulls", "boat creaking", "ship deck", "city traffic", "distant traffic", "car passing",
    "horse hooves", "horse carriage", "market crowd", "medieval market", "blacksmith hammering",
    "church bells", "bell ringing", "dungeon ambience", "cave dripping water", "dripping", "chains rattling",
    "torch burning", "fire burning", "battle", "sword clash", "armor movement", "magic spell",
    "monster growl", "dog barking", "cat", "chickens", "cows", "sheep", "wolf howling", "music", "singing",
    "lute music", "drums", "machinery", "factory", "train", "airplane", "office ambience", "typing keyboard",
    "phone ringing", "spaceship hum", "sci-fi ambience", "eerie drone", "horror ambience", "creepy whispers",
    "paper rustling", "book pages", "wooden creaks", "metal impacts", "glass breaking", "explosion", "silence",
]
# Raumcharakter für die Passt-zusammen-Prüfung
SPACES = [
    "small dry room", "medium sized room", "large reverberant hall", "outdoors open space",
    "close-up recording", "distant sound",
]

_model = None
_lock = threading.Lock()


def missing_dependencies() -> str | None:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError:
        return "CLAP braucht PyTorch und transformers: pip install -r requirements-clap.txt"
    return None


class ClapModel:
    def __init__(self):
        import torch
        from transformers import AutoFeatureExtractor, AutoTokenizer
        from transformers import ClapModel as HFClap

        self.torch = torch
        torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))
        self.model = HFClap.from_pretrained(MODEL_ID).eval()
        self.features = AutoFeatureExtractor.from_pretrained(MODEL_ID)
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        self._text_cache: dict[str, np.ndarray] = {}

    @staticmethod
    def _vectors(out) -> np.ndarray:
        # transformers 5 liefert ein Output-Objekt, ältere Versionen direkt den Tensor
        t = out.pooler_output if hasattr(out, "pooler_output") else out
        v = t.detach().cpu().numpy().astype(np.float32)
        return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)

    def embed_text(self, texts: list[str]) -> np.ndarray:
        todo = [t for t in texts if t not in self._text_cache]
        if todo:
            inputs = self.tokenizer(todo, padding=True, return_tensors="pt")
            with self.torch.no_grad():
                vecs = self._vectors(self.model.get_text_features(**inputs))
            self._text_cache.update(zip(todo, vecs))
        return np.stack([self._text_cache[t] for t in texts])

    def embed_audio(self, clips: list[np.ndarray]) -> np.ndarray:
        inputs = self.features(clips, sampling_rate=SR, return_tensors="pt")
        with self.torch.no_grad():
            return self._vectors(self.model.get_audio_features(**inputs))


def get_model() -> ClapModel:
    global _model
    with _lock:
        if _model is None:
            err = missing_dependencies()
            if err:
                raise RuntimeError(err)
            _model = ClapModel()
        return _model


def load_windows(path: str) -> list[np.ndarray]:
    """Bis zu drei 10-s-Fenster (Anfang, Mitte, Ende) als Mono mit 48 kHz."""
    info = sf.info(path)
    win = int(WIN_S * info.samplerate)
    starts = [0]
    if info.frames > 2 * win:
        starts = [0, (info.frames - win) // 2, info.frames - win][:MAX_WINDOWS]
    out = []
    for s in starts:
        x, sr = sf.read(path, start=s, frames=win, dtype="float32", always_2d=True)
        out.append(resample(x.mean(axis=1, keepdims=True), sr, SR)[:, 0])
    return out


def embed_files(model: ClapModel, paths: list[str]) -> list[np.ndarray | None]:
    result = []
    for p in paths:
        try:
            windows = load_windows(p)
            v = model.embed_audio(windows).mean(axis=0)
            result.append(v / max(np.linalg.norm(v), 1e-9))
        except Exception:  # noqa: BLE001 - unlesbare Datei überspringen
            result.append(None)
    return result
