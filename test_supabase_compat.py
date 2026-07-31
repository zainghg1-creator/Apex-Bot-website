"""
Prüft supabase_compat.py gegen eine simple In-Memory-Fake-Implementierung des
Supabase-Query-Builders (ohne Netzwerk), damit main.py's tatsächliche Nutzung
(find_one/find/insert_one/update_one/delete_one/find_one_and_update mit
$set (inkl. Dot-Pfad)/$inc/$setOnInsert/$addToSet/$in) durchgespielt werden kann.
"""
import uuid


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, table, mode, payload=None):
        self.table = table
        self.mode = mode  # "select" | "insert" | "update" | "delete"
        self.payload = payload
        self.filters = []  # list of (col, op, value)
        self._limit = None

    def eq(self, col, value):
        self.filters.append((col, "eq", value))
        return self

    def in_(self, col, values):
        self.filters.append((col, "in", values))
        return self

    def select(self, *_args, **_kwargs):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def _row_matches(self, row):
        for col, op, value in self.filters:
            if col == "id":
                actual = row["id"]
            elif col.startswith("document->>"):
                key = col.split("->>", 1)[1]
                actual = row["document"].get(key)
                actual = str(actual) if actual is not None else None
            else:
                actual = row.get(col)
            if op == "eq":
                if actual != value:
                    return False
            elif op == "in":
                if actual not in value:
                    return False
        return True

    def execute(self):
        store = FAKE_DB.setdefault(self.table, {})
        if self.mode == "select":
            rows = [r for r in store.values() if self._row_matches(r)]
            if self._limit is not None:
                rows = rows[: self._limit]
            return FakeResult(rows)
        if self.mode == "insert":
            row = dict(self.payload)
            store[row["id"]] = row
            return FakeResult([row])
        if self.mode == "update":
            matched = [r for r in store.values() if self._row_matches(r)]
            for r in matched:
                r.update(self.payload)
            return FakeResult(matched)
        if self.mode == "delete":
            matched = [r for r in store.values() if self._row_matches(r)]
            for r in matched:
                del store[r["id"]]
            return FakeResult(matched)
        raise AssertionError("unreachable")


class FakeTable:
    def __init__(self, name):
        self.name = name

    def select(self, *_a, **_kw):
        return FakeQuery(self.name, "select")

    def insert(self, payload):
        return FakeQuery(self.name, "insert", payload)

    def update(self, payload):
        return FakeQuery(self.name, "update", payload)

    def delete(self):
        return FakeQuery(self.name, "delete")


class FakeSupabaseClient:
    def table(self, name):
        return FakeTable(name)


FAKE_DB = {}


def run():
    from supabase_compat import build_collections, ReturnDocument

    client = FakeSupabaseClient()
    cols = build_collections(client)
    guild_configs = cols["guild_configs"]
    shifts_collection = cols["shifts_collection"]
    levels_collection = cols["levels_collection"]
    giveaways_collection = cols["giveaways_collection"]

    # --- upsert + verschachteltes $set (wie main.py: teamlisteMeta) ---
    guild_configs.update_one(
        {"guildId": "g1"},
        {"$set": {"teamlisteMeta": {"messageId": "m1", "channelId": "c1"}}},
        upsert=True,
    )
    doc = guild_configs.find_one({"guildId": "g1"})
    assert doc["teamlisteMeta"]["messageId"] == "m1", doc

    # --- Dot-Pfad $set (wie main.py: 'rpMeta.active') ---
    guild_configs.update_one(
        {"guildId": "g1"},
        {"$set": {"rpMeta": {"active": True}}},
    )
    guild_configs.update_one({"guildId": "g1"}, {"$set": {"rpMeta.active": False}})
    doc = guild_configs.find_one({"guildId": "g1"})
    assert doc["rpMeta"]["active"] is False, doc
    assert doc["teamlisteMeta"]["messageId"] == "m1"  # anderes Feld bleibt erhalten

    # --- $in Filter (wie main.py: get_active_shift) ---
    shifts_collection.insert_one({"_id": "s1", "guildId": "g1", "userId": "u1", "status": "active"})
    found = shifts_collection.find_one({"guildId": "g1", "userId": "u1", "status": {"$in": ["active", "paused"]}})
    assert found is not None and found["status"] == "active", found
    not_found = shifts_collection.find_one({"guildId": "g1", "userId": "u1", "status": {"$in": ["ended"]}})
    assert not_found is None

    # --- find_one_and_update mit $inc + $setOnInsert, upsert (wie main.py: add_level_xp) ---
    result = levels_collection.find_one_and_update(
        {"guildId": "g1", "userId": "u1"},
        {"$inc": {"xp": 10}, "$setOnInsert": {"level": 0}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    assert result["xp"] == 10 and result["level"] == 0, result
    result2 = levels_collection.find_one_and_update(
        {"guildId": "g1", "userId": "u1"},
        {"$inc": {"xp": 5}, "$setOnInsert": {"level": 99}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    assert result2["xp"] == 15, result2
    assert result2["level"] == 0, "setOnInsert darf bestehendes Dokument NICHT überschreiben"

    # --- $addToSet (wie main.py: Giveaway-Teilnahme) ---
    giveaways_collection.insert_one({"_id": "gv1", "guildId": "g1", "participants": []})
    giveaways_collection.update_one({"_id": "gv1"}, {"$addToSet": {"participants": "u1"}})
    giveaways_collection.update_one({"_id": "gv1"}, {"$addToSet": {"participants": "u1"}})  # doppelt, darf nicht duplizieren
    doc = giveaways_collection.find_one({"_id": "gv1"})
    assert doc["participants"] == ["u1"], doc

    # --- find + sort + limit + to_list (wie main.py: Leaderboards) ---
    for i in range(3):
        levels_collection.insert_one({"guildId": "g2", "userId": f"u{i}", "xp": i * 10})
    cursor = levels_collection.find({"guildId": "g2"}).sort("xp", -1).limit(2)
    top = cursor.to_list(length=2)
    assert [d["xp"] for d in top] == [20, 10], top

    # --- delete_one ---
    giveaways_collection.delete_one({"_id": "gv1"})
    assert giveaways_collection.find_one({"_id": "gv1"}) is None

    print("Alle supabase_compat-Tests erfolgreich ✅")


if __name__ == "__main__":
    run()
