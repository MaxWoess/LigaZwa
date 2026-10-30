#!/usr/bin/env python3
"""atmogen (Kommandozeile) - baut aus einem Ordner mit Einzelsounds mehrere Atmo-Szenen.

Die Szenen sind gleich lang, nahtlos loopbar und zum Überblenden gedacht (z. B. ein Regler
"Anzahl Menschen" in einem interaktiven System). Für eine Oberfläche: python ui.py

Beispiel:
  python atmogen.py ./restaurant_sounds -o ./out --length 120 --aaf linked \
      --scene "Restaurant, wenig los" --scene "Restaurant, mittel" --scene "Restaurant, voll" \
      --instructions "Eher gehobenes Restaurant, leises Besteck, kaum Lachen"
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import core


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="Ordner mit den Einzelsounds")
    ap.add_argument("-o", "--out", type=Path, default=Path("atmogen_out"))
    ap.add_argument("--scene", action="append", help="Szenenbeschreibung, mehrfach angeben")
    ap.add_argument("--instructions", default="", help="Wünsche an Claude, wie die Session klingen soll")
    ap.add_argument("--length", type=float, default=120.0, help="Länge jeder Szene in Sekunden")
    ap.add_argument("--sr", type=int, default=48000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--no-loop", action="store_true", help="feste Länge statt nahtlosem Loop")
    ap.add_argument("--aaf", choices=["none", "embedded", "linked"], default="none")
    ap.add_argument("--aaf-layout", choices=["dualmono", "stereo"], default="dualmono")
    ap.add_argument("--reaper-lua", action="store_true", help="zusätzlich Bauplan für BuildScene.lua")
    ap.add_argument("--plan", type=Path, help="vorhandenen plan.json verwenden statt neu zu planen")
    ap.add_argument("--no-llm", action="store_true", help="Heuristik statt Claude")
    args = ap.parse_args()

    scenes = args.scene or ["wenig los", "mittel", "voll"]
    print("Analysiere Dateien ...")
    catalog, paths = core.load_source(args.source, args.out)
    print(f"  {len(catalog)} Dateien")

    if args.plan:
        plan = json.loads(args.plan.read_text(encoding="utf-8"))
    elif args.no_llm:
        plan = core.plan_heuristic(catalog, scenes)
    else:
        print(f"Plane {len(scenes)} Szenen mit Claude ...")
        plan = core.plan_with_claude(catalog, scenes, args.length, args.instructions)

    for f in plan["files"]:
        if f["id"] in paths:
            print(f"  {f['role']:<6} {f['category']:<14} {catalog[f['id']]['file']}")
    core.render_all(plan, paths, args.out, length=args.length, sr=args.sr, seed=args.seed,
                    loop=not args.no_loop, aaf_mode=args.aaf, aaf_layout=args.aaf_layout,
                    reaper_lua=args.reaper_lua)


if __name__ == "__main__":
    main()
