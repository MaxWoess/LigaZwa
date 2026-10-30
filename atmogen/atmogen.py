#!/usr/bin/env python3
"""atmogen (Kommandozeile). Für die Oberfläche: python ui.py

  python atmogen.py scan  <bibliothek> [--clap]
      analysiert alle Audiodateien inkl. Unterordner (beim nächsten Mal nur Neues);
      --clap ergänzt die Inhaltsanalyse (Suche nach Klang, Passt-zusammen-Prüfung)

  python atmogen.py make  <bibliothek> "<welche Atmo>" [Optionen]
      Claude sucht passende Dateien und baut die Szenen, z. B.:
      python atmogen.py make D:/Sounds "Gehobenes Restaurant am Abend" -o out --aaf linked \
          --scene "wenig los" --scene "mittel" --scene "voll"
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import core
from library import LibraryIndex


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sc = sub.add_parser("scan", help="Bibliothek analysieren")
    sc.add_argument("library", type=Path)
    sc.add_argument("--clap", action="store_true", help="zusätzlich Inhaltsanalyse mit CLAP (langsamer, einmalig)")

    mk = sub.add_parser("make", help="Atmo-Szenen erzeugen")
    mk.add_argument("library", type=Path)
    mk.add_argument("request", help="Beschreibung der gewünschten Atmo")
    mk.add_argument("-o", "--out", type=Path, default=Path("atmogen_out"))
    mk.add_argument("--scene", action="append", help="Szenen/Dichtestufen, mehrfach angeben")
    mk.add_argument("--folder", default="", help="nur diesen Unterordner der Bibliothek verwenden")
    mk.add_argument("--length", type=float, default=120.0, help="Länge jeder Szene in Sekunden")
    mk.add_argument("--sr", type=int, default=48000)
    mk.add_argument("--seed", type=int, default=1)
    mk.add_argument("--no-loop", action="store_true", help="feste Länge statt nahtlosem Loop")
    mk.add_argument("--aaf", choices=["none", "embedded", "linked"], default="none")
    mk.add_argument("--aaf-layout", choices=["dualmono", "stereo"], default="dualmono")
    mk.add_argument("--rpp", action="store_true", help="REAPER-Projekte (.rpp) zum direkten Öffnen schreiben")
    mk.add_argument("--reaper-lua", action="store_true", help="zusätzlich Bauplan für BuildScene.lua")
    mk.add_argument("--plan", type=Path, help="vorhandenen plan.json verwenden statt neu zu planen")
    mk.add_argument("--no-llm", action="store_true", help="Heuristik nach Dateinamen statt Claude (braucht --folder)")
    args = ap.parse_args()

    index = LibraryIndex(args.library)
    if args.cmd == "scan" or not index.entries:
        stats = index.scan(lambda msg, done, total: print(f"\r{msg}", end="", flush=True))
        print(f"\n{stats['files']} Dateien ({stats['hours']} h) im Index, {stats['analyzed']} neu analysiert, "
              f"{stats['unreadable']} nicht lesbar")
        if args.cmd == "scan" and args.clap:
            stats = index.clap_scan(lambda msg, done, total: print(f"\r{msg}      ", end="", flush=True))
            print(f"\nInhaltsanalyse: {stats['clap_files']} Dateien ({stats['clap_analyzed']} neu)")
        if args.cmd == "scan":
            return

    scenes = args.scene or ["wenig los", "mittel", "voll"]
    if args.plan:
        plan = json.loads(args.plan.read_text(encoding="utf-8"))
    elif args.no_llm:
        if not args.folder:
            raise SystemExit("--no-llm braucht --folder (die Heuristik kann nicht die ganze Bibliothek durchsuchen)")
        plan = core.plan_heuristic(index.catalog(index.in_folder(args.folder)), scenes)
    else:
        from planner import plan_from_library

        plan = plan_from_library(index, args.request, scenes, args.length, args.folder)

    for f in plan["files"]:
        if f["id"] in index.entries:
            print(f"  {f['role']:<6} {f['category']:<16} {index.entries[f['id']]['rel']}")
    used = {f["id"] for f in plan["files"]}
    core.render_all(plan, index.paths(used), args.out, length=args.length, sr=args.sr, seed=args.seed,
                    loop=not args.no_loop, aaf_mode=args.aaf, aaf_layout=args.aaf_layout,
                    reaper_lua=args.reaper_lua, rpp=args.rpp)


if __name__ == "__main__":
    main()
