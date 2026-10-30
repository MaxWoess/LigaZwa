"""AAF-Export einer Szene aus gebackenen Clips (pyaaf2).

Jeder Clip ist eine eigene WAV (Stereo oder ein L/R-Mono-Paar wie bei Pro Tools). Im AAF wird pro
Clip eine MasterMob angelegt; die Szene ist eine CompositionMob mit einer Sound-Spur pro Kanal und
Lane. Überlappende Clips (Crossfades, gleichzeitige Events) kommen auf zusätzliche Lanes, weil
eine AAF-Sequenz keine Überlappungen kennt.

embed=True  -> Audio steckt im AAF (eine Datei, groß)
embed=False -> AAF verweist per file://-Locator auf die WAVs im Clip-Ordner
"""

from __future__ import annotations

from pathlib import Path

import aaf2
from aaf2.ama import create_network_locator


def _lanes(clips: list[tuple[int, int, list[Path]]]) -> list[list[tuple[int, int, list[Path]]]]:
    lanes: list[list] = []
    ends: list[int] = []
    for clip in sorted(clips, key=lambda c: c[0]):
        pos, ln, _ = clip
        for i, end in enumerate(ends):
            if pos >= end:
                lanes[i].append(clip)
                ends[i] = pos + ln
                break
        else:
            lanes.append([clip])
            ends.append(pos + ln)
    return lanes


def _master_mob(f, wav: Path, sr: int, embed: bool):
    mob = f.create.MasterMob(wav.stem)
    f.content.mobs.append(mob)
    if embed:
        mob.import_audio_essence(str(wav), sr)
        return mob
    source = f.create.SourceMob(f"{wav.stem}.PHYS")
    f.content.mobs.append(source)
    source_slot = source.import_audio_essence(str(wav), sr, offline=True)
    source.descriptor["Locator"].append(create_network_locator(f, str(wav.resolve())))
    slot = mob.create_timeline_slot(edit_rate=sr)
    slot.segment = source.create_source_clip(source_slot.slot_id, media_kind="sound")
    slot.segment.length = source_slot.segment.length
    return mob


def write_aaf(path: Path, name: str, placed: list[tuple[str, int, int, list[Path]]], sr: int, embed: bool) -> None:
    by_track: dict[str, list[tuple[int, int, list[Path]]]] = {}
    for track, pos, ln, wavs in placed:
        by_track.setdefault(track, []).append((pos, ln, wavs))

    with aaf2.open(str(path), "w") as f:
        mobs: dict[Path, object] = {}
        comp = f.create.CompositionMob(name)
        comp.usage = "Usage_TopLevel"
        f.content.mobs.append(comp)

        for track, clips in by_track.items():
            lanes = _lanes(clips)
            n_ch = len(clips[0][2])
            for li, lane in enumerate(lanes):
                for ch in range(n_ch):
                    slot = comp.create_sound_slot(edit_rate=sr)
                    label = track + (f" {li + 1}" if len(lanes) > 1 else "")
                    slot.name = label + ("" if n_ch == 1 else (" L", " R")[ch])
                    seq = slot.segment
                    cursor = 0
                    for pos, ln, wavs in lane:
                        if pos > cursor:
                            seq.components.append(f.create.Filler("sound", pos - cursor))
                        wav = wavs[ch]
                        if wav not in mobs:
                            mobs[wav] = _master_mob(f, wav, sr, embed)
                        seq.components.append(mobs[wav].create_source_clip(slot_id=1, start=0, length=ln))
                        cursor = pos + ln
