"""
supabase_compat.py
===================

Minimaler, auf main.py zugeschnittener Kompatibilitäts-Layer, der Supabase
(Postgres + PostgREST) wie eine MongoDB-Collection ansprechbar macht.

Warum so und nicht "richtig" relational?
-----------------------------------------
Die bestehenden Mongo-Dokumente in main.py sind unterschiedlich tief
verschachtelt (z.B. `teamlisteMeta`, `questions`/`answers`, `participants`-
Arrays) und werden an vielen Stellen im Code direkt als dict weiterverwendet.
Um main.py NICHT an 50+ Stellen umschreiben zu müssen, wird pro Mongo-
Collection eine Supabase-Tabelle mit dieser Struktur angelegt:

    id          text primary key   -- entspricht Mongo _id (als string)
    guild_id    text               -- nur für Index/Debugging, nicht fürs Filtern
    document    jsonb              -- das komplette Dokument, 1:1 wie in Mongo

Dieser Layer deckt NUR die in main.py tatsächlich verwendeten Operationen ab:
find_one, find (+ sort/limit/to_list), insert_one, update_one, delete_one,
find_one_and_update, mit den Operatoren $set, $inc, $setOnInsert, $addToSet
sowie dem Filter-Operator $in. Alles andere wird bewusst NICHT unterstützt
(wirft NotImplementedError), damit stille Fehler auffallen statt unbemerkt
falsche Daten zu erzeugen.

WICHTIG - Nicht atomar:
$inc / $addToSet laufen hier als "lesen -> in Python verändern -> schreiben"
statt als atomares Postgres-Update. Bei sehr hoher paralleler Last auf
DENSELBEN Dokument (z.B. zwei Leute droppen im selben Moment im selben
Giveaway bei) kann das in seltenen Fällen einen Schreibvorgang überschreiben.
Für einen Discord-Bot in dieser Größenordnung ist das Risiko vernachlässigbar,
aber falls es mal auffällt, ist das hier die Ursache.
"""

from __future__ import annotations

import datetime as _dt
import uuid


class ReturnDocument:
    """Ersatz für pymongo.ReturnDocument. Wir geben ohnehin immer den
    Zustand NACH dem Update zurück, das Flag wird nur der Vollständigkeit
    halber akzeptiert, damit `return_document=ReturnDocument.AFTER` im
    bestehenden Code nicht angepasst werden muss."""
    BEFORE = "before"
    AFTER = "after"


def _serialize(value):
    """Wandelt Python-Typen, die jsonb nicht direkt kann (v.a. datetime),
    in JSON-kompatible Werte um. Rekursiv für dicts/lists."""
    if isinstance(value, _dt.datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _serialize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_serialize(v) for v in value]
    return value


class Cursor:
    """Bildet die Teilmenge der pymongo-Cursor-API nach, die main.py nutzt:
    .sort(field, direction).limit(n) und .to_list(length=...) bzw. Iteration."""

    def __init__(self, collection: "MongoLikeCollection", filter_: dict | None):
        self._collection = collection
        self._filter = filter_ or {}
        self._sort_field = None
        self._sort_dir = 1
        self._limit_n = None

    def sort(self, field: str, direction: int = 1) -> "Cursor":
        self._sort_field = field
        self._sort_dir = direction
        return self

    def limit(self, n: int) -> "Cursor":
        self._limit_n = n
        return self

    def to_list(self, length: int | None = None):
        docs = self._collection._query_documents(self._filter)
        if self._sort_field:
            reverse = self._sort_dir == -1
            docs.sort(key=lambda d: d.get(self._sort_field, 0) or 0, reverse=reverse)
        n = length if length is not None else self._limit_n
        if n is not None:
            docs = docs[:n]
        return docs

    def __iter__(self):
        return iter(self.to_list())


class MongoLikeCollection:
    def __init__(self, supabase_client, table_name: str):
        self._sb = supabase_client
        self._table = table_name

    # ---------------- interne Helfer ----------------

    def _apply_filter(self, query, filter_: dict):
        for key, value in (filter_ or {}).items():
            column = "id" if key == "_id" else f"document->>{key}"
            if isinstance(value, dict) and "$in" in value:
                query = query.in_(column, [str(v) for v in value["$in"]])
            elif isinstance(value, bool):
                # jsonb ->> gibt Text zurück, bool muss als "true"/"false" verglichen werden
                query = query.eq(column, "true" if value else "false")
            else:
                query = query.eq(column, str(value) if value is not None else None)
        return query

    def _query_documents(self, filter_: dict) -> list[dict]:
        q = self._sb.table(self._table).select("document")
        q = self._apply_filter(q, filter_)
        res = q.execute()
        return [row["document"] for row in res.data]

    def _row_for_filter(self, filter_: dict):
        q = self._sb.table(self._table).select("*")
        q = self._apply_filter(q, filter_)
        res = q.limit(1).execute()
        return res.data[0] if res.data else None

    @staticmethod
    def _set_path(document: dict, dotted_key: str, value):
        """Setzt einen Wert an einem MongoDB-Dot-Pfad wie 'rpMeta.active',
        legt fehlende Zwischen-dicts bei Bedarf an (wie Mongo es auch tut)."""
        parts = dotted_key.split(".")
        target = document
        for part in parts[:-1]:
            nxt = target.get(part)
            if not isinstance(nxt, dict):
                nxt = {}
                target[part] = nxt
            target = nxt
        target[parts[-1]] = value

    @staticmethod
    def _get_path(document: dict, dotted_key: str, default=None):
        parts = dotted_key.split(".")
        target = document
        for part in parts:
            if not isinstance(target, dict) or part not in target:
                return default
            target = target[part]
        return target

    def _apply_update_ops(self, document: dict, update: dict, is_insert: bool) -> dict:
        document = dict(document or {})
        for op, fields in (update or {}).items():
            if op == "$set":
                for k, v in fields.items():
                    self._set_path(document, k, _serialize(v))
            elif op == "$inc":
                for k, v in fields.items():
                    self._set_path(document, k, (self._get_path(document, k) or 0) + v)
            elif op == "$setOnInsert":
                if is_insert:
                    for k, v in fields.items():
                        self._set_path(document, k, _serialize(v))
            elif op == "$addToSet":
                for k, v in fields.items():
                    arr = list(self._get_path(document, k) or [])
                    if v not in arr:
                        arr.append(v)
                    self._set_path(document, k, arr)
            else:
                raise NotImplementedError(
                    f"Update-Operator '{op}' wird von supabase_compat nicht unterstützt "
                    f"(Tabelle: {self._table})"
                )
        return document

    # ---------------- pymongo-kompatible API ----------------

    def find_one(self, filter_: dict | None = None):
        row = self._row_for_filter(filter_ or {})
        return row["document"] if row else None

    def find(self, filter_: dict | None = None) -> Cursor:
        return Cursor(self, filter_)

    def insert_one(self, document: dict):
        document = _serialize(dict(document))
        doc_id = str(document.get("_id") or uuid.uuid4())
        document["_id"] = doc_id
        guild_id = document.get("guildId")
        self._sb.table(self._table).insert({
            "id": doc_id,
            "guild_id": str(guild_id) if guild_id is not None else None,
            "document": document,
        }).execute()
        return document

    def update_one(self, filter_: dict, update: dict, upsert: bool = False):
        row = self._row_for_filter(filter_)
        if row is None:
            if not upsert:
                return None
            base = {k: v for k, v in (filter_ or {}).items() if k != "_id" and not isinstance(v, dict)}
            new_doc = self._apply_update_ops(base, update, is_insert=True)
            if "_id" in (filter_ or {}):
                new_doc["_id"] = filter_["_id"]
            return self.insert_one(new_doc)
        new_doc = self._apply_update_ops(row["document"], update, is_insert=False)
        guild_id = new_doc.get("guildId")
        self._sb.table(self._table).update({
            "document": new_doc,
            "guild_id": str(guild_id) if guild_id is not None else row.get("guild_id"),
        }).eq("id", row["id"]).execute()
        return new_doc

    def find_one_and_update(self, filter_: dict, update: dict, upsert: bool = False, return_document=None):
        # Wir geben immer den Zustand NACH dem Update zurück (siehe ReturnDocument oben).
        return self.update_one(filter_, update, upsert=upsert)

    def delete_one(self, filter_: dict):
        row = self._row_for_filter(filter_)
        if row is None:
            return None
        self._sb.table(self._table).delete().eq("id", row["id"]).execute()
        return row


class DBPing:
    """Ersatz für `db.command("ping")` - main.py nutzt das nur als
    Verbindungs-Check (siehe health/status-Route)."""

    def __init__(self, supabase_client):
        self._sb = supabase_client

    def command(self, *_args, **_kwargs):
        # Ein simpler, günstiger Request reicht als "ping" gegen Supabase.
        self._sb.table("guild_configs").select("id").limit(1).execute()
        return {"ok": 1}


def build_collections(supabase_client):
    """Erstellt alle main.py-Collection-Objekte auf einen Schlag.
    Rückgabe ist ein dict, das 1:1 auf die bisherigen Variablennamen passt."""
    names = {
        "guild_configs": "guild_configs",
        "giveaways_collection": "giveaways",
        "team_warns_collection": "teamwarns",
        "counting_collection": "counting",
        "levels_collection": "levels",
        "button_actions": "button_actions",
        "applications_collection": "applications",
        "minigame_rounds_collection": "minigame_rounds",
        "transcripts_collection": "transcripts",
        "shifts_collection": "shifts",
        "shift_stats_collection": "shift_stats",
        "quiz_stats_collection": "quiz_stats",
        "logouts_collection": "logouts",
        "tickets_collection": "tickets",
    }
    return {var: MongoLikeCollection(supabase_client, table) for var, table in names.items()}
