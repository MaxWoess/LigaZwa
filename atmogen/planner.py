"""Claude stellt aus der ganzen Bibliothek eine Atmo zusammen.

Claude bekommt einen Überblick über die Ordnerstruktur und zwei Werkzeuge (search_library,
list_folder). Damit sucht es passende Dateien und gibt am Ende den Plan als JSON zurück
(Schema core.PLAN_SCHEMA). Die Datei-IDs im Plan sind die stabilen IDs aus dem Bibliotheksindex.
"""

from __future__ import annotations

import json
from typing import Callable

from core import MODEL, PLAN_SCHEMA, SYSTEM_PROMPT
from library import LibraryIndex

MAX_TURNS = 12

# Preise in US-Dollar pro Million Token: Eingabe, Ausgabe, Cache-Lesen (Cache-Schreiben = 1,25 x Eingabe)
PRICES = {
    "claude-opus-5-5": (4.00, 20.00, 0.20),
    "claude-sonnet-5-5": (2.00, 10.00, 0.20),
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
}


class CostMeter:
    """Schätzt die Kosten aus den Token-Angaben jeder Antwort (abgerechnet wird in der Anthropic-Konsole)."""

    def __init__(self, model: str):
        self.price = PRICES.get(model, PRICES[MODEL])
        self.usd = self.last_usd = 0.0
        self.tokens = {"input": 0, "cache_write": 0, "cache_read": 0, "output": 0}

    def add(self, usage) -> str:
        inp, out, read = self.price
        t = {
            "input": usage.input_tokens or 0,
            "cache_write": getattr(usage, "cache_creation_input_tokens", 0) or 0,
            "cache_read": getattr(usage, "cache_read_input_tokens", 0) or 0,
            "output": usage.output_tokens or 0,
        }
        for k, v in t.items():
            self.tokens[k] += v
        self.last_usd = (t["input"] * inp + t["cache_write"] * inp * 1.25 + t["cache_read"] * read + t["output"] * out) / 1e6
        self.usd += self.last_usd
        read_total = t["input"] + t["cache_write"] + t["cache_read"]
        return (f"{read_total / 1000:.1f}k Token gelesen ({t['cache_read'] / 1000:.1f}k aus dem Cache), "
                f"{t['output'] / 1000:.1f}k geschrieben · ${self.last_usd:.3f}, bisher ${self.usd:.2f}")

    def summary(self) -> dict:
        return {"usd": round(self.usd, 4), **self.tokens}

TOOLS = [
    {
        "name": "search_library",
        "description": (
            "Durchsucht die Sound-Bibliothek nach Pfad- und Dateinamen. query: Suchbegriffe, durch "
            "Leerzeichen getrennt; ein Treffer braucht mindestens einen Begriff, mehr Begriffe ranken höher. "
            "Teilwörter zählen ('glas' findet 'Weinglas'). Begriffe auf Englisch und Deutsch und Synonyme "
            "probieren. folder: nur in diesem Unterordner suchen ('' = überall). min_duration/max_duration "
            "in Sekunden (0 = egal). continuous: 'yes' nur durchgehende Sounds, 'no' nur vereinzelte, 'any'. "
            "Liefert pro Datei: id|Pfad|Länge Kanäle (st/mo) Charakter (durchg./vereinz./kurz)|Pegel [|Klang-Schlagwörter; Raum]."
        ),
        "strict": True,
        "eager_input_streaming": True,
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["query", "folder", "min_duration", "max_duration", "continuous", "limit"],
            "properties": {
                "query": {"type": "string"},
                "folder": {"type": "string"},
                "min_duration": {"type": "number"},
                "max_duration": {"type": "number"},
                "continuous": {"type": "string", "enum": ["any", "yes", "no"]},
                "limit": {"type": "integer"},
            },
        },
    },
    {
        "name": "list_folder",
        "description": "Zeigt Unterordner (mit Anzahl und Dauer) und die Dateien direkt in einem Ordner. '' = Wurzel.",
        "strict": True,
        "eager_input_streaming": True,
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["folder"],
            "properties": {"folder": {"type": "string"}},
        },
    },
]

FILTER_PROPS = {
    "folder": {"type": "string"},
    "min_duration": {"type": "number"},
    "max_duration": {"type": "number"},
    "continuous": {"type": "string", "enum": ["any", "yes", "no"]},
    "limit": {"type": "integer"},
}


def _tool(name: str, description: str, props: dict) -> dict:
    return {
        "name": name, "description": description, "strict": True, "eager_input_streaming": True,
        "input_schema": {"type": "object", "additionalProperties": False, "required": list(props), "properties": props},
    }


CLAP_TOOLS = [
    _tool("search_by_sound",
          "Sucht nach Klang statt nach Namen (Inhaltsanalyse mit CLAP). description: kurze englische "
          "Klangbeschreibung, z. B. 'muffled crowd chatter in a small room' oder 'distant glasses clinking'. "
          "Filter wie bei search_library. Liefert die ähnlichsten Dateien mit Ähnlichkeitswert.",
          {"description": {"type": "string"}, **FILTER_PROPS}),
    _tool("similar_sounds",
          "Findet Dateien, die ähnlich klingen wie die Datei mit dieser id, z. B. weitere Varianten eines "
          "guten Events oder Layer aus demselben Raum. Filter wie bei search_library.",
          {"id": {"type": "integer"}, **FILTER_PROPS}),
    _tool("check_fit",
          "Prüft, ob die gewählten Dateien klanglich zusammenpassen (gleicher Raum, ähnlicher Charakter) "
          "und markiert Ausreißer. Vor dem endgültigen Plan mit allen gewählten ids aufrufen.",
          {"ids": {"type": "array", "items": {"type": "integer"}}}),
]

CLAP_PROMPT = """

Zusätzlich gibt es eine Inhaltsanalyse: Suchergebnisse zeigen "klingt nach" und "Raum", und du hast
search_by_sound, similar_sounds und check_fit. Nutze search_by_sound für Klangeigenschaften, die nicht
im Namen stehen (Raumgröße, Entfernung, Intensität, Stimmung), similar_sounds für mehr Varianten
und rufe check_fit mit allen gewählten ids auf, bevor du den Plan abgibst. Ersetze markierte
Ausreißer, wenn es passende Alternativen gibt. Die Analyse ist grob: Dateinamen bleiben wichtig."""

LIBRARY_PROMPT = SYSTEM_PROMPT + """

Du stellst die Atmo selbst aus einer großen Sound-Bibliothek zusammen. Vorgehen:
1. Überlege, welche Bestandteile die gewünschte Umgebung braucht (Grundton/Raum, Menschen, typische
   Ereignisse, Details), und suche jeden Bestandteil gezielt mit mehreren Begriffen.
2. Bevorzuge Dateien, die zusammenpassen (gleicher Raumcharakter, gleiches Sound-Set oder derselbe
   Ordner), und genug Varianten pro Event-Kategorie (ideal 3-8), damit sich nichts hörbar wiederholt.
3. Prüfe Länge und Charakter: Layer und Beds müssen durchgehend sein, Events kurz.
4. Nimm nur, was zur Beschreibung passt; lieber weniger, aber stimmig.
5. Arbeite sparsam: Jede Runde kostet. Stelle mehrere Suchen parallel in einer Runde, kombiniere
   Begriffe in einer Suche, halte limit klein (10-25) und komme in wenigen Runden (meist 2-4) zum Plan.
Gib dann als letzte Antwort nur den Plan als JSON zurück. Unter "files" stehen genau die Dateien,
die in den Szenen vorkommen, mit ihrer Rolle; die ids stammen aus den Suchergebnissen."""


def plan_from_library(index: LibraryIndex, request: str, scenes: list[str], length: float,
                      folder: str = "", api_key: str | None = None,
                      log: Callable[[str], None] = print, *, model: str = MODEL, effort: str = "low",
                      budget_usd: float = 0.30) -> tuple[dict, dict]:
    """Liefert (Plan, Kosten). Würde eine weitere Suchrunde samt Abgabe das Budget sprengen, muss
    Claude mit dem bisher Gefundenen den Plan abgeben. Das Budget ist eine Schätzung, kein hartes Limit."""
    import anthropic

    client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()
    scope = f" (nur im Ordner '{folder}')" if folder else ""
    user = (
        f"Gewünschte Atmo: {request.strip() or 'siehe Szenen'}\n\n"
        f"Länge jeder Szene: {length:.0f} Sekunden.\n"
        "Szenen (Zustände für den Überblend-Regler, in dieser Reihenfolge):\n"
        + "\n".join(f"- {s}" for s in scenes)
        + f"\n\nBibliothek{scope}: {len(index.in_folder(folder))} Dateien. Überblick (tiefer mit list_folder):\n"
        + index.folder_tree(folder, depth=2, max_lines=150)
    )
    messages: list[dict] = [{"role": "user", "content": user}]
    use_clap = index.clap_count() > 0
    tools = TOOLS + CLAP_TOOLS if use_clap else TOOLS
    system = LIBRARY_PROMPT + CLAP_PROMPT if use_clap else LIBRARY_PROMPT
    if use_clap:
        log(f"Inhaltsanalyse aktiv ({index.clap_count()} Dateien)")
    cost = CostMeter(model)
    extra = {}
    if model != "claude-haiku-5-5":  # Haiku hat keine serverseitigen Fallbacks
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    log(f"Modell {model}, Gründlichkeit {effort}, Budget ${budget_usd:.2f}")

    final = False
    for turn in range(MAX_TURNS + 1):
        final = final or turn == MAX_TURNS
        with client.beta.messages.stream(
            model=model,
            max_tokens=16000,
            cache_control={"type": "ephemeral"},
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": PLAN_SCHEMA}},
            system=system,
            tools=tools,
            **({"tool_choice": {"type": "none"}} if final else {}),
            messages=messages,
            **extra,
        ) as stream:
            response = stream.get_final_message()
        log(f"Runde {turn + 1}: {cost.add(response.usage)}")
        if response.stop_reason == "refusal":
            raise RuntimeError("Claude hat die Anfrage abgelehnt.")
        if response.stop_reason == "max_tokens":
            raise RuntimeError("Antwort abgeschnitten (max_tokens).")
        messages.append({"role": "assistant", "content": response.content})

        calls = [b for b in response.content if b.type == "tool_use"]
        if not calls:
            text = next((b.text for b in response.content if b.type == "text"), "")
            log(f"Kosten gesamt: ca. ${cost.usd:.2f}")
            return validate_plan(json.loads(text), index, folder, log), cost.summary()
        if final:
            raise RuntimeError("Claude hat trotz Aufforderung keinen Plan abgegeben.")

        results = [run_tool(call, index, folder, log) for call in calls]
        # Budget: eine weitere Suchrunde plus die Abgaberunde kosten jeweils etwa so viel wie die letzte
        if cost.usd + 2 * cost.last_usd >= budget_usd:
            final = True
            log("Budget fast erreicht: Claude gibt jetzt den Plan mit den gefundenen Sounds ab")
            results.append({"type": "text", "text": "Das Kostenbudget ist erreicht. Keine weiteren Suchen: "
                                                    "gib jetzt mit den bisher gefundenen Dateien den Plan ab."})
        elif cost.usd >= budget_usd * 0.5:
            results.append({"type": "text", "text": "Hinweis: Die Hälfte des Budgets ist verbraucht. "
                                                    "Höchstens noch eine Suchrunde, dann den Plan abgeben."})
        messages.append({"role": "user", "content": results})
    raise RuntimeError(f"Claude hat nach {MAX_TURNS} Runden keinen Plan geliefert.")


def run_tool(call, index: LibraryIndex, folder: str, log: Callable[[str], None]) -> dict:
    args = call.input
    try:
        check_args(call.name, args)
        if call.name == "search_library":
            log(f"Claude sucht: „{args['query']}“" + (f" in {args['folder']}" if args["folder"] else ""))
            out = index.search(args["query"], scoped(folder, args["folder"]), args["min_duration"], args["max_duration"],
                               args["continuous"], args["limit"])
        elif call.name == "list_folder":
            log(f"Claude sieht sich den Ordner „{args['folder'] or '/'}“ an")
            out = index.list_folder(scoped(folder, args["folder"]))
        elif call.name == "search_by_sound":
            log(f"Claude sucht nach Klang: „{args['description']}“")
            out = index.search_sound(args["description"], scoped(folder, args["folder"]), args["min_duration"],
                                     args["max_duration"], args["continuous"], args["limit"])
        elif call.name == "similar_sounds":
            log(f"Claude sucht Ähnliches zu {index.entries.get(args['id'], {}).get('rel', args['id'])}")
            out = index.similar(args["id"], scoped(folder, args["folder"]), args["min_duration"],
                                args["max_duration"], args["continuous"], args["limit"])
        elif call.name == "check_fit":
            log(f"Claude prüft, ob {len(args['ids'])} Sounds zusammenpassen")
            out = index.fit_check(args["ids"])
        else:
            raise ValueError(f"unbekanntes Werkzeug {call.name}")
        return {"type": "tool_result", "tool_use_id": call.id, "content": out}
    except Exception as e:  # noqa: BLE001 - Fehler an Claude zurückgeben
        return {"type": "tool_result", "tool_use_id": call.id, "content": f"Fehler: {e}", "is_error": True}


def scoped(base: str, sub: str) -> str:
    """Unterordner relativ zur gewählten Einschränkung."""
    return "/".join(p for p in (base.strip("/"), sub.strip("/")) if p)


def check_args(name: str, args) -> None:
    """Mit eager_input_streaming prüft die API die Eingaben nicht; fehlerhafte gehen an Claude zurück."""
    tool = next((t for t in TOOLS + CLAP_TOOLS if t["name"] == name), None)
    if tool is None or not isinstance(args, dict):
        raise ValueError("ungültiger Werkzeugaufruf")
    props = tool["input_schema"]["properties"]
    for key in tool["input_schema"]["required"]:
        if key not in args:
            raise ValueError(f"Parameter '{key}' fehlt")
        want = props[key]["type"]
        ok = {"string": str, "number": (int, float), "integer": int, "array": list}[want]
        if not isinstance(args[key], ok) or isinstance(args[key], bool):
            raise ValueError(f"Parameter '{key}' muss {want} sein")
        if want == "array" and not all(isinstance(v, int) and not isinstance(v, bool) for v in args[key]):
            raise ValueError(f"Parameter '{key}' muss eine Liste von ids sein")
        if "enum" in props[key] and args[key] not in props[key]["enum"]:
            raise ValueError(f"Parameter '{key}' muss einer von {props[key]['enum']} sein")


def validate_plan(plan: dict, index: LibraryIndex, folder: str, log: Callable[[str], None]) -> dict:
    """Unbekannte IDs entfernen und fehlende Rollen aus der Verwendung ergänzen."""
    allowed = {e["id"] for e in index.in_folder(folder)}
    files = {f["id"]: f for f in plan.get("files", []) if f["id"] in allowed}
    dropped = set()

    def keep(fid: int, role: str) -> bool:
        if fid not in allowed:
            dropped.add(fid)
            return False
        files.setdefault(fid, {"id": fid, "role": role, "category": role, "description": ""})
        return True

    for s in plan["scenes"]:
        s["beds"] = [b for b in s["beds"] if keep(b["id"], "bed")]
        s["layers"] = [l for l in s["layers"] if keep(l["id"], "layer")]
        for g in s["event_groups"]:
            g["ids"] = [i for i in g["ids"] if keep(i, "event")]
        s["event_groups"] = [g for g in s["event_groups"] if g["ids"]]
    if dropped:
        log(f"Hinweis: {len(dropped)} unbekannte Datei-IDs aus dem Plan entfernt")
    plan["files"] = sorted(files.values(), key=lambda f: f["id"])
    return plan
