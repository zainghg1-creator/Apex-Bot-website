from http.server import HTTPServer, BaseHTTPRequestHandler
import os
import threading

# Webserver für Render & cron-job.org
class KeepAliveHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"Bot is alive!")

def run_web_server():
    port = int(os.environ.get("PORT", 8080))
    server = HTTPServer(("0.0.0.0", port), KeepAliveHandler)
    server.serve_forever()

# Server in einem eigenen Thread starten
threading.Thread(target=run_web_server, daemon=True).start()

import discord
from discord import app_commands
from discord.ext import commands

# ============ MONGODB & .env ============
import os
import re
import asyncio
import time
import random
import io
import base64
import tempfile
import shutil
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
from pymongo import MongoClient, ReturnDocument
import logging
from logging.handlers import RotatingFileHandler
import traceback

# ============ ZEITZONE (Berlin / Deutschland) ============
try:
    from zoneinfo import ZoneInfo
    BERLIN_TZ = ZoneInfo("Europe/Berlin")
except ImportError:
    from datetime import timedelta
    BERLIN_TZ = timezone(timedelta(hours=1))
    logging.warning("⚠️ zoneinfo nicht verfügbar – Berlin-Zeitzone ist nur Winterzeit (UTC+1)")

# ============ HILFSFUNKTION FÜR ZEITZONEN ============
def ensure_aware(dt: datetime) -> datetime:
    """Wandelt eine naive datetime in UTC-aware um (falls nötig)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

# ============ LOGGING ============
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        RotatingFileHandler('bot.log', maxBytes=5 * 1024 * 1024, backupCount=3, encoding='utf-8')
    ]
)
logger = logging.getLogger(__name__)

load_dotenv()

# ============ MONGODB ============
MONGODB_URI = os.getenv("MONGODB_URI")
if MONGODB_URI:
    try:
        mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        db = mongo_client["apex"]
        guild_configs = db["guildconfigs"]
        giveaways_collection = db["giveaways"]
        team_warns_collection = db["teamwarns"]
        counting_collection = db["counting"]
        levels_collection = db["levels"]
        button_actions = db["button_actions"]
        applications_collection = db["applications"]
        minigame_rounds_collection = db["minigame_rounds"]
        transcripts_collection = db["transcripts"]
        shifts_collection = db["shifts"]
        shift_stats_collection = db["shift_stats"]
        quiz_stats_collection = db["quiz_stats"]
        logouts_collection = db["logouts"]
        tickets_collection = db["tickets"]
        logger.info("✅ MongoDB erfolgreich verbunden")
    except Exception as e:
        logger.error(f"❌ MongoDB Verbindungsfehler: {e}")
        db = None
        guild_configs = None
        giveaways_collection = None
        team_warns_collection = None
        counting_collection = None
        levels_collection = None
        button_actions = None
        applications_collection = None
        minigame_rounds_collection = None
        transcripts_collection = None
        shifts_collection = None
        shift_stats_collection = None
        quiz_stats_collection = None
        logouts_collection = None
        tickets_collection = None
else:
    logger.warning("⚠️ Keine MONGODB_URI gefunden – laufe ohne DB")
    db = None
    guild_configs = None
    giveaways_collection = None
    team_warns_collection = None
    counting_collection = None
    levels_collection = None
    button_actions = None
    applications_collection = None
    minigame_rounds_collection = None
    transcripts_collection = None
    shifts_collection = None
    shift_stats_collection = None
    quiz_stats_collection = None
    logouts_collection = None
    tickets_collection = None

# ============================================================
# GENERISCHER IN-MEMORY-CACHE (RAM) MIT AUTOMATISCHEM ABLAUF (TTL)
# ============================================================
# Sorgt dafür, dass Daten beim ersten Abruf zwischengespeichert werden und
# nachfolgende Abrufe innerhalb der TTL direkt aus dem RAM kommen, statt
# jedes Mal die Datenbank abzufragen. Abgelaufene Einträge werden zusätzlich
# periodisch im Hintergrund entfernt (siehe ttl_cache_cleanup_loop).
class TTLCache:
    def __init__(self, ttl: float = 30, name: str = "cache"):
        self.ttl = ttl
        self.name = name
        self._store: dict = {}
        _all_ttl_caches.append(self)

    def get(self, key, default=None):
        entry = self._store.get(key)
        if entry is None:
            return default
        expires_at, value = entry
        if time.monotonic() > expires_at:
            self._store.pop(key, None)
            return default
        return value

    def peek(self, key, default=None):
        """Liefert den Wert auch wenn er bereits abgelaufen ist (für Fallback bei DB-Fehlern)."""
        entry = self._store.get(key)
        return entry[1] if entry else default

    def set(self, key, value, ttl: float = None):
        expires_at = time.monotonic() + (ttl if ttl is not None else self.ttl)
        self._store[key] = (expires_at, value)
        return value

    def invalidate(self, key):
        self._store.pop(key, None)

    def clear(self):
        self._store.clear()

    def cleanup_expired(self) -> int:
        now = time.monotonic()
        expired_keys = [k for k, (exp, _) in self._store.items() if now > exp]
        for k in expired_keys:
            self._store.pop(k, None)
        return len(expired_keys)

_all_ttl_caches: list = []

async def ttl_cache_cleanup_loop():
    """Läuft dauerhaft im Hintergrund und entfernt abgelaufene Cache-Einträge aus dem RAM."""
    while True:
        await asyncio.sleep(60)
        try:
            for cache in list(_all_ttl_caches):
                removed = cache.cleanup_expired()
                if removed:
                    logger.debug(f"[CACHE] {removed} abgelaufene Einträge aus '{cache.name}' entfernt")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"[CACHE] Fehler bei der Cache-Bereinigung: {e}")

_CONFIG_CACHE_TTL = 8
_config_cache = TTLCache(ttl=_CONFIG_CACHE_TTL, name="guild_config")

# Eigener Thread-Pool für alle normalen DB-Aufrufe (find_one, insert_one, usw.).
# Getrennt vom Change-Stream-Pool und mit mehr Workern als das asyncio-Default
# (min(32, cpu_count()+4) – auf kleinen Render-Instanzen mit 1 CPU oft nur 5),
# damit z. B. Voice-XP-Updates für viele Server, Ping-Checks und Slash-Commands
# nicht aufeinander warten müssen.
_db_call_executor = ThreadPoolExecutor(max_workers=20, thread_name_prefix="mongo-db-call")

async def db_call(func, *args, **kwargs):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_db_call_executor, lambda: func(*args, **kwargs))

async def get_config(guild_id):
    if guild_configs is None:
        return {}
    guild_id = str(guild_id)
    cached = _config_cache.get(guild_id)
    if cached is not None:
        return cached
    try:
        doc = await db_call(guild_configs.find_one, {"guildId": guild_id})
        data = doc.get("data", {}) if doc else {}
        _config_cache.set(guild_id, data)
        return data
    except Exception:
        return _config_cache.peek(guild_id, {})

def invalidate_config_cache(guild_id):
    _config_cache.invalidate(str(guild_id))

# ============================================================
# LIVE-CACHE-INVALIDIERUNG BEI DASHBOARD-ÄNDERUNGEN
# ============================================================
# Das Dashboard schreibt Änderungen direkt in MongoDB (ohne den Bot zu
# benachrichtigen). Über einen MongoDB Change Stream bekommt der Bot solche
# Änderungen in Echtzeit mit, löscht den betroffenen Cache-Eintrag sofort und
# lädt die Konfiguration direkt neu – unabhängig von der normalen TTL.
# Voraussetzung: MongoDB läuft als Replica Set (z. B. MongoDB Atlas), da
# Change Streams auf Standalone-Instanzen nicht unterstützt werden.
async def _reload_config_after_dashboard_change(guild_id: str, data: dict):
    _config_cache.set(guild_id, data)
    logger.info(f"[CACHE] Konfiguration für Guild {guild_id} wurde im Dashboard geändert – Cache neu geladen.")

def _watch_guild_configs_sync(loop: asyncio.AbstractEventLoop):
    with guild_configs.watch([], full_document="updateLookup") as stream:
        for change in stream:
            try:
                op_type = change.get("operationType")
                if op_type in ("invalidate",):
                    break
                full_doc = change.get("fullDocument")
                if full_doc and full_doc.get("guildId"):
                    guild_id = str(full_doc["guildId"])
                    data = full_doc.get("data", {})
                    asyncio.run_coroutine_threadsafe(
                        _reload_config_after_dashboard_change(guild_id, data), loop
                    )
                elif op_type == "delete":
                    # Bei einem gelöschten Dokument kennen wir die guildId nicht mehr
                    # sicher – zur Sicherheit den kompletten Config-Cache leeren.
                    asyncio.run_coroutine_threadsafe(_clear_full_config_cache(), loop)
            except Exception as e:
                logger.error(f"[CACHE] Fehler bei der Verarbeitung eines Change-Stream-Events: {e}")

async def _clear_full_config_cache():
    _config_cache.clear()
    logger.info("[CACHE] Kompletter Konfigurations-Cache wurde geleert (Dashboard-Löschung erkannt).")

# Eigener, dedizierter Thread-Pool NUR für den Change-Stream-Watcher.
# Wichtig: der Watcher blockiert seinen Thread dauerhaft (solange der Stream offen ist).
# Würde man dafür den gemeinsamen asyncio.to_thread-Pool nutzen, würde ein Worker
# permanent belegt und für alle anderen db_call(...)-Aufrufe (Ping, Level-System,
# Giveaways, usw.) blieben nur noch wenige/keine Threads übrig – das führt zu
# Timeouts und "hängenden" Interactions, obwohl die DB selbst erreichbar ist.
_watch_stream_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mongo-watch")

async def guild_config_watch_loop():
    if guild_configs is None:
        logger.warning("[CACHE] Keine MongoDB-Verbindung – Live-Cache-Invalidierung ist deaktiviert.")
        return
    loop = asyncio.get_event_loop()
    while True:
        try:
            await loop.run_in_executor(_watch_stream_executor, _watch_guild_configs_sync, loop)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"[CACHE] Change-Stream-Watcher für guildconfigs abgebrochen: {e}")
        logger.warning("[CACHE] Change-Stream-Verbindung getrennt – versuche in 10s erneut.")
        await asyncio.sleep(10)

# ============================================================
# BOT SETUP & INTENTS
# ============================================================
intents = discord.Intents.default()
intents.members = True
intents.invites = True
intents.message_content = True
intents.guilds = True
intents.voice_states = True
bot = commands.Bot(command_prefix="!", intents=intents)

invites_cache = {}
BOT_START_TIME = time.time()

# ============================================================
# VOICE-SUPPORT-VORAUSSETZUNGEN PRÜFEN
# ============================================================
_ffmpeg_path = shutil.which("ffmpeg")
if _ffmpeg_path:
    logger.info(f"✅ ffmpeg gefunden: {_ffmpeg_path}")
else:
    logger.warning("⚠️ ffmpeg NICHT gefunden – Beitritts-Sounds im Voice-Support werden nicht funktionieren!")
try:
    import nacl  # noqa: F401
    logger.info("✅ PyNaCl ist installiert")
except ImportError:
    logger.warning("⚠️ PyNaCl NICHT installiert – Voice-Verbindungen werden fehlschlagen!")

# ============================================================
# MESSAGE-EDIT-QUEUE
# ============================================================
class MessageEditQueue:
    def __init__(self, min_interval: float = 1.2):
        self.min_interval = min_interval
        self._pending: dict[int, tuple] = {}
        self._workers: dict[int, asyncio.Task] = {}
        self._last_edit: dict[int, float] = {}
        self._lock = asyncio.Lock()

    def request_edit(self, message: discord.Message, **kwargs):
        self._pending[message.id] = (message, kwargs)
        existing = self._workers.get(message.id)
        if existing is None or existing.done():
            self._workers[message.id] = bot.loop.create_task(self._worker(message.id))

    async def _worker(self, message_id: int):
        while True:
            entry = self._pending.pop(message_id, None)
            if entry is None:
                break
            message, kwargs = entry
            last = self._last_edit.get(message_id, 0.0)
            wait = self.min_interval - (time.monotonic() - last)
            if wait > 0:
                await asyncio.sleep(wait)
            newer = self._pending.pop(message_id, None)
            if newer is not None:
                message, kwargs = newer
            try:
                await message.edit(**kwargs)
                self._last_edit[message_id] = time.monotonic()
            except discord.HTTPException as e:
                logger.warning(f"[EDIT-QUEUE] Rate-Limit/HTTP-Fehler bei Nachricht {message_id}: {e}")
            except Exception as e:
                logger.error(f"[EDIT-QUEUE] Unerwarteter Fehler bei Nachricht {message_id}: {e}")
        self._workers.pop(message_id, None)

edit_queue = MessageEditQueue(min_interval=1.2)
invite_counts = {}
level_xp_cooldowns = {}

def parse_duration(duration_str: str) -> int:
    duration_str = duration_str.lower().strip()
    if duration_str.endswith('s'):
        return int(duration_str[:-1])
    elif duration_str.endswith('m'):
        return int(duration_str[:-1]) * 60
    elif duration_str.endswith('h'):
        return int(duration_str[:-1]) * 3600
    elif duration_str.endswith('d'):
        return int(duration_str[:-1]) * 86400
    elif duration_str.endswith('w'):
        return int(duration_str[:-1]) * 604800
    else:
        return int(duration_str)

# ============================================================
# BASE64 BILD -> ATTACHMENT
# ============================================================
def base64_to_attachment(data_url: str, filename: str = "image.png") -> discord.File:
    if not data_url or not data_url.startswith('data:image'):
        return None
    try:
        header, base64_data = data_url.split(',', 1)
        mime_type = header.split(';')[0].split(':')[1]
        ext = mime_type.split('/')[-1]
        if ext not in ['png', 'jpg', 'jpeg', 'gif', 'webp']:
            ext = 'png'
        full_filename = f"{filename}.{ext}"
        image_bytes = base64.b64decode(base64_data)
        file_obj = io.BytesIO(image_bytes)
        return discord.File(file_obj, filename=full_filename)
    except Exception as e:
        logger.error(f"Fehler beim Konvertieren von Base64 zu Attachment: {e}")
        return None

# ============================================================
# ROLLEN-NICKNAMES
# ============================================================
def strip_role_nickname_affixes(name: str, entries: list) -> str:
    changed = True
    while changed:
        changed = False
        for entry in entries:
            prefix = entry.get("prefix") or ""
            suffix = entry.get("suffix") or ""
            if prefix and name.startswith(prefix):
                name = name[len(prefix):]
                changed = True
            if suffix and name.endswith(suffix):
                name = name[:len(name) - len(suffix)]
                changed = True
    return name

async def apply_role_nickname(member: discord.Member):
    if member.bot:
        return
    config = await get_config(member.guild.id)
    rn_cfg = config.get("rolenicknames", {})
    if not rn_cfg.get("enabled", False):
        return
    entries = [e for e in rn_cfg.get("entries", []) if e.get("roleId") and (e.get("prefix") or e.get("suffix"))]
    if not entries:
        return
    member_role_ids = {str(r.id) for r in member.roles}
    matching = [e for e in entries if e["roleId"] in member_role_ids]
    current_name = member.nick or member.name
    base_name = strip_role_nickname_affixes(current_name, entries).strip() or member.name
    if matching:
        def role_position(entry):
            role = member.guild.get_role(int(entry["roleId"]))
            return role.position if role else -1
        best = max(matching, key=role_position)
        new_name = f"{best.get('prefix') or ''}{base_name}{best.get('suffix') or ''}"
    else:
        new_name = base_name
    new_name = new_name[:32]
    if new_name == (member.nick or member.name):
        return
    try:
        await member.edit(nick=None if new_name == member.name else new_name)
        logger.info(f"[ROLENICKNAMES] Nickname von {member} → '{new_name}'")
    except discord.Forbidden:
        logger.warning(f"[ROLENICKNAMES] Keine Berechtigung, Nickname von {member} zu ändern.")
    except discord.HTTPException as e:
        logger.warning(f"[ROLENICKNAMES] Fehler beim Ändern des Nicknames von {member}: {e}")

async def sync_role_nicknames(guild: discord.Guild):
    config = await get_config(guild.id)
    rn_cfg = config.get("rolenicknames", {})
    if not rn_cfg.get("enabled", False):
        return
    entries = [e for e in rn_cfg.get("entries", []) if e.get("roleId") and (e.get("prefix") or e.get("suffix"))]
    if not entries:
        return
    if guild.member_count and guild.member_count > 2000:
        logger.info(f"[ROLENICKNAMES] Überspringe Start-Sync für {guild.name} (zu viele Mitglieder).")
        return
    for member in guild.members:
        try:
            await apply_role_nickname(member)
        except Exception as e:
            logger.warning(f"[ROLENICKNAMES] Sync-Fehler bei {member}: {e}")
        await asyncio.sleep(0.3)

# ============================================================
# TRANSCRIPT MANAGER
# ============================================================
class TranscriptManager:
    def __init__(self, bot):
        self.bot = bot

    async def create_transcript(self, channel: discord.TextChannel, save_images: bool = False) -> str:
        messages = []
        async for message in channel.history(limit=1000, oldest_first=True):
            timestamp = message.created_at.strftime("%Y-%m-%d %H:%M:%S")
            author = f"{message.author.name}#{message.author.discriminator}"
            content = message.content or ""
            attachment_parts = []
            if message.attachments or message.embeds:
                if save_images:
                    for att in message.attachments:
                        attachment_parts.append(f"[Anhang: {att.url}]")
                    for emb in message.embeds:
                        img_url = (emb.image.url if emb.image else None) or (emb.thumbnail.url if emb.thumbnail else None)
                        if img_url:
                            attachment_parts.append(f"[Bild: {img_url}]")
                        elif emb.url:
                            attachment_parts.append(f"[Embed: {emb.url}]")
                else:
                    if message.attachments:
                        attachment_parts.append("[Anhang]")
                    if message.embeds:
                        attachment_parts.append("[Embed]")
            line_content = " ".join(filter(None, [content] + attachment_parts)) or "[Leere Nachricht]"
            messages.append(f"[{timestamp}] {author}: {line_content}")
        os.makedirs("transcripts", exist_ok=True)
        filename = f"transcripts/{channel.name}_{datetime.now(BERLIN_TZ).strftime('%Y-%m-%d_%H-%M-%S')}.txt"
        with open(filename, "w", encoding="utf-8") as f:
            f.write(f"=== TRANSCRIPT: {channel.name} ===\n")
            f.write(f"Server: {channel.guild.name}\n")
            f.write(f"Datum: {datetime.now(BERLIN_TZ).strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write("=" * 50 + "\n\n")
            f.write("\n".join(messages))
        return filename

    async def send_transcript_to_channel(self, channel: discord.TextChannel, file_path: str, log_channel: discord.TextChannel = None):
        if not log_channel:
            return False
        try:
            embed = discord.Embed(
                title="📄 Transkript",
                description=f"**Ticket-Kanal:** {channel.mention}\n**Geschlossen:** <t:{int(datetime.now(BERLIN_TZ).timestamp())}:F>",
                color=0x00ff00
            )
            file = discord.File(file_path, filename=os.path.basename(file_path))
            await log_channel.send(embed=embed, file=file)
            return True
        except Exception as e:
            logger.error(f"[TRANSCRIPT] Fehler beim Senden an Log-Kanal: {e}")
            return False

    async def save_transcript_to_db(self, channel: discord.TextChannel, file_path: str):
        if db is None or transcripts_collection is None:
            return False
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            transcript_data = {
                "ticket_channel_id": str(channel.id),
                "ticket_name": channel.name,
                "guild_id": str(channel.guild.id),
                "created_at": channel.created_at.isoformat(),
                "closed_at": datetime.now(BERLIN_TZ).isoformat(),
                "transcript": content,
                "message_count": len(content.split("\n"))
            }
            await db_call(transcripts_collection.insert_one, transcript_data)
            logger.info(f"[TRANSCRIPT] Transkript für {channel.name} in DB gespeichert")
            return True
        except Exception as e:
            logger.error(f"[TRANSCRIPT] Fehler beim Speichern in DB: {e}")
            return False

# ============================================================
# TEAMLISTE (mit konfigurierbarem Titel)
# ============================================================
async def build_teamliste_embed(guild: discord.Guild) -> discord.Embed:
    config = await get_config(guild.id)
    team_cfg = config.get("teamliste", {})
    title = team_cfg.get("title") or "🌟 Teamliste"
    embed = discord.Embed(title=title, color=0xffffff)
    role_ids = team_cfg.get("roles", [])
    if not role_ids:
        embed.description = "❌ **Keine Rollen konfiguriert!**\n\nBitte lege die Teamliste im Dashboard fest."
        return embed
    lines = []
    for role_id in role_ids:
        role = guild.get_role(int(role_id))
        if not role:
            continue
        members = [m for m in role.members if not m.bot]
        if members:
            member_list = "\n".join([f"• {m.mention}" for m in members])
        else:
            member_list = "*Kein Mitglied mit dieser Rolle gefunden*"
        lines.append(f"**{role.mention} ({len(members)})**")
        lines.append(member_list)
        lines.append("")
    embed.description = "\n".join(lines)
    embed.timestamp = datetime.now(BERLIN_TZ)
    return embed

# Pro Guild ein Lock, damit parallele Aufrufe (z.B. mehrere Rollenänderungen
# kurz hintereinander über on_member_update) sich nicht gegenseitig
# überholen. Ohne Lock könnten zwei gleichzeitige Aufrufe beide "keine
# bestehende Nachricht gefunden" lesen und dadurch beide eine neue
# Teamliste-Nachricht senden -> Spam im Kanal.
_teamliste_locks: dict = {}

def _get_teamliste_lock(guild_id: str) -> asyncio.Lock:
    lock = _teamliste_locks.get(guild_id)
    if lock is None:
        lock = asyncio.Lock()
        _teamliste_locks[guild_id] = lock
    return lock

async def update_teamliste(guild: discord.Guild):
    guild_id = str(guild.id)
    async with _get_teamliste_lock(guild_id):
        config = await get_config(guild.id)
        team_cfg = config.get("teamliste", {})
        if not team_cfg.get("channelId"):
            return
        channel = guild.get_channel(int(team_cfg["channelId"]))
        if not channel:
            return
        embed = await build_teamliste_embed(guild)

        # Bekannte Message-ID der Teamliste separat gespeichert (nicht Teil von
        # data.teamliste, damit ein Speichern im Dashboard sie nicht überschreibt).
        # Wird bei jedem Aufruf frisch aus der DB gelesen (nicht gecacht), damit
        # ein vorheriger Aufruf innerhalb desselben Locks garantiert gesehen
        # wird, bevor eine neue Nachricht gesendet wird.
        doc = await db_call(guild_configs.find_one, {"guildId": guild_id})
        meta = (doc or {}).get("teamlisteMeta", {}) or {}
        message_id = meta.get("messageId")
        channel_id = meta.get("channelId")

        if message_id and channel_id == str(channel.id):
            try:
                message = await channel.fetch_message(int(message_id))
                await message.edit(embed=embed)
                return
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                pass  # Nachricht existiert nicht mehr -> unten neu senden

        sent = await channel.send(embed=embed)
        await db_call(
            guild_configs.update_one,
            {"guildId": guild_id},
            {"$set": {"teamlisteMeta": {"messageId": str(sent.id), "channelId": str(channel.id)}}},
            upsert=True,
        )

# ============================================================
# TICKET SYSTEM
# ============================================================
def _category_has_room(category) -> bool:
    return category is None or len(category.channels) < 50

async def resolve_ticket_category(guild: discord.Guild, category_id: str, overflow_enabled: bool, overflow_categories: list):
    """Ermittelt die zu verwendende Kategorie. Weicht bei voller Hauptkategorie auf Überlauf-Kategorien aus.
    Rückgabe: (category_or_None, status) mit status in {"ok", "missing", "full"}."""
    category = None
    if category_id and category_id != "no_category":
        category = guild.get_channel(int(category_id))
        if not category:
            return None, "missing"
    if category and not _category_has_room(category):
        if overflow_enabled:
            for overflow_id in (overflow_categories or []):
                overflow_cat = guild.get_channel(int(overflow_id))
                if overflow_cat and _category_has_room(overflow_cat):
                    return overflow_cat, "ok"
        return category, "full"
    return category, "ok"

def _button_style_from_hex(hex_color: str) -> discord.ButtonStyle:
    mapping = {
        "#5865f2": discord.ButtonStyle.primary,
        "#6d7079": discord.ButtonStyle.secondary,
        "#23a55a": discord.ButtonStyle.success,
        "#ef4444": discord.ButtonStyle.danger,
    }
    return mapping.get((hex_color or "").lower(), discord.ButtonStyle.secondary)

def _safe_button(label: str, emoji: str, style: discord.ButtonStyle, custom_id: str) -> discord.ui.Button:
    """Erstellt einen Button, ignoriert ein ungültiges Emoji statt abzustürzen."""
    try:
        return discord.ui.Button(label=label, emoji=emoji or None, style=style, custom_id=custom_id)
    except Exception as e:
        logger.warning(f"[TICKET] Ungültiges Button-Emoji '{emoji}': {e}")
        return discord.ui.Button(label=label, style=style, custom_id=custom_id)

class TicketDropdown(discord.ui.Select):
    def __init__(self, guild_id: str, panel_index: int, options_data: list):
        self.guild_id = guild_id
        self.panel_index = panel_index
        options = []
        for opt in options_data:
            label = opt.get("label", "Unbekannt")
            emoji = opt.get("emoji")
            category_id = opt.get("categoryId")
            kwargs = {"label": label, "value": category_id if category_id else "no_category"}
            if emoji:
                kwargs["emoji"] = emoji
            try:
                options.append(discord.SelectOption(**kwargs))
            except Exception as e:
                logger.warning(f"[TICKET] Ungültiges Emoji '{emoji}': {e}")
                options.append(discord.SelectOption(label=label, value=category_id if category_id else "no_category"))
        super().__init__(placeholder="Wähle eine Kategorie aus...", options=options, custom_id=f"ticket_select_{panel_index}_{guild_id}")

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            category_id = self.values[0]
            guild = interaction.guild
            user = interaction.user
            config = await get_config(guild.id)
            ticket_cfg = config.get("tickets", {})
            panels = ticket_cfg.get("options", [])
            if self.panel_index >= len(panels):
                await interaction.followup.send("❌ Dieses Panel existiert nicht mehr.", ephemeral=True)
                return
            panel = panels[self.panel_index]
            if not panel:
                await interaction.followup.send("❌ Panel-Daten ungültig.", ephemeral=True)
                return
            creation_msg = panel.get("creationMessage", "Hallo {user}, ein Teammitglied kümmert sich gleich um dein Anliegen.")
            team_roles = config.get("teamliste", {}).get("roles", [])
            log_channel_id = panel.get("logChannelId")
            save_transcripts = panel.get("saveTranscripts", False)
            save_images = panel.get("saveImages", False)
            private_transcripts = panel.get("privateTranscripts", False)
            claim_enabled = panel.get("claimEnabled", False)
            buttons_cfg = panel.get("buttons", []) or []
            thread_mode = panel.get("threadMode", "none")
            overflow_enabled = panel.get("overflowEnabled", False)
            overflow_categories = panel.get("overflowCategories", [])
            member_role_ids = {str(r.id) for r in user.roles}
            denied_roles = set(panel.get("deniedRoles", []) or [])
            allowed_roles = set(panel.get("allowedRoles", []) or [])
            if denied_roles and member_role_ids & denied_roles:
                await interaction.followup.send("❌ Du darfst in diesem Bereich kein Ticket öffnen.", ephemeral=True)
                return
            if allowed_roles and not (member_role_ids & allowed_roles):
                await interaction.followup.send("❌ Du hast keine Berechtigung, hier ein Ticket zu öffnen.", ephemeral=True)
                return
            max_tickets = panel.get("maxTickets", 1) or 1
            existing_tickets = [
                c for c in guild.text_channels
                if c.name.startswith(f"ticket-{user.name.lower()}-")
                and c.permissions_for(user).view_channel
            ]
            existing_threads = [
                t for t in guild.threads
                if t.name.startswith(f"ticket-{user.name.lower()}-") and not t.archived
            ]
            if len(existing_tickets) + len(existing_threads) >= max_tickets:
                await interaction.followup.send(f"❌ Du hast bereits die maximale Anzahl offener Tickets erreicht ({max_tickets}).", ephemeral=True)
                return
            if not guild.me.guild_permissions.manage_channels:
                await interaction.followup.send("❌ Der Bot hat keine Berechtigung, Kanäle zu erstellen (`Manage Channels`)!", ephemeral=True)
                return
            if not guild.me.guild_permissions.manage_roles:
                await interaction.followup.send("❌ Der Bot hat keine Berechtigung, Rollen zu verwalten (`Manage Roles`)!", ephemeral=True)
                return
            selected_option = next((o for o in panel.get("options", []) if (o.get("categoryId") or "no_category") == category_id), None)
            option_support_roles = (selected_option or {}).get("supportRoles", []) or []
            fallback_support_roles = panel.get("supportRoles", []) or []
            support_role_ids = option_support_roles or fallback_support_roles
            channel_name = f"ticket-{user.name.lower()}-{random.randint(100,999)}"

            if thread_mode in ("thread", "private"):
                parent_channel_id = panel.get("panelChannelId")
                parent_channel = guild.get_channel(int(parent_channel_id)) if parent_channel_id else None
                if not isinstance(parent_channel, discord.TextChannel):
                    await interaction.followup.send("❌ Für den Thread-Modus muss ein gültiger Panel-Kanal konfiguriert sein.", ephemeral=True)
                    return
                thread_type = discord.ChannelType.private_thread if thread_mode == "private" else discord.ChannelType.public_thread
                try:
                    ticket_channel = await parent_channel.create_thread(
                        name=channel_name,
                        type=thread_type,
                        reason=f"Ticket erstellt von {user.name}"
                    )
                except discord.Forbidden:
                    await interaction.followup.send("❌ Der Bot hat keine Berechtigung, Threads zu erstellen.", ephemeral=True)
                    return
                try:
                    await ticket_channel.add_user(user)
                except Exception:
                    pass
                if thread_mode == "private":
                    added = 0
                    for role_id in set(team_roles) | set(support_role_ids):
                        role = guild.get_role(int(role_id))
                        if not role:
                            continue
                        for member in role.members:
                            if added >= 90:
                                break
                            try:
                                await ticket_channel.add_user(member)
                                added += 1
                            except Exception:
                                pass
            else:
                overwrites = {
                    guild.default_role: discord.PermissionOverwrite(read_messages=False),
                    user: discord.PermissionOverwrite(read_messages=True, send_messages=True, attach_files=True, embed_links=True),
                    guild.me: discord.PermissionOverwrite(read_messages=True, send_messages=True, manage_channels=True, manage_roles=True)
                }
                for role_id in set(team_roles) | set(support_role_ids):
                    role = guild.get_role(int(role_id))
                    if role:
                        overwrites[role] = discord.PermissionOverwrite(read_messages=True, send_messages=True)
                category, cat_status = await resolve_ticket_category(guild, category_id, overflow_enabled, overflow_categories)
                if cat_status == "missing":
                    await interaction.followup.send("❌ Die ausgewählte Kategorie existiert nicht mehr!", ephemeral=True)
                    return
                if cat_status == "full":
                    await interaction.followup.send("❌ Diese Kategorie ist voll (max. 50 Kanäle) und es ist keine freie Überlauf-Kategorie konfiguriert.", ephemeral=True)
                    return
                ticket_channel = await guild.create_text_channel(
                    channel_name,
                    category=category,
                    overwrites=overwrites,
                    reason=f"Ticket erstellt von {user.name}"
                )

            embed = discord.Embed(
                title="🎫 Ticket geöffnet",
                description=creation_msg.replace("{user}", user.mention),
                color=0xffffff,
                timestamp=datetime.now(BERLIN_TZ)
            )
            ping_message = f"{user.mention} hat ein Ticket eröffnet!"
            # Bei der Ping-Nachricht haben die für dieses Panel/diese Kategorie im
            # Dashboard ausgewählten Support-Rollen Vorrang vor der allgemeinen
            # Teamliste. Nur wenn für dieses Panel keine Support-Rollen konfiguriert
            # sind, wird auf die Teamliste zurückgefallen.
            ping_role_ids = support_role_ids or team_roles
            if ping_role_ids:
                role_mentions = " ".join([f"<@&{role_id}>" for role_id in ping_role_ids])
                ping_message += f"\n{role_mentions}"
            view = TicketCloseView(
                ticket_channel, user, save_transcripts, log_channel_id,
                claim_enabled=claim_enabled, buttons_cfg=buttons_cfg,
                save_images=save_images, private_transcripts=private_transcripts,
                support_role_ids=support_role_ids, team_role_ids=team_roles
            )
            await ticket_channel.send(ping_message)
            ticket_message = await ticket_channel.send(embed=embed, view=view)
            if tickets_collection is not None:
                try:
                    await db_call(tickets_collection.update_one, {"_id": str(ticket_channel.id)}, {"$set": {
                        "guildId": str(guild.id),
                        "channelId": str(ticket_channel.id),
                        "messageId": str(ticket_message.id),
                        "creatorId": str(user.id),
                        "saveTranscripts": save_transcripts,
                        "logChannelId": log_channel_id,
                        "claimEnabled": claim_enabled,
                        "buttonsCfg": buttons_cfg,
                        "saveImages": save_images,
                        "privateTranscripts": private_transcripts,
                        "supportRoleIds": list(support_role_ids or []),
                        "teamRoleIds": list(team_roles or []),
                        "claimedBy": None,
                        "isThread": thread_mode in ("thread", "private")
                    }}, upsert=True)
                except Exception as e:
                    logger.error(f"[TICKET] Konnte Ticket-Metadaten nicht speichern: {e}")
            if log_channel_id:
                log_channel = guild.get_channel(int(log_channel_id))
                if log_channel:
                    try:
                        log_embed = discord.Embed(
                            title="🎫 Ticket geöffnet",
                            description=f"**User:** {user.mention}\n**Kanal:** {ticket_channel.mention}\n**Panel:** {panel.get('panelName', 'Unbekannt')}",
                            color=0x00ff00,
                            timestamp=datetime.now(BERLIN_TZ)
                        )
                        await log_channel.send(embed=log_embed)
                        logger.info(f"[TICKET] Log gesendet: Ticket geöffnet von {user.name}")
                    except Exception as e:
                        logger.error(f"[TICKET] Fehler beim Log-Senden: {e}")
            await interaction.followup.send(f"✅ Ticket wurde erstellt: {ticket_channel.mention}", ephemeral=True)
        except discord.Forbidden as e:
            await interaction.followup.send(f"❌ Fehler: Der Bot hat nicht die nötigen Berechtigungen!\n`{str(e)}`", ephemeral=True)
            logger.error(f"[TICKET] Forbidden-Fehler: {e}")
        except Exception as e:
            await interaction.followup.send(f"❌ Fehler beim Erstellen des Tickets: {str(e)}", ephemeral=True)
            logger.error(f"[TICKET] Fehler: {e}")

class TicketCloseView(discord.ui.View):
    def __init__(self, channel, creator: discord.User, save_transcripts: bool = False, log_channel_id: int = None,
                 claim_enabled: bool = False, buttons_cfg: list = None, save_images: bool = False,
                 private_transcripts: bool = False, support_role_ids: list = None, team_role_ids: list = None):
        super().__init__(timeout=None)
        self.channel = channel
        self.creator = creator
        self.save_transcripts = save_transcripts
        self.log_channel_id = log_channel_id
        self.save_images = save_images
        self.private_transcripts = private_transcripts
        self.support_role_ids = set(support_role_ids or [])
        self.team_role_ids = set(team_role_ids or [])
        self.transcript_manager = TranscriptManager(bot)
        self.claimed_by = None
        self.claim_button = None

        buttons_cfg = buttons_cfg or []
        close_cfg = next((b for b in buttons_cfg if b.get("action") == "close"), None)
        transcript_cfg = next((b for b in buttons_cfg if b.get("action") == "transcript"), None)

        close_button = _safe_button(
            label=(close_cfg or {}).get("label") or "Ticket schließen",
            emoji=(close_cfg or {}).get("emoji") or "🔒",
            style=_button_style_from_hex((close_cfg or {}).get("color")) if close_cfg else discord.ButtonStyle.danger,
            custom_id=f"close_ticket_{channel.id}"
        )
        close_button.callback = self.close_callback
        self.add_item(close_button)

        if save_transcripts:
            transcript_button = _safe_button(
                label=(transcript_cfg or {}).get("label") or "Transkript speichern",
                emoji=(transcript_cfg or {}).get("emoji") or "📄",
                style=_button_style_from_hex((transcript_cfg or {}).get("color")) if transcript_cfg else discord.ButtonStyle.secondary,
                custom_id=f"transcript_{channel.id}"
            )
            transcript_button.callback = self.transcript_callback
            self.add_item(transcript_button)

        if claim_enabled:
            self.claim_button = discord.ui.Button(
                label="Ticket beanspruchen",
                emoji="🙋",
                style=discord.ButtonStyle.primary,
                custom_id=f"claim_ticket_{channel.id}"
            )
            self.claim_button.callback = self.claim_callback
            self.add_item(self.claim_button)

    async def claim_callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        member_role_ids = {str(r.id) for r in interaction.user.roles} if isinstance(interaction.user, discord.Member) else set()
        is_privileged = (
            interaction.user.guild_permissions.administrator
            or bool(member_role_ids & self.support_role_ids)
            or bool(member_role_ids & self.team_role_ids)
        )
        if not is_privileged:
            await interaction.followup.send("❌ Nur Team-/Support-Mitglieder können Tickets beanspruchen.", ephemeral=True)
            return
        if self.claimed_by:
            await interaction.followup.send(f"ℹ️ Dieses Ticket wurde bereits von <@{self.claimed_by}> beansprucht.", ephemeral=True)
            return
        self.claimed_by = interaction.user.id
        if tickets_collection is not None:
            try:
                await db_call(tickets_collection.update_one, {"_id": str(self.channel.id)}, {"$set": {"claimedBy": str(interaction.user.id)}})
            except Exception as e:
                logger.error(f"[TICKET] Konnte Claim-Status nicht speichern: {e}")
        if self.claim_button:
            self.claim_button.disabled = True
            self.claim_button.label = f"Beansprucht von {interaction.user.display_name}"
            try:
                await interaction.message.edit(view=self)
            except Exception as e:
                logger.error(f"[TICKET] Fehler beim Aktualisieren des Claim-Buttons: {e}")
        try:
            await self.channel.edit(topic=f"Beansprucht von {interaction.user.display_name}")
        except Exception:
            pass  # Threads unterstützen kein Topic
        await self.channel.send(f"🙋 Ticket wurde von {interaction.user.mention} beansprucht.")
        await interaction.followup.send("✅ Du hast dieses Ticket beansprucht.", ephemeral=True)

    async def close_callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            transcript_path = None
            log_channel = None
            if self.save_transcripts:
                transcript_path = await self.transcript_manager.create_transcript(self.channel, save_images=self.save_images)
                if self.log_channel_id and not self.private_transcripts:
                    log_channel = self.channel.guild.get_channel(int(self.log_channel_id))
                    if log_channel:
                        await self.transcript_manager.send_transcript_to_channel(self.channel, transcript_path, log_channel)
                if self.private_transcripts:
                    for recipient in {self.creator, interaction.user}:
                        try:
                            await recipient.send("📄 Hier ist das Transkript des geschlossenen Tickets (privat):", file=discord.File(transcript_path))
                        except discord.Forbidden:
                            pass
                if db is not None and transcripts_collection is not None:
                    await self.transcript_manager.save_transcript_to_db(self.channel, transcript_path)
            if self.log_channel_id and not log_channel:
                log_channel = self.channel.guild.get_channel(int(self.log_channel_id))
            if log_channel:
                try:
                    log_embed = discord.Embed(
                        title="🔒 Ticket geschlossen",
                        description=f"**User:** {self.creator.mention}\n**Kanal:** {self.channel.mention}\n**Geschlossen von:** {interaction.user.mention}",
                        color=0xff0000,
                        timestamp=datetime.now(BERLIN_TZ)
                    )
                    if transcript_path:
                        if self.private_transcripts:
                            log_embed.add_field(name="📄 Transkript", value="Privat an Ersteller & Schließer gesendet (Private Transkripte aktiv)", inline=False)
                        else:
                            log_embed.add_field(name="📄 Transkript", value="Siehe angehängte Datei", inline=False)
                    await log_channel.send(embed=log_embed)
                    logger.info(f"[TICKET] Log gesendet: Ticket geschlossen von {interaction.user.name}")
                except Exception as e:
                    logger.error(f"[TICKET] Fehler beim Log-Senden: {e}")
            channel_name = self.channel.name
            if tickets_collection is not None:
                try:
                    await db_call(tickets_collection.delete_one, {"_id": str(self.channel.id)})
                except Exception as e:
                    logger.error(f"[TICKET] Konnte Ticket-Metadaten nicht löschen: {e}")
            await self.channel.delete(reason=f"Ticket geschlossen von {interaction.user.name}")
            await interaction.followup.send(
                f"✅ Ticket `{channel_name}` wurde geschlossen!" +
                (" 📄 Transkript wurde gespeichert." if transcript_path else ""),
                ephemeral=True
            )
        except discord.Forbidden as e:
            await interaction.followup.send(f"❌ Fehler beim Schließen: {e}", ephemeral=True)
        except Exception as e:
            await interaction.followup.send(f"❌ Fehler: {e}", ephemeral=True)
            logger.error(f"[TICKET] Fehler beim Schließen: {e}")

    async def transcript_callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        try:
            transcript_path = await self.transcript_manager.create_transcript(self.channel, save_images=self.save_images)
            await interaction.user.send("📄 Hier ist das Transkript des Tickets:", file=discord.File(transcript_path))
            if self.log_channel_id and not self.private_transcripts:
                log_channel = self.channel.guild.get_channel(int(self.log_channel_id))
                if log_channel:
                    await self.transcript_manager.send_transcript_to_channel(self.channel, transcript_path, log_channel)
            await interaction.followup.send("✅ Transkript wurde gespeichert und dir privat gesendet!", ephemeral=True)
        except discord.Forbidden:
            await interaction.followup.send("❌ Ich kann dir keine DM senden! Bitte aktiviere deine DMs.", ephemeral=True)
        except Exception as e:
            await interaction.followup.send(f"❌ Fehler: {e}", ephemeral=True)

async def rebuild_ticket_view(doc: dict) -> "TicketCloseView | None":
    """Baut die Schließen/Beanspruchen/Transkript-View für ein bereits offenes Ticket
    aus den in der DB gespeicherten Metadaten neu auf, damit die Buttons auch nach
    einem Bot-Neustart weiter funktionieren (statt 'Interaktion fehlgeschlagen')."""
    guild = bot.get_guild(int(doc["guildId"]))
    if not guild:
        return None
    channel = guild.get_channel(int(doc["channelId"])) or guild.get_thread(int(doc["channelId"]))
    if not channel:
        return None
    creator_id = doc.get("creatorId")
    creator = guild.get_member(int(creator_id)) if creator_id else None
    if not creator:
        try:
            creator = await bot.fetch_user(int(creator_id)) if creator_id else None
        except Exception:
            creator = None
    if not creator:
        return None
    view = TicketCloseView(
        channel, creator,
        save_transcripts=doc.get("saveTranscripts", False),
        log_channel_id=doc.get("logChannelId"),
        claim_enabled=doc.get("claimEnabled", False),
        buttons_cfg=doc.get("buttonsCfg", []),
        save_images=doc.get("saveImages", False),
        private_transcripts=doc.get("privateTranscripts", False),
        support_role_ids=doc.get("supportRoleIds", []),
        team_role_ids=doc.get("teamRoleIds", [])
    )
    claimed_by = doc.get("claimedBy")
    if claimed_by and view.claim_button:
        view.claimed_by = int(claimed_by)
        view.claim_button.disabled = True
        member = guild.get_member(int(claimed_by))
        view.claim_button.label = f"Beansprucht von {member.display_name}" if member else "Bereits beansprucht"
    return view

class TicketView(discord.ui.View):
    def __init__(self, guild_id: str, panel_index: int, options_data: list):
        super().__init__(timeout=None)
        self.add_item(TicketDropdown(guild_id, panel_index, options_data))

async def send_ticket_panel(guild: discord.Guild):
    config = await get_config(guild.id)
    ticket_cfg = config.get("tickets", {})
    panel_channel_id = ticket_cfg.get("panelChannelId")
    if not panel_channel_id:
        return
    channel = guild.get_channel(int(panel_channel_id))
    if not channel:
        logger.warning(f"[TICKET] Panel-Kanal {panel_channel_id} nicht gefunden in {guild.name}")
        return
    panels = ticket_cfg.get("options", [])
    if not panels:
        return
    for idx, panel in enumerate(panels):
        panel_options = panel.get("options", [])
        if not panel_options:
            continue
        if panel.get("enabled", True) is False:
            # Deaktiviertes Panel: falls bereits gepostet, alte Nachricht entfernen statt sie zu aktualisieren
            title = panel.get("title", "🎫 Tickets")
            async for message in channel.history(limit=20):
                if message.author == bot.user and message.embeds and message.embeds[0].title == title:
                    try:
                        await message.delete()
                    except Exception as e:
                        logger.error(f"[TICKET] Konnte deaktiviertes Panel nicht entfernen: {e}")
                    break
            continue
        embed = discord.Embed(
            title=panel.get("title", "🎫 Tickets"),
            description=panel.get("description", "Wähle eine Kategorie aus, um ein Ticket zu öffnen."),
            color=int(panel.get("color", "#ffffff").lstrip("#"), 16),
            timestamp=datetime.now(BERLIN_TZ)
        )
        image_url = panel.get("image")
        attachments = []
        if image_url:
            if image_url.startswith('data:image'):
                file = base64_to_attachment(image_url, "ticket_panel_image")
                if file:
                    attachments.append(file)
                    embed.set_image(url=f"attachment://{file.filename}")
            elif image_url.startswith('http'):
                embed.set_image(url=image_url)
        view = TicketView(str(guild.id), idx, panel_options)
        async for message in channel.history(limit=20):
            if message.author == bot.user and message.embeds and message.embeds[0].title == embed.title:
                if attachments:
                    await message.edit(embed=embed, attachments=attachments, view=view)
                else:
                    await message.edit(embed=embed, view=view)
                break
        else:
            if attachments:
                await channel.send(embed=embed, view=view, files=attachments)
            else:
                await channel.send(embed=embed, view=view)

# ============================================================
# BEWERBUNGEN
# ============================================================
_active_applications = set()
_registered_application_forms = set()

class ApplyButton(discord.ui.Button):
    def __init__(self, form_id: str, label: str = "Bewerben"):
        super().__init__(
            label=(label or "Bewerben")[:80],
            style=discord.ButtonStyle.primary,
            custom_id=f"apply_start_{form_id}"
        )
        self.form_id = form_id

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        guild = interaction.guild
        user = interaction.user
        config = await get_config(guild.id)
        forms = config.get("applications", {}).get("forms", [])
        form = next((f for f in forms if f.get("id") == self.form_id), None)
        if not form:
            await interaction.followup.send("❌ Diese Bewerbung ist nicht mehr verfügbar.", ephemeral=True)
            return
        if not form.get("enabled", True):
            await interaction.followup.send("❌ Diese Bewerbung ist aktuell geschlossen.", ephemeral=True)
            return
        questions = [q for q in form.get("questions", []) if q and q.strip()]
        if not questions:
            await interaction.followup.send("❌ Für diese Bewerbung sind noch keine Fragen hinterlegt.", ephemeral=True)
            return
        if user.id in _active_applications:
            await interaction.followup.send("❌ Du hast bereits eine offene Bewerbung. Schau in deinen Direktnachrichten nach oder schreibe dort `abbrechen`.", ephemeral=True)
            return
        try:
            dm_channel = await user.create_dm()
            await dm_channel.send(
                f"Hallo {user.display_name}, du bewirbst dich für **{form.get('name') or form.get('title') or 'eine Bewerbung'}** auf **{guild.name}**.\n\n"
                f"Ich stelle dir jetzt {len(questions)} Frage(n) nacheinander. Antworte einfach hier mit deiner Nachricht. "
                f"Mit `abbrechen` kannst du die Bewerbung jederzeit abbrechen. Für jede Frage hast du 10 Minuten Zeit."
            )
        except discord.Forbidden:
            await interaction.followup.send("❌ Ich konnte dir keine DM senden. Bitte erlaube Direktnachrichten von Servermitgliedern und klicke erneut auf den Button.", ephemeral=True)
            return
        await interaction.followup.send("✅ Ich habe dir eine Direktnachricht geschickt – bitte beantworte dort die Fragen.", ephemeral=True)
        _active_applications.add(user.id)
        try:
            answers = []
            for idx, question in enumerate(questions, start=1):
                await dm_channel.send(f"**Frage {idx}/{len(questions)}**\n{question}")
                try:
                    msg = await bot.wait_for(
                        "message",
                        timeout=600,
                        check=lambda m: m.author.id == user.id and m.guild is None
                    )
                except asyncio.TimeoutError:
                    await dm_channel.send("⏱️ Zeit abgelaufen. Deine Bewerbung wurde abgebrochen. Du kannst jederzeit erneut auf den Button klicken, um neu zu starten.")
                    return
                if msg.content.strip().lower() in ("abbrechen", "cancel"):
                    await dm_channel.send("❌ Bewerbung abgebrochen.")
                    return
                answers.append(msg.content.strip() or "-")
            await dm_channel.send("Danke! Deine Bewerbung wurde übermittelt.")
            await submit_application(guild, form, user, questions, answers)
        except Exception as e:
            logger.error(f"[BEWERBUNG] Fehler im DM-Ablauf für {user}: {e}")
            try:
                await dm_channel.send("❌ Es ist ein unerwarteter Fehler aufgetreten. Bitte versuche es später erneut.")
            except Exception:
                pass
        finally:
            _active_applications.discard(user.id)

class ApplicationReviewView(discord.ui.View):
    def __init__(self, app_id: str):
        super().__init__(timeout=None)
        self.add_item(discord.ui.Button(
            label="Annehmen",
            style=discord.ButtonStyle.success,
            custom_id=f"app_accept_{app_id}"
        ))
        self.add_item(discord.ui.Button(
            label="Ablehnen",
            style=discord.ButtonStyle.danger,
            custom_id=f"app_reject_{app_id}"
        ))

class ApplicationDecisionModal(discord.ui.Modal):
    def __init__(self, app_id: str, action: str):
        super().__init__(title="Bewerbung annehmen" if action == "accepted" else "Bewerbung ablehnen")
        self.app_id = app_id
        self.action = action
        self.reason = discord.ui.TextInput(
            label="Grund",
            style=discord.TextStyle.paragraph,
            placeholder="Begründung für deine Entscheidung...",
            required=True,
            max_length=1000
        )
        self.add_item(self.reason)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        app_id = self.app_id
        action = self.action
        grund = str(self.reason.value).strip() or "-"
        guild = interaction.guild
        try:
            doc = await db_call(applications_collection.find_one, {"_id": app_id})
            if not doc:
                await interaction.followup.send("❌ Diese Bewerbung existiert nicht mehr.", ephemeral=True)
                return
            if doc.get("status") != "pending":
                await interaction.followup.send("❌ Diese Bewerbung wurde bereits bearbeitet.", ephemeral=True)
                return
            user_id = doc.get("userId")
            applicant = guild.get_member(int(user_id)) if user_id else None
            if action == 'accepted':
                # Abwärtskompatibel: alte Bewerbungen haben ggf. nur ein einzelnes acceptRoleId
                accept_role_ids = doc.get("acceptRoleIds") or ([doc.get("acceptRoleId")] if doc.get("acceptRoleId") else [])
                if accept_role_ids and applicant:
                    roles_to_add = []
                    for role_id in accept_role_ids:
                        if not role_id:
                            continue
                        role = guild.get_role(int(role_id))
                        if role:
                            roles_to_add.append(role)
                    if roles_to_add:
                        try:
                            await applicant.add_roles(*roles_to_add, reason="Bewerbung angenommen")
                        except discord.Forbidden:
                            logger.warning(f"[BEWERBUNG] Keine Berechtigung, Rollen {roles_to_add} an {applicant} zu vergeben.")
                await db_call(applications_collection.update_one, {"_id": app_id}, {"$set": {"status": "accepted", "acceptedBy": interaction.user.id, "acceptedAt": datetime.now(timezone.utc), "reason": grund}})
                status_line = f"✅ **Angenommen** von {interaction.user.mention}\n**Grund:** {grund}"
                new_color = 0x2ECC71
            else:
                reject_role_id = doc.get("rejectRoleId")
                if reject_role_id:
                    role = guild.get_role(int(reject_role_id))
                    if role and applicant:
                        try:
                            await applicant.add_roles(role, reason="Bewerbung abgelehnt")
                        except discord.Forbidden:
                            logger.warning(f"[BEWERBUNG] Keine Berechtigung, Rolle {role} an {applicant} zu vergeben.")
                await db_call(applications_collection.update_one, {"_id": app_id}, {"$set": {"status": "rejected", "rejectedBy": interaction.user.id, "rejectedAt": datetime.now(timezone.utc), "reason": grund}})
                status_line = f"❌ **Abgelehnt** von {interaction.user.mention}\n**Grund:** {grund}"
                new_color = 0xE74C3C
            try:
                channel_id = doc.get("channel_id")
                message_id = doc.get("message_id")
                if channel_id and message_id:
                    channel = guild.get_channel(int(channel_id))
                    if channel:
                        msg = await channel.fetch_message(int(message_id))
                        old_embed = msg.embeds[0] if msg.embeds else None
                        new_embed = discord.Embed(
                            title=old_embed.title if old_embed else "Bewerbung",
                            description=old_embed.description if old_embed else None,
                            color=new_color,
                            timestamp=datetime.now(timezone.utc)
                        )
                        if old_embed and old_embed.author:
                            new_embed.set_author(name=old_embed.author.name, icon_url=old_embed.author.icon_url)
                        if old_embed and old_embed.footer:
                            new_embed.set_footer(text=old_embed.footer.text, icon_url=old_embed.footer.icon_url)
                        if old_embed:
                            for field in old_embed.fields:
                                new_embed.add_field(name=field.name, value=field.value, inline=field.inline)
                        new_embed.add_field(name="Entscheidung", value=status_line, inline=False)
                        await msg.edit(embed=new_embed, view=None)
            except Exception as e:
                logger.error(f"[BEWERBUNG] Fehler beim Aktualisieren der Nachricht: {e}")
            if applicant:
                try:
                    dm = await applicant.create_dm()
                    if action == 'accepted':
                        await dm.send(
                            f"🎉 Deine Bewerbung für **{doc.get('formName', 'die Stelle')}** auf **{guild.name}** wurde **angenommen**! Herzlichen Glückwunsch!\n**Grund:** {grund}"
                        )
                    else:
                        await dm.send(
                            f"❌ Deine Bewerbung für **{doc.get('formName', 'die Stelle')}** auf **{guild.name}** wurde **abgelehnt**. Vielen Dank für dein Interesse.\n**Grund:** {grund}"
                        )
                except discord.Forbidden:
                    logger.warning(f"[BEWERBUNG] Kann DM an {applicant} nicht senden.")
                except Exception as e:
                    logger.error(f"[BEWERBUNG] Fehler beim Senden der DM: {e}")
            await interaction.followup.send(f"✅ Bewerbung wurde {action}.", ephemeral=True)
        except Exception as e:
            logger.error(f"[BEWERBUNG] Fehler bei der Bearbeitung der Bewerbung {app_id}: {e}")
            await interaction.followup.send(f"❌ Fehler: {e}", ephemeral=True)

async def submit_application(guild: discord.Guild, form: dict, user: discord.User, questions: list, answers: list):
    result_channel_id = form.get("resultChannelId")
    if not result_channel_id:
        logger.warning(f"[BEWERBUNG] Kein Ergebnis-Kanal für Bewerbung '{form.get('name')}' in {guild.name} konfiguriert.")
        return
    try:
        channel = guild.get_channel(int(result_channel_id))
    except (TypeError, ValueError):
        channel = None
    if not channel:
        return
    app_id = f"app_{int(datetime.now(timezone.utc).timestamp())}_{random.randint(1000,9999)}"
    doc = {
        "_id": app_id,
        "guildId": str(guild.id),
        "formId": form.get("id"),
        "userId": str(user.id),
        "userName": str(user),
        "formName": form.get("name") or form.get("title") or "Bewerbung",
        "questions": questions,
        "answers": answers,
        "status": "pending",
        "createdAt": datetime.now(timezone.utc),
        "channel_id": str(result_channel_id),
        "message_id": None,
        "acceptRoleIds": form.get("acceptRoleIds", []),
        "rejectRoleId": form.get("rejectRoleId"),
        "reviewRoles": form.get("reviewRoles", [])
    }
    if applications_collection is not None:
        try:
            await db_call(applications_collection.insert_one, doc)
            logger.info(f"[BEWERBUNG] Bewerbung {app_id} gespeichert")
        except Exception as e:
            logger.error(f"[BEWERBUNG] Fehler beim Speichern: {e}")
    else:
        logger.warning("[BEWERBUNG] Keine DB, Bewerbung wird nicht gespeichert")
    color_hex = (form.get("color") or "#2b2d31").lstrip("#")
    try:
        color_int = int(color_hex, 16)
    except ValueError:
        color_int = 0x2B2D31
    embed = discord.Embed(
        title=f"Neue Bewerbung – {form.get('name') or form.get('title') or 'Bewerbung'}",
        color=color_int,
        timestamp=datetime.now(timezone.utc)
    )
    embed.set_author(name=f"{user} ({user.id})", icon_url=user.display_avatar.url if user.display_avatar else None)
    embed.set_footer(text=f"User-ID: {user.id}")
    for question, answer in zip(questions, answers):
        embed.add_field(name=question[:256], value=(answer[:1024] if answer else "-"), inline=False)
    content = None
    allowed_mentions = discord.AllowedMentions.none()
    role_id = form.get("pingRoleId")
    if role_id:
        try:
            role = guild.get_role(int(role_id))
        except (TypeError, ValueError):
            role = None
        if role:
            content = role.mention
            allowed_mentions = discord.AllowedMentions(roles=[role])
    view = ApplicationReviewView(app_id)
    bot.add_view(view)
    try:
        msg = await channel.send(content=content, embed=embed, view=view, allowed_mentions=allowed_mentions)
        if applications_collection is not None:
            await db_call(applications_collection.update_one, {"_id": app_id}, {"$set": {"message_id": str(msg.id), "channel_id": str(channel.id)}})
        logger.info(f"[BEWERBUNG] Bewerbung {app_id} von {user} gesendet.")
    except discord.Forbidden:
        logger.warning(f"[BEWERBUNG] Keine Berechtigung in #{channel} ({guild.name}).")
    except Exception as e:
        logger.error(f"[BEWERBUNG] Fehler beim Senden der Bewerbung in {guild.name}: {e}")

async def application_registration_loop():
    await bot.wait_until_ready()
    while not bot.is_closed():
        try:
            for guild in bot.guilds:
                try:
                    config = await get_config(guild.id)
                    forms = config.get("applications", {}).get("forms", [])
                    for form in forms:
                        form_id = form.get("id")
                        if not form_id or form_id in _registered_application_forms:
                            continue
                        view = discord.ui.View(timeout=None)
                        view.add_item(ApplyButton(form_id, form.get("buttonLabel") or "Bewerben"))
                        bot.add_view(view)
                        _registered_application_forms.add(form_id)
                except Exception as e:
                    logger.error(f"[BEWERBUNG] Fehler beim Registrieren der Buttons für {guild.name}: {e}")
        except (ConnectionResetError, RuntimeError) as e:
            if "closing transport" in str(e).lower() or bot.is_closed():
                logger.info("application_registration_loop wird beendet (Bot fährt herunter).")
                break
            logger.error(f"Fehler in application_registration_loop: {e}")
        except Exception as e:
            logger.error(f"Fehler in application_registration_loop: {e}")
        await asyncio.sleep(20)

# ============================================================
# GIVEAWAY
# ============================================================
def create_giveaway_embed(giveaway: dict) -> discord.Embed:
    embed = discord.Embed(title="🎉 Giveaway", description=f"**{giveaway['prize']}**", color=0xffffff, timestamp=datetime.now(BERLIN_TZ))
    if giveaway.get("description"):
        embed.add_field(name="📝 Beschreibung", value=giveaway["description"], inline=False)
    max_participants = giveaway.get("max_participants", 0)
    participants = giveaway.get("participants", [])
    embed.add_field(name="🏆 Gewinner", value=f"{giveaway.get('winner_count', 1)}", inline=True)
    embed.add_field(name="📊 Teilnehmer", value="Unbegrenzt" if max_participants == 0 else str(max_participants), inline=True)
    end_time = giveaway.get("end_time")
    if end_time:
        embed.add_field(name="⏰ Endet", value=f"<t:{int(end_time.timestamp())}:R>", inline=True)
    if participants:
        participant_mentions = []
        for uid in participants[:10]:
            try:
                user = bot.get_user(int(uid))
                participant_mentions.append(user.display_name if user else f"<@{uid}>")
            except:
                participant_mentions.append(f"<@{uid}>")
        participants_str = ", ".join(participant_mentions)
        if len(participants) > 10:
            participants_str += f" und {len(participants) - 10} weitere..."
        embed.add_field(name="👤 Teilnehmer", value=participants_str, inline=False)
    return embed

class GiveawayButton(discord.ui.Button):
    def __init__(self, giveaway_id: str, participant_count: int = 0, ended: bool = False):
        label = f"🎉 Teilnehmen ({participant_count})"
        super().__init__(
            label=label,
            style=discord.ButtonStyle.primary if not ended else discord.ButtonStyle.secondary,
            disabled=ended,
            custom_id=f"giveaway_join_{giveaway_id}"
        )
        self.giveaway_id = giveaway_id

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        giveaway = await db_call(giveaways_collection.find_one, {"_id": self.giveaway_id})
        if not giveaway:
            await interaction.followup.send("❌ Dieses Giveaway existiert nicht mehr.", ephemeral=True)
            return
        if giveaway.get("ended", False):
            await interaction.followup.send("❌ Dieses Giveaway ist bereits beendet.", ephemeral=True)
            return
        user = interaction.user
        guild = interaction.guild
        participants = giveaway.get("participants", [])
        max_participants = giveaway.get("max_participants", 0)
        if max_participants > 0 and len(participants) >= max_participants:
            await interaction.followup.send("❌ Dieses Giveaway ist bereits voll!", ephemeral=True)
            return
        required_role_id = giveaway.get("required_role_id")
        if required_role_id:
            role = guild.get_role(int(required_role_id))
            if not role or role not in user.roles:
                await interaction.followup.send(f"❌ Du benötigst die Rolle {role.mention if role else 'unbekannt'}, um teilzunehmen.", ephemeral=True)
                return
        forbidden_role_id = giveaway.get("forbidden_role_id")
        if forbidden_role_id:
            role = guild.get_role(int(forbidden_role_id))
            if role and role in user.roles:
                await interaction.followup.send(f"❌ Du hast die Rolle **{role.name}** – damit darfst du nicht teilnehmen.", ephemeral=True)
                return
        if str(user.id) in participants:
            await interaction.followup.send("❌ Du nimmst bereits teil!", ephemeral=True)
            return
        await db_call(giveaways_collection.update_one, {"_id": self.giveaway_id}, {"$addToSet": {"participants": str(user.id)}})
        updated_giveaway = await db_call(giveaways_collection.find_one, {"_id": self.giveaway_id})
        embed = create_giveaway_embed(updated_giveaway)
        view = GiveawayView(self.giveaway_id, len(updated_giveaway.get("participants", [])))
        try:
            message = await interaction.channel.fetch_message(int(giveaway.get("message_id")))
            edit_queue.request_edit(message, embed=embed, view=view)
        except Exception as e:
            logger.error(f"[GIVEAWAY] Fehler beim Aktualisieren: {e}")
        await interaction.followup.send("✅ Du nimmst jetzt teil!", ephemeral=True)

class GiveawayView(discord.ui.View):
    def __init__(self, giveaway_id: str, participant_count: int = 0, ended: bool = False):
        super().__init__(timeout=None)
        self.add_item(GiveawayButton(giveaway_id, participant_count, ended))

async def schedule_giveaway_end(giveaway_id: str, end_time: datetime):
    now = datetime.now(timezone.utc)
    if end_time.tzinfo is None:
        end_time = end_time.replace(tzinfo=timezone.utc)
    delay = (end_time - now).total_seconds()
    if delay > 0:
        await asyncio.sleep(delay)
    await end_giveaway(giveaway_id)

async def end_giveaway(giveaway_id: str):
    giveaway = await db_call(giveaways_collection.find_one, {"_id": giveaway_id})
    if not giveaway or giveaway.get("ended", False):
        return
    participants = giveaway.get("participants", [])
    channel = bot.get_channel(int(giveaway["channel_id"]))
    message_id = giveaway.get("message_id")
    if not participants:
        embed = discord.Embed(title="🎉 Giveaway beendet", description=f"**{giveaway['prize']}**\n\n❌ Keine Teilnehmer – kein Gewinner.", color=0xffffff, timestamp=datetime.now(BERLIN_TZ))
        if channel and message_id:
            try:
                message = await channel.fetch_message(int(message_id))
                await message.edit(embed=embed, view=GiveawayView(giveaway_id, 0, ended=True))
            except:
                await channel.send(embed=embed)
        await db_call(giveaways_collection.update_one, {"_id": giveaway_id}, {"$set": {"ended": True}})
        return
    winner_count = max(1, int(giveaway.get("winner_count", 1) or 1))
    winner_count = min(winner_count, len(participants))
    winner_ids = random.sample(participants, winner_count)
    winners = []
    for wid in winner_ids:
        try:
            winners.append(await bot.fetch_user(int(wid)))
        except Exception as e:
            logger.error(f"[GIVEAWAY] Konnte Gewinner {wid} nicht laden: {e}")
    winner_role_id = giveaway.get("winner_role_id")
    if winner_role_id:
        guild = bot.get_guild(int(giveaway["guild_id"]))
        if guild:
            role = guild.get_role(int(winner_role_id))
            if role:
                for wid in winner_ids:
                    member = guild.get_member(int(wid))
                    if member:
                        try:
                            await member.add_roles(role)
                        except Exception as e:
                            logger.error(f"[GIVEAWAY] Fehler beim Vergeben der Rolle: {e}")
    winners_str = "\n".join(f"🏆 {w.mention}" for w in winners) if winners else "❌ Keine Gewinner ermittelt."
    embed = discord.Embed(title="🎉 Giveaway beendet", description=f"**{giveaway['prize']}**\n\n**Gewinner ({len(winners)}):**\n{winners_str}\n🎁 Herzlichen Glückwunsch!", color=0xffffff, timestamp=datetime.now(BERLIN_TZ))
    if channel and message_id:
        try:
            message = await channel.fetch_message(int(message_id))
            await message.edit(embed=embed, view=GiveawayView(giveaway_id, len(participants), ended=True))
        except:
            await channel.send(embed=embed)
    elif channel:
        await channel.send(embed=embed)
    await db_call(giveaways_collection.update_one, {"_id": giveaway_id}, {"$set": {"ended": True, "winner_ids": [str(w) for w in winner_ids]}})

# ============================================================
# STATUS-SCHLEIFE
# ============================================================
async def status_loop():
    await bot.wait_until_ready()
    while not bot.is_closed():
        try:
            guild_count = len(bot.guilds)
            now = datetime.now(BERLIN_TZ)
            date_str = now.strftime("%d.%m.%Y")
            time_str = now.strftime("%H:%M:%S")
            statuses = [
                f"📊 {guild_count} Server",
                f"📅 {date_str}",
                f"⏰ {time_str} Uhr",
                f"🚀 v2.4",
                f"🔧 /help",
                f"💬 discord.gg/3eghXPKD4K",
                f"🌐 Dashboard",
                f"🛡️ {guild_count} Communities geschützt",
                f"🤖 Gestartet: {now.strftime('%H:%M')} Uhr",
                f"⚡ {guild_count} Server aktiv",
                f"📈 {guild_count} Server im Netzwerk",
                f"🔄 tägliche Updates",
                f"🎯 99.9% Uptime",
                f"⏱️ {now.strftime('%H:%M')} – bereit!",
                f"🔒 {guild_count} Server abgesichert"
            ]
            status = random.choice(statuses)
            activity = discord.Game(name=status)
            await bot.change_presence(activity=activity)
        except (ConnectionResetError, RuntimeError) as e:
            if "closing transport" in str(e).lower() or bot.is_closed():
                logger.info("status_loop wird beendet (Bot fährt herunter).")
                break
            logger.error(f"Fehler in status_loop: {e}")
        except Exception as e:
            logger.error(f"Fehler in status_loop: {e}")
        await asyncio.sleep(5)

# ============================================================
# STATUS-ANZEIGE
# ============================================================
_status_embed_last_sent = {}

def format_uptime(seconds: int) -> str:
    seconds = max(0, int(seconds))
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    return " ".join(parts)

async def send_status_embed(guild, cfg):
    channel_id = cfg.get("channelId")
    if not channel_id:
        return
    try:
        channel = guild.get_channel(int(channel_id))
    except (TypeError, ValueError):
        channel = None
    if not channel:
        return
    ping_ms = round(bot.latency * 1000) if bot.latency else 0
    uptime_str = format_uptime(time.time() - BOT_START_TIME)
    title = (cfg.get("title") or "").strip() or "Status"
    color_hex = (cfg.get("color") or "#2b2d31").lstrip("#")
    try:
        color_int = int(color_hex, 16)
    except ValueError:
        color_int = 0x2B2D31
    embed = discord.Embed(title=title, color=color_int, timestamp=datetime.now(timezone.utc))
    embed.add_field(name="Ping", value=f"{ping_ms} ms", inline=True)
    embed.add_field(name="Server", value=str(len(bot.guilds)), inline=True)
    embed.add_field(name="Laufzeit", value=uptime_str, inline=True)
    content = None
    allowed_mentions = discord.AllowedMentions.none()
    role_id = cfg.get("roleId")
    if role_id:
        try:
            role = guild.get_role(int(role_id))
        except (TypeError, ValueError):
            role = None
        if role:
            content = role.mention
            allowed_mentions = discord.AllowedMentions(roles=[role])
    try:
        await channel.send(content=content, embed=embed, allowed_mentions=allowed_mentions)
    except discord.Forbidden:
        logger.warning(f"[STATUS-ANZEIGE] Keine Berechtigung in #{channel} ({guild.name}).")
    except Exception as e:
        logger.error(f"[STATUS-ANZEIGE] Fehler beim Senden in {guild.name}: {e}")

async def status_embed_loop():
    await bot.wait_until_ready()
    while not bot.is_closed():
        try:
            now_ts = time.time()
            for guild in bot.guilds:
                try:
                    config = await get_config(guild.id)
                    cfg = config.get("statusembed", {}) or {}
                    if not cfg.get("enabled") or not cfg.get("channelId"):
                        continue
                    try:
                        interval_minutes = max(1, int(cfg.get("intervalMinutes") or 30))
                    except (TypeError, ValueError):
                        interval_minutes = 30
                    interval_seconds = interval_minutes * 60
                    last_sent = _status_embed_last_sent.get(guild.id, 0)
                    if now_ts - last_sent < interval_seconds:
                        continue
                    await send_status_embed(guild, cfg)
                    _status_embed_last_sent[guild.id] = now_ts
                except Exception as e:
                    logger.error(f"[STATUS-ANZEIGE] Fehler bei {guild.name}: {e}")
        except (ConnectionResetError, RuntimeError) as e:
            if "closing transport" in str(e).lower() or bot.is_closed():
                logger.info("status_embed_loop wird beendet (Bot fährt herunter).")
                break
            logger.error(f"Fehler in status_embed_loop: {e}")
        except Exception as e:
            logger.error(f"Fehler in status_embed_loop: {e}")
        await asyncio.sleep(30)

# ============================================================
# VOICE SUPPORT – BUTTONS UND VIEWS
# ============================================================
_active_support_cases = {}

class SupportTakeButton(discord.ui.Button):
    def __init__(self, guild_id: str, user_id: str, msg_id: str):
        super().__init__(
            label="🎧 Support übernehmen",
            style=discord.ButtonStyle.success,
            custom_id=f"vs_take_{guild_id}_{user_id}_{msg_id}"
        )
        self.guild_id = guild_id
        self.user_id = user_id
        self.msg_id = msg_id

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        guild = interaction.guild
        if str(guild.id) != self.guild_id:
            await interaction.followup.send("❌ Falscher Server.", ephemeral=True)
            return
        support_member = interaction.user
        if not support_member.voice or not support_member.voice.channel:
            await interaction.followup.send("❌ Du musst in einem Sprachkanal sein, um Support zu übernehmen.", ephemeral=True)
            return
        target = guild.get_member(int(self.user_id))
        if not target:
            await interaction.followup.send("❌ Der Nutzer ist nicht mehr auf dem Server.", ephemeral=True)
            return
        if not target.voice or not target.voice.channel:
            await interaction.followup.send("❌ Der Nutzer ist nicht mehr im Wartekanal.", ephemeral=True)
            return
        try:
            await target.move_to(support_member.voice.channel)
            await interaction.followup.send(f"✅ {target.mention} wurde in deinen Kanal verschoben.", ephemeral=True)
        except discord.Forbidden:
            await interaction.followup.send("❌ Ich habe keine Berechtigung, Nutzer zu verschieben.", ephemeral=True)
            return
        except Exception as e:
            await interaction.followup.send(f"❌ Fehler beim Verschieben: {e}", ephemeral=True)
            return
        try:
            channel = interaction.channel
            msg = await channel.fetch_message(int(self.msg_id))
            await msg.edit(content=msg.content + "\n\n✅ **Support wurde übernommen.**", view=None)
        except Exception as e:
            logger.warning(f"[VOICE-SUPPORT] Konnte Nachricht nicht aktualisieren: {e}")
        _active_support_cases.pop(self.msg_id, None)

class SupportEndButton(discord.ui.Button):
    def __init__(self, guild_id: str, user_id: str, msg_id: str):
        super().__init__(
            label="🔚 Supportfall beenden",
            style=discord.ButtonStyle.danger,
            custom_id=f"vs_end_{guild_id}_{user_id}_{msg_id}"
        )
        self.guild_id = guild_id
        self.user_id = user_id
        self.msg_id = msg_id

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        guild = interaction.guild
        if str(guild.id) != self.guild_id:
            await interaction.followup.send("❌ Falscher Server.", ephemeral=True)
            return
        try:
            channel = interaction.channel
            msg = await channel.fetch_message(int(self.msg_id))
            await msg.edit(content=msg.content + "\n\n🔚 **Supportfall beendet.**", view=None)
        except Exception as e:
            logger.warning(f"[VOICE-SUPPORT] Konnte Nachricht nicht aktualisieren: {e}")
        _active_support_cases.pop(self.msg_id, None)
        await interaction.followup.send("✅ Supportfall beendet.", ephemeral=True)

class DutyOnButton(discord.ui.Button):
    def __init__(self, guild_id: str, on_role_id: str, off_role_id: str = None):
        super().__init__(
            label="🟢 On Duty",
            style=discord.ButtonStyle.success,
            custom_id=f"vs_duty_on_{guild_id}_{on_role_id}_{off_role_id or 0}"
        )
        self.guild_id = guild_id
        self.role_id = on_role_id
        self.off_role_id = off_role_id

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        guild = interaction.guild
        if str(guild.id) != self.guild_id:
            await interaction.followup.send("❌ Falscher Server.", ephemeral=True)
            return
        role = guild.get_role(int(self.role_id))
        if not role:
            await interaction.followup.send("❌ On-Duty-Rolle nicht gefunden.", ephemeral=True)
            return
        off_role = None
        if self.off_role_id and self.off_role_id != "0":
            off_role = guild.get_role(int(self.off_role_id))
        member = interaction.user
        if role in member.roles and (not off_role or off_role not in member.roles):
            await interaction.followup.send("ℹ️ Du bist bereits On Duty.", ephemeral=True)
            return
        try:
            if off_role and off_role in member.roles:
                await member.remove_roles(off_role, reason="Duty: Wechsel zu On Duty")
            if role not in member.roles:
                await member.add_roles(role, reason="Duty: On Duty")
            await interaction.followup.send("✅ Du bist jetzt **On Duty**.", ephemeral=True)
        except discord.Forbidden:
            await interaction.followup.send("❌ Ich habe keine Berechtigung, die Rollen zu ändern.", ephemeral=True)

class DutyOffButton(discord.ui.Button):
    def __init__(self, guild_id: str, off_role_id: str, on_role_id: str = None):
        super().__init__(
            label="🔴 Off Duty",
            style=discord.ButtonStyle.danger,
            custom_id=f"vs_duty_off_{guild_id}_{off_role_id}_{on_role_id or 0}"
        )
        self.guild_id = guild_id
        self.role_id = off_role_id
        self.on_role_id = on_role_id

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        guild = interaction.guild
        if str(guild.id) != self.guild_id:
            await interaction.followup.send("❌ Falscher Server.", ephemeral=True)
            return
        role = guild.get_role(int(self.role_id))
        if not role:
            await interaction.followup.send("❌ Off-Duty-Rolle nicht gefunden.", ephemeral=True)
            return
        on_role = None
        if self.on_role_id and self.on_role_id != "0":
            on_role = guild.get_role(int(self.on_role_id))
        member = interaction.user
        if role in member.roles and (not on_role or on_role not in member.roles):
            await interaction.followup.send("ℹ️ Du bist bereits Off Duty.", ephemeral=True)
            return
        try:
            if on_role and on_role in member.roles:
                await member.remove_roles(on_role, reason="Duty: Wechsel zu Off Duty")
            if role not in member.roles:
                await member.add_roles(role, reason="Duty: Off Duty")
            await interaction.followup.send("✅ Du bist jetzt **Off Duty**.", ephemeral=True)
        except discord.Forbidden:
            await interaction.followup.send("❌ Ich habe keine Berechtigung, die Rollen zu ändern.", ephemeral=True)

# ============================================================
# VOICE SUPPORT – BEITRITTS-SOUND
# ============================================================
_voice_sound_locks: dict = {}

def _waiting_room_has_humans(channel: discord.VoiceChannel) -> bool:
    try:
        return any(not m.bot for m in channel.members)
    except Exception:
        return False

async def play_join_sound(guild: discord.Guild, channel: discord.VoiceChannel, vs_cfg: dict):
    """Verbindet den Bot mit dem Warteraum und spielt den Sound in einer Schleife ab,
    solange sich mindestens ein (echter) Nutzer im Kanal befindet. Sobald der Kanal
    leer ist, trennt der Bot die Verbindung automatisch wieder."""
    sound_b64 = vs_cfg.get("joinSoundData")
    if not sound_b64:
        return
    lock = _voice_sound_locks.setdefault(guild.id, asyncio.Lock())
    if lock.locked():
        # Es läuft bereits eine Wiedergabe-Schleife für diesen Server – nichts weiter zu tun,
        # die laufende Schleife erkennt neue/verbleibende Nutzer selbst.
        return
    async with lock:
        try:
            b64_data = sound_b64.split(",", 1)[1] if "," in sound_b64 else sound_b64
            audio_bytes = base64.b64decode(b64_data)
        except Exception as e:
            logger.error(f"[VOICE-SUPPORT] Fehler beim Dekodieren des Beitritts-Sounds: {e}")
            return
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name
            vc = guild.voice_client
            if vc and vc.is_connected():
                if vc.channel.id != channel.id:
                    await vc.move_to(channel)
            else:
                vc = await channel.connect()

            while True:
                current_channel = guild.get_channel(channel.id)
                if current_channel is None or not _waiting_room_has_humans(current_channel):
                    break
                if vc.is_playing():
                    vc.stop()
                done = asyncio.Event()

                def after_play(error, _done=done):
                    if error:
                        logger.error(f"[VOICE-SUPPORT] Fehler bei der Sound-Wiedergabe: {error}")
                    bot.loop.call_soon_threadsafe(_done.set)

                vc.play(discord.FFmpegPCMAudio(tmp_path), after=after_play)
                try:
                    await asyncio.wait_for(done.wait(), timeout=300)
                except asyncio.TimeoutError:
                    logger.warning("[VOICE-SUPPORT] Zeitüberschreitung bei der Sound-Wiedergabe – breche Schleife ab.")
                    break
                # Kurz warten, dann erneut prüfen, ob noch jemand im Warteraum ist (Loop)
                await asyncio.sleep(0.5)
        except discord.ClientException as e:
            logger.error(f"[VOICE-SUPPORT] Voice-Client-Fehler beim Warteraum-Sound: {e}")
        except Exception as e:
            logger.error(f"[VOICE-SUPPORT] Fehler beim Abspielen des Warteraum-Sounds: {e}")
        finally:
            if tmp_path:
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
            try:
                vc = guild.voice_client
                if vc and vc.is_connected():
                    if vc.is_playing():
                        vc.stop()
                    await vc.disconnect(force=False)
            except Exception:
                pass

# ============================================================
# VOICE SUPPORT – EVENT: on_voice_state_update
# ============================================================
@bot.event
async def on_voice_state_update(member: discord.Member, before: discord.VoiceState, after: discord.VoiceState):
    if member.bot:
        return
    guild = member.guild
    config = await get_config(guild.id)
    vs_cfg = config.get("voice_support", {})
    if not vs_cfg.get("enabled", False):
        return
    waiting_room_id = vs_cfg.get("waitingRoomId")
    if not waiting_room_id:
        return
    joined_waiting_room = (
        after.channel and str(after.channel.id) == waiting_room_id and
        (before.channel is None or before.channel.id != after.channel.id)
    )
    if joined_waiting_room and vs_cfg.get("joinSoundEnabled") and vs_cfg.get("joinSoundData"):
        asyncio.create_task(play_join_sound(guild, after.channel, vs_cfg))
    notification_channel_id = vs_cfg.get("notificationChannelId")
    ping_role_id = vs_cfg.get("pingRoleId")
    if not notification_channel_id:
        return
    if after.channel and str(after.channel.id) == waiting_room_id:
        for msg_id, (gid, uid, _) in list(_active_support_cases.items()):
            if uid == str(member.id):
                return
        channel = guild.get_channel(int(notification_channel_id))
        if not channel:
            return
        embed_title = vs_cfg.get("embedTitle", "🆕 Support-Anfrage")
        embed_desc = vs_cfg.get("embedDescription", "{user} wartet im Support-Warteraum auf Hilfe.")
        embed_color = vs_cfg.get("embedColor", "#5865f2")
        embed_image = vs_cfg.get("embedImage", "")
        embed_desc = embed_desc.replace("{user}", member.mention).replace("{username}", member.display_name).replace("{server}", guild.name)
        try:
            color_int = int(embed_color.lstrip("#"), 16)
        except:
            color_int = 0x5865f2
        embed = discord.Embed(
            title=embed_title,
            description=embed_desc,
            color=color_int,
            timestamp=datetime.now(timezone.utc)
        )
        embed.add_field(name="Nutzer", value=f"{member.display_name} ({member.id})", inline=True)
        embed.add_field(name="Kanal", value=f"<#{waiting_room_id}>", inline=True)
        if embed_image and embed_image.startswith('http'):
            embed.set_image(url=embed_image)
        view = discord.ui.View(timeout=None)
        msg_id = f"vs_{int(time.time())}_{random.randint(1000,9999)}"
        view.add_item(SupportTakeButton(str(guild.id), str(member.id), msg_id))
        view.add_item(SupportEndButton(str(guild.id), str(member.id), msg_id))
        content = None
        if ping_role_id:
            role = guild.get_role(int(ping_role_id))
            if role:
                content = role.mention
        try:
            msg = await channel.send(content=content, embed=embed, view=view)
            _active_support_cases[msg_id] = (str(guild.id), str(member.id), str(msg.id))
            bot.add_view(view)
        except Exception as e:
            logger.error(f"[VOICE-SUPPORT] Fehler beim Senden der Support-Nachricht: {e}")

# ============================================================
# SLASH COMMAND: /send-duty-embed
# ============================================================
@bot.tree.command(name="send-duty-embed", description="Sendet die Duty-Toggle-Nachricht in den konfigurierten Kanal.")
@app_commands.default_permissions(administrator=True)
async def send_duty_embed(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    config = await get_config(interaction.guild.id)
    vs_cfg = config.get("voice_support", {})
    if not vs_cfg.get("enabled", False):
        await interaction.followup.send("❌ Voice Support ist nicht aktiviert.")
        return
    duty_embed_channel_id = vs_cfg.get("dutyEmbedChannelId")
    if not duty_embed_channel_id:
        await interaction.followup.send("❌ Kein Kanal für die Duty-Nachricht konfiguriert.")
        return
    duty_on_role_id = vs_cfg.get("dutyOnRoleId")
    duty_off_role_id = vs_cfg.get("dutyOffRoleId")
    if not duty_on_role_id or not duty_off_role_id:
        await interaction.followup.send("❌ Bitte konfiguriere sowohl On-Duty- als auch Off-Duty-Rolle.")
        return
    channel = interaction.guild.get_channel(int(duty_embed_channel_id))
    if not channel:
        await interaction.followup.send("❌ Kanal nicht gefunden.")
        return
    embed = discord.Embed(
        title="🔄 Dienststatus",
        description="Wähle deinen Dienststatus aus:",
        color=0x5865f2,
        timestamp=datetime.now(timezone.utc)
    )
    view = discord.ui.View(timeout=None)
    view.add_item(DutyOnButton(str(interaction.guild.id), duty_on_role_id, duty_off_role_id))
    view.add_item(DutyOffButton(str(interaction.guild.id), duty_off_role_id, duty_on_role_id))
    try:
        msg = await channel.send(embed=embed, view=view)
        bot.add_view(view)
        await interaction.followup.send(f"✅ Duty-Nachricht wurde in {channel.mention} gesendet.")
    except Exception as e:
        await interaction.followup.send(f"❌ Fehler: {e}")

# ============================================================
# ON_READY
# ============================================================
_bot_ready_once = False

@bot.event
async def on_ready():
    global _bot_ready_once
    logger.info(f"✅ Bot ist online als {bot.user} (ID: {bot.user.id})")
    logger.info(f"📊 Bot ist auf {len(bot.guilds)} Servern")

    if _bot_ready_once:
        logger.info("on_ready erneut ausgelöst (Reconnect) – Init wird übersprungen.")
        return
    _bot_ready_once = True

    bot.loop.create_task(status_loop())

    try:
        bot.add_view(AbmeldeView())
    except Exception as e:
        logger.error(f"[ABMELDESYSTEM] Fehler beim Registrieren der persistenten View: {e}")

    for guild in bot.guilds:
        try:
            invites = await guild.invites()
            invites_cache[guild.id] = {inv.code: inv.uses for inv in invites}
            guild_counts = {}
            for inv in invites:
                if inv.inviter and inv.uses > 0:
                    user_id = inv.inviter.id
                    guild_counts[user_id] = guild_counts.get(user_id, 0) + inv.uses
            invite_counts[guild.id] = guild_counts
        except Exception as e:
            logger.warning(f"Invite-Cache für {guild.name}: {e}")

    try:
        synced = await bot.tree.sync()
        logger.info(f"✅ {len(synced)} Slash Commands synchronisiert!")
    except Exception as e:
        logger.error(f"Fehler beim Synchronisieren der Commands: {e}")

    if tickets_collection is not None:
        try:
            open_tickets = await db_call(lambda: list(tickets_collection.find({})))
            for doc in open_tickets:
                try:
                    view = await rebuild_ticket_view(doc)
                    if view is None:
                        # Kanal/Ersteller existiert nicht mehr -> verwaisten DB-Eintrag aufräumen
                        await db_call(tickets_collection.delete_one, {"_id": doc["_id"]})
                        continue
                    bot.add_view(view, message_id=int(doc["messageId"])) if doc.get("messageId") else bot.add_view(view)
                except Exception as e:
                    logger.error(f"[TICKET] Konnte Ticket-View für {doc.get('_id')} nicht wiederherstellen: {e}")
        except Exception as e:
            logger.error(f"[TICKET] Fehler beim Wiederherstellen offener Ticket-Views: {e}")

    if giveaways_collection is not None:
        try:
            active_giveaways = await db_call(lambda: list(giveaways_collection.find({"ended": False})))
            for g in active_giveaways:
                view = GiveawayView(g["_id"], len(g.get("participants", [])))
                bot.add_view(view)
                message_id = g.get("message_id")
                channel_id = g.get("channel_id")
                if message_id and channel_id:
                    channel = bot.get_channel(int(channel_id))
                    if channel:
                        try:
                            message = await channel.fetch_message(int(message_id))
                            await message.edit(view=view)
                        except discord.NotFound:
                            logger.debug(f"[GIVEAWAY] Nachricht {message_id} nicht mehr vorhanden – überspringe View-Aktualisierung.")
                        except Exception as e:
                            logger.warning(f"[GIVEAWAY] Konnte View für {g['_id']} nicht neu verknüpfen: {e}")
                end_time = g.get("end_time")
                if end_time:
                    if end_time.tzinfo is None:
                        end_time = end_time.replace(tzinfo=timezone.utc)
                    if end_time > datetime.now(timezone.utc):
                        asyncio.create_task(schedule_giveaway_end(g["_id"], end_time))
                    else:
                        asyncio.create_task(end_giveaway(g["_id"]))
        except Exception as e:
            logger.error(f"Fehler beim Starten der Giveaway-Timer: {e}")

    if applications_collection is not None:
        try:
            pending_apps = await db_call(lambda: list(applications_collection.find({"status": "pending"})))
            for app in pending_apps:
                view = ApplicationReviewView(app["_id"])
                bot.add_view(view)
                channel_id = app.get("channel_id")
                message_id = app.get("message_id")
                if channel_id and message_id:
                    channel = bot.get_channel(int(channel_id))
                    if channel:
                        try:
                            msg = await channel.fetch_message(int(message_id))
                            await msg.edit(view=view)
                        except discord.NotFound:
                            logger.debug(f"[BEWERBUNG] Nachricht {message_id} nicht mehr vorhanden – überspringe View-Aktualisierung.")
                        except Exception as e:
                            logger.warning(f"[BEWERBUNG] Konnte View für {app['_id']} nicht aktualisieren: {e}")
        except Exception as e:
            logger.error(f"[BEWERBUNG] Fehler beim Registrieren der persistenten Views: {e}")

    for guild in bot.guilds:
        try:
            config = await get_config(guild.id)
            vs_cfg = config.get("voice_support", {})
            if vs_cfg.get("enabled", False):
                duty_on_role_id = vs_cfg.get("dutyOnRoleId")
                duty_off_role_id = vs_cfg.get("dutyOffRoleId")
                if duty_on_role_id:
                    view = discord.ui.View(timeout=None)
                    view.add_item(DutyOnButton(str(guild.id), duty_on_role_id, duty_off_role_id))
                    bot.add_view(view)
                if duty_off_role_id:
                    view = discord.ui.View(timeout=None)
                    view.add_item(DutyOffButton(str(guild.id), duty_off_role_id, duty_on_role_id))
                    bot.add_view(view)
        except Exception as e:
            logger.error(f"[VOICE-SUPPORT] Fehler beim Registrieren der Duty-Views für {guild.name}: {e}")

    for guild in bot.guilds:
        try:
            await update_teamliste(guild)
            await send_ticket_panel(guild)
            await sync_role_nicknames(guild)
            await update_stats_channels(guild)
            await ensure_guessgame_round(guild, "flags")
            await ensure_guessgame_round(guild, "emoji")
        except Exception as e:
            logger.error(f"[STARTUP] Fehler bei {guild.name}: {e}")

    bot.loop.create_task(stats_update_loop())
    bot.loop.create_task(voice_xp_loop())
    bot.loop.create_task(status_embed_loop())
    bot.loop.create_task(application_registration_loop())
    bot.loop.create_task(ttl_cache_cleanup_loop())
    bot.loop.create_task(guild_config_watch_loop())

# ============================================================
# EVENT: ON_MEMBER_UPDATE
# ============================================================
@bot.event
async def on_member_update(before: discord.Member, after: discord.Member):
    if before.roles == after.roles:
        return
    config = await get_config(after.guild.id)
    team_role_ids = set(str(r) for r in config.get("teamliste", {}).get("roles", []))
    before_ids = {str(r.id) for r in before.roles}
    after_ids = {str(r.id) for r in after.roles}
    changed_ids = before_ids ^ after_ids
    if team_role_ids & changed_ids:
        await update_teamliste(after.guild)
    await apply_role_nickname(after)

# ============================================================
# EVENT: ON_MEMBER_JOIN
# ============================================================
@bot.event
async def on_member_join(member):
    config = await get_config(member.guild.id)
    welcome_config = config.get("welcome", {}).get("join", {})
    if not welcome_config.get("enabled", False):
        return
    channel = member.guild.get_channel(int(welcome_config.get("channelId", 0)))
    if not channel:
        return
    text = welcome_config.get("text", "Willkommen {user}!").replace("{user}", member.mention).replace("{username}", member.name).replace("{server}", member.guild.name).replace("{membercount}", str(member.guild.member_count))
    title = welcome_config.get("title", f"Willkommen auf {member.guild.name}!").replace("{user}", member.mention).replace("{username}", member.name).replace("{server}", member.guild.name).replace("{membercount}", str(member.guild.member_count))
    color_hex = welcome_config.get("color", "#ffffff")
    try:
        color = int(color_hex.lstrip('#'), 16)
    except:
        color = 0xffffff
    embed = discord.Embed(title=title, description=text, color=color, timestamp=datetime.now(BERLIN_TZ))
    if welcome_config.get("useAvatarThumbnail", True):
        embed.set_thumbnail(url=member.display_avatar.url)
    image_url = welcome_config.get("image")
    attachments = []
    if image_url:
        if image_url.startswith('data:image'):
            file = base64_to_attachment(image_url, "welcome_image")
            if file:
                attachments.append(file)
                embed.set_image(url=f"attachment://{file.filename}")
        elif image_url.startswith('http'):
            embed.set_image(url=image_url)
    if attachments:
        await channel.send(embed=embed, files=attachments)
    else:
        await channel.send(embed=embed)
    for role_id in welcome_config.get("roles", []):
        role = member.guild.get_role(int(role_id))
        if role:
            try:
                await member.add_roles(role)
            except:
                pass

# ============================================================
# EVENT: ON_MEMBER_REMOVE
# ============================================================
@bot.event
async def on_member_remove(member):
    config = await get_config(member.guild.id)
    leave_config = config.get("welcome", {}).get("leave", {})
    if not leave_config.get("enabled", False):
        return
    channel = member.guild.get_channel(int(leave_config.get("channelId", 0)))
    if not channel:
        return
    text = leave_config.get("text", f"{member.name} hat den Server verlassen.").replace("{user}", member.name).replace("{username}", member.name).replace("{server}", member.guild.name).replace("{membercount}", str(member.guild.member_count))
    title = leave_config.get("title", "Auf Wiedersehen 👋").replace("{user}", member.name).replace("{username}", member.name).replace("{server}", member.guild.name).replace("{membercount}", str(member.guild.member_count))
    color_hex = leave_config.get("color", "#ffffff")
    try:
        color = int(color_hex.lstrip('#'), 16)
    except:
        color = 0xffffff
    embed = discord.Embed(title=title, description=text, color=color, timestamp=datetime.now(BERLIN_TZ))
    if leave_config.get("useAvatarThumbnail", True):
        embed.set_thumbnail(url=member.display_avatar.url)
    image_url = leave_config.get("image")
    attachments = []
    if image_url:
        if image_url.startswith('data:image'):
            file = base64_to_attachment(image_url, "leave_image")
            if file:
                attachments.append(file)
                embed.set_image(url=f"attachment://{file.filename}")
        elif image_url.startswith('http'):
            embed.set_image(url=image_url)
    if attachments:
        await channel.send(embed=embed, files=attachments)
    else:
        await channel.send(embed=embed)

# ============================================================
# EVENT: ON_GUILD_MEMBER_ADD (Invite Tracking)
# ============================================================
@bot.event
async def on_guild_member_add(member):
    guild = member.guild
    cached_invites = invites_cache.get(guild.id, {})
    try:
        new_invites = await guild.invites()
    except:
        return
    used_inviter_id = None
    for inv in new_invites:
        if inv.uses > cached_invites.get(inv.code, 0):
            if inv.inviter:
                used_inviter_id = inv.inviter.id
            break
    invites_cache[guild.id] = {inv.code: inv.uses for inv in new_invites}
    if used_inviter_id:
        if guild.id not in invite_counts:
            invite_counts[guild.id] = {}
        invite_counts[guild.id][used_inviter_id] = invite_counts[guild.id].get(used_inviter_id, 0) + 1

# ============================================================
# MINIGAMES: ZÄHLEN
# ============================================================
async def get_counting_config(guild_id):
    config = await get_config(guild_id)
    return config.get("minigames", {}).get("counting", {})

_counting_state_cache = TTLCache(ttl=300, name="counting_state")

async def get_counting_state(guild_id, channel_id):
    cache_key = f"{guild_id}:{channel_id}"
    cached = _counting_state_cache.get(cache_key)
    if cached is not None:
        return cached
    if counting_collection is None:
        return {"count": 0, "lastUserId": None}
    try:
        doc = await db_call(counting_collection.find_one, {"guildId": str(guild_id), "channelId": str(channel_id)})
        state = {"count": doc.get("count", 0), "lastUserId": doc.get("lastUserId")} if doc else {"count": 0, "lastUserId": None}
        _counting_state_cache.set(cache_key, state)
        return state
    except Exception as e:
        logger.error(f"[MINIGAMES] Fehler beim Laden des Zähler-Standes: {e}")
    return {"count": 0, "lastUserId": None}

async def set_counting_state(guild_id, channel_id, count, last_user_id):
    cache_key = f"{guild_id}:{channel_id}"
    _counting_state_cache.set(cache_key, {"count": count, "lastUserId": str(last_user_id) if last_user_id else None})
    if counting_collection is None:
        return
    try:
        await db_call(
            counting_collection.update_one,
            {"guildId": str(guild_id), "channelId": str(channel_id)},
            {"$set": {"count": count, "lastUserId": str(last_user_id) if last_user_id else None}},
            upsert=True
        )
    except Exception as e:
        logger.error(f"[MINIGAMES] Fehler beim Speichern des Zähler-Standes: {e}")

async def handle_counting_message(message: discord.Message):
    cfg = await get_counting_config(message.guild.id)
    if not cfg.get("enabled"):
        return
    channel_id = cfg.get("channelId")
    if not channel_id or str(message.channel.id) != str(channel_id):
        return
    state = await get_counting_state(message.guild.id, message.channel.id)
    current_count = state["count"]
    last_user_id = state["lastUserId"]
    content = message.content.strip()
    try:
        number = int(content)
    except ValueError:
        try:
            await message.add_reaction("❌")
        except discord.Forbidden:
            pass
        await set_counting_state(message.guild.id, message.channel.id, 0, None)
        await message.channel.send(
            f"❌ {message.author.mention} hat keine Zahl geschrieben! Das Zählen beginnt wieder bei **1**."
        )
        return
    same_user_twice = last_user_id is not None and str(message.author.id) == str(last_user_id)
    expected = current_count + 1
    if same_user_twice or number != expected:
        try:
            await message.add_reaction("❌")
        except discord.Forbidden:
            pass
        await set_counting_state(message.guild.id, message.channel.id, 0, None)
        if same_user_twice:
            reason = "du warst schon beim letzten Mal dran"
        else:
            reason = f"die richtige Zahl wäre **{expected}** gewesen"
        await message.channel.send(
            f"❌ {message.author.mention} hat das Zählen vermasselt ({reason})! Weiter geht's bei **1**."
        )
        return
    try:
        await message.add_reaction("✅")
    except discord.Forbidden:
        pass
    await set_counting_state(message.guild.id, message.channel.id, number, message.author.id)

# ============================================================
# MINIGAMES: FLAGGEN- & EMOJI-RATEN (mit konfigurierbarem Titel)
# ============================================================

FLAG_ITEMS = [
    {"code": "ad", "name": "Andorra"},
    {"code": "ae", "name": "Vereinigte Arabische Emirate"},
    {"code": "af", "name": "Afghanistan"},
    {"code": "ag", "name": "Antigua und Barbuda"},
    {"code": "ai", "name": "Anguilla"},
    {"code": "al", "name": "Albanien"},
    {"code": "am", "name": "Armenien"},
    {"code": "ao", "name": "Angola"},
    {"code": "aq", "name": "Antarktis"},
    {"code": "ar", "name": "Argentinien"},
    {"code": "as", "name": "Amerikanisch-Samoa"},
    {"code": "at", "name": "Österreich"},
    {"code": "au", "name": "Australien"},
    {"code": "aw", "name": "Aruba"},
    {"code": "ax", "name": "Åland"},
    {"code": "az", "name": "Aserbaidschan"},
    {"code": "ba", "name": "Bosnien und Herzegowina"},
    {"code": "bb", "name": "Barbados"},
    {"code": "bd", "name": "Bangladesch"},
    {"code": "be", "name": "Belgien"},
    {"code": "bf", "name": "Burkina Faso"},
    {"code": "bg", "name": "Bulgarien"},
    {"code": "bh", "name": "Bahrain"},
    {"code": "bi", "name": "Burundi"},
    {"code": "bj", "name": "Benin"},
    {"code": "bl", "name": "Saint-Barthélemy"},
    {"code": "bm", "name": "Bermuda"},
    {"code": "bn", "name": "Brunei Darussalam"},
    {"code": "bo", "name": "Bolivien"},
    {"code": "bq", "name": "Bonaire, Sint Eustatius und Saba"},
    {"code": "br", "name": "Brasilien"},
    {"code": "bs", "name": "Bahamas"},
    {"code": "bt", "name": "Bhutan"},
    {"code": "bv", "name": "Bouvetinsel"},
    {"code": "bw", "name": "Botswana"},
    {"code": "by", "name": "Belarus"},
    {"code": "bz", "name": "Belize"},
    {"code": "ca", "name": "Kanada"},
    {"code": "cc", "name": "Kokosinseln"},
    {"code": "cd", "name": "Kongo, Demokratische Republik"},
    {"code": "cf", "name": "Zentralafrikanische Republik"},
    {"code": "cg", "name": "Kongo, Republik"},
    {"code": "ch", "name": "Schweiz"},
    {"code": "ci", "name": "Elfenbeinküste"},
    {"code": "ck", "name": "Cookinseln"},
    {"code": "cl", "name": "Chile"},
    {"code": "cm", "name": "Kamerun"},
    {"code": "cn", "name": "China"},
    {"code": "co", "name": "Kolumbien"},
    {"code": "cr", "name": "Costa Rica"},
    {"code": "cu", "name": "Kuba"},
    {"code": "cv", "name": "Kap Verde"},
    {"code": "cw", "name": "Curaçao"},
    {"code": "cx", "name": "Weihnachtsinsel"},
    {"code": "cy", "name": "Zypern"},
    {"code": "cz", "name": "Tschechien"},
    {"code": "de", "name": "Deutschland"},
    {"code": "dj", "name": "Dschibuti"},
    {"code": "dk", "name": "Dänemark"},
    {"code": "dm", "name": "Dominica"},
    {"code": "do", "name": "Dominikanische Republik"},
    {"code": "dz", "name": "Algerien"},
    {"code": "ec", "name": "Ecuador"},
    {"code": "ee", "name": "Estland"},
    {"code": "eg", "name": "Ägypten"},
    {"code": "eh", "name": "Westsahara"},
    {"code": "er", "name": "Eritrea"},
    {"code": "es", "name": "Spanien"},
    {"code": "et", "name": "Äthiopien"},
    {"code": "fi", "name": "Finnland"},
    {"code": "fj", "name": "Fidschi"},
    {"code": "fk", "name": "Falklandinseln"},
    {"code": "fm", "name": "Mikronesien"},
    {"code": "fo", "name": "Färöer"},
    {"code": "fr", "name": "Frankreich"},
    {"code": "ga", "name": "Gabun"},
    {"code": "gb", "name": "Vereinigtes Königreich"},
    {"code": "gd", "name": "Grenada"},
    {"code": "ge", "name": "Georgien"},
    {"code": "gf", "name": "Französisch-Guayana"},
    {"code": "gg", "name": "Guernsey"},
    {"code": "gh", "name": "Ghana"},
    {"code": "gi", "name": "Gibraltar"},
    {"code": "gl", "name": "Grönland"},
    {"code": "gm", "name": "Gambia"},
    {"code": "gn", "name": "Guinea"},
    {"code": "gp", "name": "Guadeloupe"},
    {"code": "gq", "name": "Äquatorialguinea"},
    {"code": "gr", "name": "Griechenland"},
    {"code": "gs", "name": "Südgeorgien und die Südlichen Sandwichinseln"},
    {"code": "gt", "name": "Guatemala"},
    {"code": "gu", "name": "Guam"},
    {"code": "gw", "name": "Guinea-Bissau"},
    {"code": "gy", "name": "Guyana"},
    {"code": "hk", "name": "Hongkong"},
    {"code": "hm", "name": "Heard und McDonaldinseln"},
    {"code": "hn", "name": "Honduras"},
    {"code": "hr", "name": "Kroatien"},
    {"code": "ht", "name": "Haiti"},
    {"code": "hu", "name": "Ungarn"},
    {"code": "id", "name": "Indonesien"},
    {"code": "ie", "name": "Irland"},
    {"code": "il", "name": "Israel"},
    {"code": "im", "name": "Isle of Man"},
    {"code": "in", "name": "Indien"},
    {"code": "io", "name": "Britisches Territorium im Indischen Ozean"},
    {"code": "iq", "name": "Irak"},
    {"code": "ir", "name": "Iran"},
    {"code": "is", "name": "Island"},
    {"code": "it", "name": "Italien"},
    {"code": "je", "name": "Jersey"},
    {"code": "jm", "name": "Jamaika"},
    {"code": "jo", "name": "Jordanien"},
    {"code": "jp", "name": "Japan"},
    {"code": "ke", "name": "Kenia"},
    {"code": "kg", "name": "Kirgisistan"},
    {"code": "kh", "name": "Kambodscha"},
    {"code": "ki", "name": "Kiribati"},
    {"code": "km", "name": "Komoren"},
    {"code": "kn", "name": "St. Kitts und Nevis"},
    {"code": "kp", "name": "Nordkorea"},
    {"code": "kr", "name": "Südkorea"},
    {"code": "kw", "name": "Kuwait"},
    {"code": "ky", "name": "Kaimaninseln"},
    {"code": "kz", "name": "Kasachstan"},
    {"code": "la", "name": "Laos"},
    {"code": "lb", "name": "Libanon"},
    {"code": "lc", "name": "St. Lucia"},
    {"code": "li", "name": "Liechtenstein"},
    {"code": "lk", "name": "Sri Lanka"},
    {"code": "lr", "name": "Liberia"},
    {"code": "ls", "name": "Lesotho"},
    {"code": "lt", "name": "Litauen"},
    {"code": "lu", "name": "Luxemburg"},
    {"code": "lv", "name": "Lettland"},
    {"code": "ly", "name": "Libyen"},
    {"code": "ma", "name": "Marokko"},
    {"code": "mc", "name": "Monaco"},
    {"code": "md", "name": "Moldawien"},
    {"code": "me", "name": "Montenegro"},
    {"code": "mf", "name": "Saint-Martin"},
    {"code": "mg", "name": "Madagaskar"},
    {"code": "mh", "name": "Marshallinseln"},
    {"code": "mk", "name": "Nordmazedonien"},
    {"code": "ml", "name": "Mali"},
    {"code": "mm", "name": "Myanmar"},
    {"code": "mn", "name": "Mongolei"},
    {"code": "mo", "name": "Macao"},
    {"code": "mp", "name": "Nördliche Marianen"},
    {"code": "mq", "name": "Martinique"},
    {"code": "mr", "name": "Mauretanien"},
    {"code": "ms", "name": "Montserrat"},
    {"code": "mt", "name": "Malta"},
    {"code": "mu", "name": "Mauritius"},
    {"code": "mv", "name": "Malediven"},
    {"code": "mw", "name": "Malawi"},
    {"code": "mx", "name": "Mexiko"},
    {"code": "my", "name": "Malaysia"},
    {"code": "mz", "name": "Mosambik"},
    {"code": "na", "name": "Namibia"},
    {"code": "nc", "name": "Neukaledonien"},
    {"code": "ne", "name": "Niger"},
    {"code": "nf", "name": "Norfolkinsel"},
    {"code": "ng", "name": "Nigeria"},
    {"code": "ni", "name": "Nicaragua"},
    {"code": "nl", "name": "Niederlande"},
    {"code": "no", "name": "Norwegen"},
    {"code": "np", "name": "Nepal"},
    {"code": "nr", "name": "Nauru"},
    {"code": "nu", "name": "Niue"},
    {"code": "nz", "name": "Neuseeland"},
    {"code": "om", "name": "Oman"},
    {"code": "pa", "name": "Panama"},
    {"code": "pe", "name": "Peru"},
    {"code": "pf", "name": "Französisch-Polynesien"},
    {"code": "pg", "name": "Papua-Neuguinea"},
    {"code": "ph", "name": "Philippinen"},
    {"code": "pk", "name": "Pakistan"},
    {"code": "pl", "name": "Polen"},
    {"code": "pm", "name": "St. Pierre und Miquelon"},
    {"code": "pn", "name": "Pitcairninseln"},
    {"code": "pr", "name": "Puerto Rico"},
    {"code": "ps", "name": "Palästina"},
    {"code": "pt", "name": "Portugal"},
    {"code": "pw", "name": "Palau"},
    {"code": "py", "name": "Paraguay"},
    {"code": "qa", "name": "Katar"},
    {"code": "re", "name": "Réunion"},
    {"code": "ro", "name": "Rumänien"},
    {"code": "rs", "name": "Serbien"},
    {"code": "ru", "name": "Russland"},
    {"code": "rw", "name": "Ruanda"},
    {"code": "sa", "name": "Saudi-Arabien"},
    {"code": "sb", "name": "Salomonen"},
    {"code": "sc", "name": "Seychellen"},
    {"code": "sd", "name": "Sudan"},
    {"code": "se", "name": "Schweden"},
    {"code": "sg", "name": "Singapur"},
    {"code": "sh", "name": "St. Helena, Ascension und Tristan da Cunha"},
    {"code": "si", "name": "Slowenien"},
    {"code": "sj", "name": "Svalbard und Jan Mayen"},
    {"code": "sk", "name": "Slowakei"},
    {"code": "sl", "name": "Sierra Leone"},
    {"code": "sm", "name": "San Marino"},
    {"code": "sn", "name": "Senegal"},
    {"code": "so", "name": "Somalia"},
    {"code": "sr", "name": "Suriname"},
    {"code": "ss", "name": "Südsudan"},
    {"code": "st", "name": "São Tomé und Príncipe"},
    {"code": "sv", "name": "El Salvador"},
    {"code": "sx", "name": "Sint Maarten"},
    {"code": "sy", "name": "Syrien"},
    {"code": "sz", "name": "Eswatini"},
    {"code": "tc", "name": "Turks- und Caicosinseln"},
    {"code": "td", "name": "Tschad"},
    {"code": "tf", "name": "Französische Süd- und Antarktisgebiete"},
    {"code": "tg", "name": "Togo"},
    {"code": "th", "name": "Thailand"},
    {"code": "tj", "name": "Tadschikistan"},
    {"code": "tk", "name": "Tokelau"},
    {"code": "tl", "name": "Osttimor"},
    {"code": "tm", "name": "Turkmenistan"},
    {"code": "tn", "name": "Tunesien"},
    {"code": "to", "name": "Tonga"},
    {"code": "tr", "name": "Türkei"},
    {"code": "tt", "name": "Trinidad und Tobago"},
    {"code": "tv", "name": "Tuvalu"},
    {"code": "tw", "name": "Taiwan"},
    {"code": "tz", "name": "Tansania"},
    {"code": "ua", "name": "Ukraine"},
    {"code": "ug", "name": "Uganda"},
    {"code": "um", "name": "Amerikanische Überseeinseln"},
    {"code": "us", "name": "USA"},
    {"code": "uy", "name": "Uruguay"},
    {"code": "uz", "name": "Usbekistan"},
    {"code": "va", "name": "Vatikanstadt"},
    {"code": "vc", "name": "St. Vincent und die Grenadinen"},
    {"code": "ve", "name": "Venezuela"},
    {"code": "vg", "name": "Britische Jungferninseln"},
    {"code": "vi", "name": "Amerikanische Jungferninseln"},
    {"code": "vn", "name": "Vietnam"},
    {"code": "vu", "name": "Vanuatu"},
    {"code": "wf", "name": "Wallis und Futuna"},
    {"code": "ws", "name": "Samoa"},
    {"code": "ye", "name": "Jemen"},
    {"code": "yt", "name": "Mayotte"},
    {"code": "za", "name": "Südafrika"},
    {"code": "zm", "name": "Sambia"},
    {"code": "zw", "name": "Simbabwe"},
]

EMOJI_ITEMS = [
    {"id": "e01", "emoji": "🦁👑", "answers": ["könig der löwen", "der könig der löwen"], "hint": "Ein Disney-Zeichentrickfilm über einen jungen Löwenprinzen."},
    {"id": "e02", "emoji": "🕷️🧑", "answers": ["spiderman", "spider man"], "hint": "Ein Marvel-Superheld, der Netze schießt."},
    {"id": "e03", "emoji": "❄️👸", "answers": ["die eiskönigin", "frozen"], "hint": "Ein Disney-Film über zwei Schwestern und Eismagie."},
    {"id": "e04", "emoji": "🏴‍☠️🚢", "answers": ["fluch der karibik"], "hint": "Eine Piratenfilm-Reihe mit Captain Jack Sparrow."},
    {"id": "e05", "emoji": "🦇🧑", "answers": ["batman"], "hint": "Ein DC-Superheld aus Gotham City."},
    {"id": "e06", "emoji": "🍫🏭", "answers": ["charlie und die schokoladenfabrik"], "hint": "Ein Film über eine geheimnisvolle Fabrik voller Süßigkeiten."},
    {"id": "e07", "emoji": "🧙‍♂️⚡👦", "answers": ["harry potter"], "hint": "Eine Zauberer-Saga über einen Jungen mit Blitznarbe."},
    {"id": "e08", "emoji": "🦖🏝️", "answers": ["jurassic park"], "hint": "Ein Film über eine Insel voller Dinosaurier."},
    {"id": "e09", "emoji": "👽📞🚲", "answers": ["e.t.", "et"], "hint": "Ein Klassiker über einen Außerirdischen und einen Jungen."},
    {"id": "e10", "emoji": "🐠🔍", "answers": ["findet nemo"], "hint": "Ein Pixar-Film über einen kleinen verlorenen Clownfisch."},
    {"id": "e11", "emoji": "🚗🏁🔴", "answers": ["cars"], "hint": "Ein Pixar-Film über sprechende Rennautos."},
    {"id": "e12", "emoji": "🏠🎈", "answers": ["oben", "up"], "hint": "Ein Pixar-Film über ein Haus, das mit Luftballons fliegt."},
    {"id": "e13", "emoji": "🧸🤠", "answers": ["toy story"], "hint": "Ein Pixar-Film über lebendige Spielzeuge."},
    {"id": "e14", "emoji": "💍🌋", "answers": ["herr der ringe", "der herr der ringe"], "hint": "Eine Fantasy-Saga über einen Ring, der zerstört werden muss."},
    {"id": "e15", "emoji": "🐍🪜", "answers": ["schlangen und leitern"], "hint": "Ein bekanntes Brettspiel."},
    {"id": "e16", "emoji": "🌧️☕", "answers": ["regentag"], "hint": "So nennt man einen Tag mit schlechtem Wetter."},
    {"id": "e17", "emoji": "🌅🏃", "answers": ["guten morgen"], "hint": "Das sagt man, wenn man jemanden früh am Tag trifft."},
    {"id": "e18", "emoji": "🌙⭐😴", "answers": ["gute nacht"], "hint": "Das sagt man, bevor man schlafen geht."},
    {"id": "e19", "emoji": "🍎👨‍🏫", "answers": ["lehrer", "lehrerin"], "hint": "Dieser Beruf unterrichtet Kinder in der Schule."},
    {"id": "e20", "emoji": "👨‍🚀🌕", "answers": ["astronaut", "astronautin"], "hint": "Dieser Beruf fliegt ins Weltall."},
    {"id": "e21", "emoji": "🚒🔥", "answers": ["feuerwehrmann", "feuerwehr", "feuerwehrfrau"], "hint": "Dieser Beruf löscht Brände."},
    {"id": "e22", "emoji": "👨‍⚕️🩺", "answers": ["arzt", "ärztin"], "hint": "Dieser Beruf behandelt kranke Menschen."},
    {"id": "e23", "emoji": "👨‍🍳🍳", "answers": ["koch", "köchin"], "hint": "Dieser Beruf kocht in einem Restaurant."},
    {"id": "e24", "emoji": "👷🏗️", "answers": ["bauarbeiter", "bauarbeiterin"], "hint": "Dieser Beruf baut Häuser."},
    {"id": "e25", "emoji": "🍔🍟🥤", "answers": ["fast food"], "hint": "Schnelles, günstiges Essen wie Burger und Pommes."},
    {"id": "e26", "emoji": "🌮🌯", "answers": ["mexikanisch", "mexikanisches essen"], "hint": "Ein Gericht aus Mexiko."},
    {"id": "e27", "emoji": "🍕🍕", "answers": ["pizza"], "hint": "Ein Gericht aus Italien, rund und mit Käse."},
    {"id": "e28", "emoji": "🍣🍱", "answers": ["sushi"], "hint": "Ein japanisches Gericht mit rohem Fisch und Reis."},
    {"id": "e29", "emoji": "🐱🐶", "answers": ["haustiere"], "hint": "Tiere, die oft im Haus leben."},
    {"id": "e30", "emoji": "🐘🦒", "answers": ["savanne"], "hint": "Eine afrikanische Landschaft mit großen Tieren."},
    {"id": "e31", "emoji": "🐧❄️", "answers": ["antarktis", "pinguine"], "hint": "Ein kalter Ort am Südpol."},
    {"id": "e32", "emoji": "🦈🌊", "answers": ["hai", "haie"], "hint": "Ein gefürchteter Fisch im Meer."},
    {"id": "e33", "emoji": "🐺🐷🐷🐷", "answers": ["die drei kleinen schweinchen"], "hint": "Ein bekanntes Märchen mit drei Häusern."},
    {"id": "e34", "emoji": "👧🔴🐺👵", "answers": ["rotkäppchen"], "hint": "Ein Märchen über ein Mädchen mit roter Kapuze."},
    {"id": "e35", "emoji": "👸💤🌹100", "answers": ["dornröschen"], "hint": "Ein Märchen über eine Prinzessin, die 100 Jahre schläft."},
    {"id": "e36", "emoji": "🐸👑💋", "answers": ["der froschkönig"], "hint": "Ein Märchen über einen verzauberten Frosch."},
    {"id": "e37", "emoji": "🧙‍♂️🏰", "answers": ["zauberer", "magier"], "hint": "Eine Person, die Magie beherrscht."},
    {"id": "e38", "emoji": "🌋🔥", "answers": ["vulkanausbruch"], "hint": "Ein Berg, der Feuer spuckt."},
    {"id": "e39", "emoji": "🌪️💨", "answers": ["tornado", "wirbelsturm"], "hint": "Ein heftiger Wirbelsturm."},
    {"id": "e40", "emoji": "🏔️❄️", "answers": ["berg", "schneeberg"], "hint": "Ein hoher, eisiger Gipfel."},
    {"id": "e41", "emoji": "⚽🥅", "answers": ["fußball"], "hint": "Der beliebteste Sport der Welt."},
    {"id": "e42", "emoji": "🏀🏀", "answers": ["basketball"], "hint": "Ein Sport mit einem großen orangenen Ball."},
    {"id": "e43", "emoji": "🎾🏸", "answers": ["tennis"], "hint": "Ein Sport mit Schläger und Ball."},
    {"id": "e44", "emoji": "🏊‍♂️🌊", "answers": ["schwimmen"], "hint": "Eine Sportart im Wasser."},
    {"id": "e45", "emoji": "🐘🐭", "answers": ["elefant und maus"], "hint": "Ein Sprichwort über Größenunterschiede."},
    {"id": "e46", "emoji": "🐢🐇", "answers": ["hase und igel", "hase und schildkröte"], "hint": "Eine bekannte Fabel über ein Rennen."},
    {"id": "e47", "emoji": "🐺🐑", "answers": ["wolf im schafspelz"], "hint": "Eine Redewendung über Täuschung."},
    {"id": "e48", "emoji": "🐓🌅", "answers": ["hahnenschrei", "morgen"], "hint": "Ein Geräusch am frühen Morgen."},
    {"id": "e49", "emoji": "🎂🎉🎁", "answers": ["geburtstag"], "hint": "An diesem Tag im Jahr wird man ein Jahr älter."},
    {"id": "e50", "emoji": "💻🖱️", "answers": ["computer", "pc"], "hint": "Ein Gerät für Arbeit und Unterhaltung."},
    {"id": "e51", "emoji": "📱💬", "answers": ["smartphone", "handy"], "hint": "Ein tragbares Telefon."},
    {"id": "e52", "emoji": "🚀🌍", "answers": ["raketenstart", "weltraum"], "hint": "Ein Flug ins All."},
]

_UMLAUT_MAP = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})

def normalize_guess(text: str) -> str:
    text = (text or "").strip().lower()
    text = text.translate(_UMLAUT_MAP)
    text = re.sub(r"[^\w\s]", "", text, flags=re.UNICODE)
    text = re.sub(r"\s+", " ", text).strip()
    return text

FLAG_ITEMS_NORM = [
    {
        "id": c["code"],
        "answers": [c["name"]],
        "hint": f"Der Name des Landes hat {len(c['name'])} Buchstaben.",
        "image": f"https://flagcdn.com/w320/{c['code']}.png",
        "display_emoji": None,
    }
    for c in FLAG_ITEMS
]
EMOJI_ITEMS_NORM = [
    {"id": e["id"], "answers": e["answers"], "hint": e["hint"], "image": None, "display_emoji": e["emoji"]}
    for e in EMOJI_ITEMS
]

GUESSGAME_ITEMS = {"flags": FLAG_ITEMS_NORM, "emoji": EMOJI_ITEMS_NORM}
GUESSGAME_META = {
    "flags": {"title": "🏳️ Errate die Flagge!", "prompt": "Welches Land gehört zu dieser Flagge? Schreib deine Antwort einfach in den Chat!", "color": 0x2b6cb0},
    "emoji": {"title": "🧩 Errate die Emoji-Kombination!", "prompt": "Welcher Begriff/Film/Titel steckt hinter diesen Emojis? Schreib deine Antwort einfach in den Chat!", "color": 0xd69e2e},
}

_quiz_leaderboard_cache = TTLCache(ttl=30, name="quiz_leaderboard")

async def update_quiz_stats(guild_id: str, user_id: str, game_type: str):
    if quiz_stats_collection is None:
        return
    try:
        await db_call(
            quiz_stats_collection.update_one,
            {"guildId": str(guild_id), "userId": str(user_id), "game": game_type},
            {"$inc": {"correct": 1}},
            upsert=True
        )
    except Exception as e:
        logger.error(f"[QUIZ-STATS] Fehler beim Aktualisieren: {e}")

async def get_quiz_leaderboard(guild_id: str, game_type: str, limit: int = 10):
    cache_key = f"{guild_id}:{game_type}:{limit}"
    cached = _quiz_leaderboard_cache.get(cache_key, "__miss__")
    if cached != "__miss__":
        return cached
    if quiz_stats_collection is None:
        return []
    try:
        cursor = quiz_stats_collection.find({"guildId": str(guild_id), "game": game_type}).sort("correct", -1).limit(limit)
        docs = await db_call(cursor.to_list, length=limit)
        _quiz_leaderboard_cache.set(cache_key, docs)
        return docs
    except Exception as e:
        logger.error(f"[QUIZ-STATS] Fehler beim Laden des Leaderboards: {e}")
        return []

def get_guessgame_item(game_key: str, item_id: str):
    for it in GUESSGAME_ITEMS.get(game_key, []):
        if it["id"] == item_id:
            return it
    return None

def pick_guessgame_item(game_key: str, exclude_id: str = None):
    items = GUESSGAME_ITEMS.get(game_key, [])
    pool = [it for it in items if it["id"] != exclude_id] or items
    return random.choice(pool)

async def get_guessgame_config(guild_id, game_key: str) -> dict:
    config = await get_config(guild_id)
    return config.get("minigames", {}).get(game_key, {})

_guessgame_state_cache = TTLCache(ttl=300, name="guessgame_state")

async def get_guessgame_state(guild_id, channel_id, game_key: str):
    cache_key = f"{guild_id}:{channel_id}:{game_key}"
    cached = _guessgame_state_cache.get(cache_key, "__miss__")
    if cached != "__miss__":
        return cached
    if minigame_rounds_collection is None:
        return None
    try:
        doc = await db_call(
            minigame_rounds_collection.find_one,
            {"guildId": str(guild_id), "channelId": str(channel_id), "game": game_key}
        )
        _guessgame_state_cache.set(cache_key, doc)
        return doc
    except Exception as e:
        logger.error(f"[MINIGAMES] Fehler beim Laden des {game_key}-Status: {e}")
        return None

async def set_guessgame_state(guild_id, channel_id, game_key: str, data: dict):
    cache_key = f"{guild_id}:{channel_id}:{game_key}"
    _guessgame_state_cache.set(cache_key, data)
    if minigame_rounds_collection is None:
        return
    try:
        await db_call(
            minigame_rounds_collection.update_one,
            {"guildId": str(guild_id), "channelId": str(channel_id), "game": game_key},
            {"$set": data},
            upsert=True
        )
    except Exception as e:
        logger.error(f"[MINIGAMES] Fehler beim Speichern des {game_key}-Status: {e}")

async def clear_guessgame_state(guild_id, channel_id, game_key: str):
    cache_key = f"{guild_id}:{channel_id}:{game_key}"
    _guessgame_state_cache.invalidate(cache_key)
    if minigame_rounds_collection is None:
        return
    try:
        await db_call(
            minigame_rounds_collection.delete_one,
            {"guildId": str(guild_id), "channelId": str(channel_id), "game": game_key}
        )
    except Exception as e:
        logger.error(f"[MINIGAMES] Fehler beim Löschen des {game_key}-Status: {e}")

# ============================================================
# NEU: build_guessgame_embed mit konfigurierbarem Titel
# ============================================================
def build_guessgame_embed(game_key: str, item: dict, config: dict) -> discord.Embed:
    meta = GUESSGAME_META[game_key]
    game_cfg = config.get("minigames", {}).get(game_key, {})
    title = game_cfg.get("title") or meta["title"]
    embed = discord.Embed(title=title, description=meta["prompt"], color=meta["color"])
    if item.get("image"):
        embed.set_image(url=item["image"])
    if item.get("display_emoji"):
        embed.add_field(name="\u200b", value=f"# {item['display_emoji']}", inline=False)
    embed.set_footer(text="APEX Minigames")
    return embed

def build_guessgame_view(game_key: str, buttons_cfg: dict) -> discord.ui.View:
    view = discord.ui.View(timeout=None)
    if buttons_cfg.get("skip", True):
        view.add_item(discord.ui.Button(label="Überspringen", emoji="⏭️", style=discord.ButtonStyle.secondary, custom_id=f"gg_skip_{game_key}"))
    if buttons_cfg.get("hint", True):
        view.add_item(discord.ui.Button(label="Tipp", emoji="💡", style=discord.ButtonStyle.secondary, custom_id=f"gg_hint_{game_key}"))
    if buttons_cfg.get("firstLetter", True):
        view.add_item(discord.ui.Button(label="Erster Buchstabe", emoji="🔤", style=discord.ButtonStyle.secondary, custom_id=f"gg_letter_{game_key}"))
    return view

async def start_guessgame_round(guild: discord.Guild, channel_id, game_key: str, exclude_id: str = None):
    channel = guild.get_channel(int(channel_id))
    if not channel:
        return
    cfg = await get_guessgame_config(guild.id, game_key)
    if not cfg.get("enabled") or str(cfg.get("channelId")) != str(channel_id):
        return
    item = pick_guessgame_item(game_key, exclude_id)
    # gesamte Server-Config für den Titel übergeben
    full_config = await get_config(guild.id)
    embed = build_guessgame_embed(game_key, item, full_config)
    view = build_guessgame_view(game_key, cfg.get("buttons", {}))
    try:
        message = await channel.send(embed=embed, view=view)
    except discord.Forbidden:
        logger.warning(f"[MINIGAMES] Keine Berechtigung, {game_key}-Runde in {channel} zu senden.")
        return
    except Exception as e:
        logger.error(f"[MINIGAMES] Fehler beim Senden der {game_key}-Runde: {e}")
        return
    await set_guessgame_state(guild.id, channel_id, game_key, {
        "itemId": item["id"], "messageId": str(message.id), "hintUsed": False, "letterUsed": False
    })

async def ensure_guessgame_round(guild: discord.Guild, game_key: str):
    cfg = await get_guessgame_config(guild.id, game_key)
    if not cfg.get("enabled") or not cfg.get("channelId"):
        return
    channel_id = cfg["channelId"]
    state = await get_guessgame_state(guild.id, channel_id, game_key)
    if state:
        return
    await start_guessgame_round(guild, channel_id, game_key)

async def handle_guessgame_message(message: discord.Message, game_key: str):
    cfg = await get_guessgame_config(message.guild.id, game_key)
    if not cfg.get("enabled"):
        return
    channel_id = cfg.get("channelId")
    if not channel_id or str(message.channel.id) != str(channel_id):
        return
    state = await get_guessgame_state(message.guild.id, message.channel.id, game_key)
    if not state:
        await start_guessgame_round(message.guild, message.channel.id, game_key)
        return
    item = get_guessgame_item(game_key, state.get("itemId"))
    if not item:
        await clear_guessgame_state(message.guild.id, message.channel.id, game_key)
        await start_guessgame_round(message.guild, message.channel.id, game_key)
        return
    guess = normalize_guess(message.content)
    if not guess:
        return
    valid_answers = {normalize_guess(a) for a in item["answers"]}
    if guess in valid_answers:
        try:
            await message.add_reaction("✅")
        except discord.Forbidden:
            pass
        correct_name = item["answers"][0]
        await message.channel.send(f"🎉 {message.author.mention} hat richtig geraten! Die Antwort war **{correct_name}**.")
        await update_quiz_stats(message.guild.id, message.author.id, game_key)
        await clear_guessgame_state(message.guild.id, message.channel.id, game_key)
        await start_guessgame_round(message.guild, message.channel.id, game_key, exclude_id=item["id"])

# ============================================================
# AUTOMOD (mit konfigurierbarem Log-Titel)
# ============================================================
automod_message_times = defaultdict(deque)
automod_message_cache = defaultdict(list)
LINK_REGEX = re.compile(r"(https?://\S+|www\.\S+\.\S+|discord\.gg/\S+)", re.IGNORECASE)

async def get_automod_config(guild_id):
    config = await get_config(guild_id)
    return config.get("automod", {})

def is_automod_whitelisted(member: discord.Member, channel, cfg: dict) -> bool:
    try:
        if member.guild_permissions.administrator:
            return True
    except AttributeError:
        pass
    whitelist = cfg.get("whitelist", {})
    if str(channel.id) in whitelist.get("channelIds", []):
        return True
    if str(member.id) in whitelist.get("userIds", []):
        return True
    member_role_ids = {str(r.id) for r in member.roles}
    if member_role_ids.intersection(set(whitelist.get("roleIds", []))):
        return True
    return False

# ============================================================
# NEU: automod_log mit konfigurierbarem Titel
# ============================================================
async def automod_log(guild: discord.Guild, cfg: dict, title: str, description: str, color: int = 0xff5555):
    log_channel_id = cfg.get("logChannelId")
    if not log_channel_id:
        return
    channel = guild.get_channel(int(log_channel_id))
    if not channel:
        return
    log_title = cfg.get("title") or "🛡️ Automod"
    embed = discord.Embed(title=log_title, description=description, color=color, timestamp=datetime.now(BERLIN_TZ))
    try:
        await channel.send(embed=embed)
    except Exception as e:
        logger.warning(f"[AUTOMOD] Fehler beim Senden ins Log: {e}")

async def apply_automod_punishment(message: discord.Message, section_cfg: dict, reason: str):
    try:
        warn_msg = await message.channel.send(f"⚠️ {message.author.mention}, {reason}")
        await asyncio.sleep(5)
        try:
            await warn_msg.delete()
        except (discord.Forbidden, discord.NotFound):
            pass
    except discord.Forbidden:
        pass
    if section_cfg.get("action") == "delete_timeout":
        try:
            timeout_seconds = max(10, int(section_cfg.get("timeoutSeconds", 60)))
        except (TypeError, ValueError):
            timeout_seconds = 60
        try:
            await message.author.timeout(timedelta(seconds=timeout_seconds), reason=f"[AUTOMOD] {reason}")
        except discord.Forbidden:
            logger.warning(f"[AUTOMOD] Keine Berechtigung, {message.author} zu timeouten.")
        except Exception as e:
            logger.warning(f"[AUTOMOD] Fehler beim Timeout von {message.author}: {e}")

async def handle_automod_links(message: discord.Message, cfg: dict) -> bool:
    links_cfg = cfg.get("links", {})
    if not links_cfg.get("enabled", False):
        return False
    if not LINK_REGEX.search(message.content or ""):
        return False
    try:
        await message.delete()
    except (discord.Forbidden, discord.NotFound):
        pass
    await apply_automod_punishment(message, links_cfg, "Links sind auf diesem Server nicht erlaubt.")
    await automod_log(
        message.guild, cfg,
        "🔗 Automod: Link gelöscht",
        f"**Nutzer:** {message.author.mention} (`{message.author.id}`)\n"
        f"**Kanal:** {message.channel.mention}\n"
        f"**Inhalt:** {(message.content or '*[kein Text]*')[:500]}"
    )
    return True

async def handle_automod_spam(message: discord.Message, cfg: dict) -> bool:
    spam_cfg = cfg.get("spam", {})
    if not spam_cfg.get("enabled", False):
        return False
    try:
        max_messages = max(2, int(spam_cfg.get("maxMessages", 5)))
    except (TypeError, ValueError):
        max_messages = 5
    try:
        per_seconds = max(1, int(spam_cfg.get("perSeconds", 5)))
    except (TypeError, ValueError):
        per_seconds = 5
    key = (message.guild.id, message.channel.id, message.author.id)
    now = datetime.now(BERLIN_TZ).timestamp()
    times = automod_message_times[key]
    times.append(now)
    while times and now - times[0] > per_seconds:
        times.popleft()
    cache = automod_message_cache[key]
    cache.append(message)
    if len(cache) > max_messages:
        cache.pop(0)
    if len(times) <= max_messages:
        return False
    messages_to_delete = automod_message_cache.pop(key, [])
    times.clear()
    for msg in messages_to_delete:
        try:
            await msg.delete()
        except (discord.Forbidden, discord.NotFound, discord.HTTPException):
            pass
    await apply_automod_punishment(message, spam_cfg, "bitte nicht spammen!")
    await automod_log(
        message.guild, cfg,
        "🚫 Automod: Spam erkannt",
        f"**Nutzer:** {message.author.mention} (`{message.author.id}`)\n"
        f"**Kanal:** {message.channel.mention}\n"
        f"**Regel:** mehr als {max_messages} Nachrichten in {per_seconds}s"
    )
    return True

async def handle_automod(message: discord.Message) -> bool:
    if not message.guild or message.author.bot:
        return False
    if not isinstance(message.author, discord.Member):
        return False
    cfg = await get_automod_config(message.guild.id)
    if not cfg.get("enabled", False):
        return False
    if is_automod_whitelisted(message.author, message.channel, cfg):
        return False
    if await handle_automod_links(message, cfg):
        return True
    if await handle_automod_spam(message, cfg):
        return True
    return False

# ============================================================
# LEVEL-SYSTEM
# ============================================================
def get_xp_for_level(level: int, lvl_cfg: dict) -> int:
    base_xp = lvl_cfg.get("baseXp", 100)
    increment = lvl_cfg.get("xpIncrement", 50)
    return max(base_xp + (level * increment), 1)

async def add_level_xp(guild_id, user_id, amount: int):
    if levels_collection is None:
        return None
    try:
        doc = await db_call(
            levels_collection.find_one_and_update,
            {"guildId": str(guild_id), "userId": str(user_id)},
            {"$inc": {"xp": amount}, "$setOnInsert": {"level": 0}},
            upsert=True,
            return_document=ReturnDocument.AFTER
        )
        return doc
    except Exception as e:
        logger.error(f"[LEVELS] Fehler beim Hinzufügen von XP: {e}")
        return None

async def check_level_up(guild: discord.Guild, member: discord.Member, doc: dict, lvl_cfg: dict, fallback_channel=None):
    if not doc:
        return
    xp = doc.get("xp", 0)
    level = doc.get("level", 0)
    leveled_up = False
    while xp >= get_xp_for_level(level, lvl_cfg):
        xp -= get_xp_for_level(level, lvl_cfg)
        level += 1
        leveled_up = True
    if not leveled_up:
        return
    try:
        await db_call(
            levels_collection.update_one,
            {"guildId": str(guild.id), "userId": str(member.id)},
            {"$set": {"xp": xp, "level": level}}
        )
    except Exception as e:
        logger.error(f"[LEVELS] Fehler beim Speichern des Levels: {e}")
        return
    channel_id = lvl_cfg.get("channelId")
    channel = guild.get_channel(int(channel_id)) if channel_id else fallback_channel
    if not channel:
        return
    template = lvl_cfg.get("levelUpMessage") or "🎉 {user} hat **Level {level}** erreicht!"
    text = template.replace("{user}", member.mention).replace("{username}", member.name).replace("{level}", str(level))
    try:
        await channel.send(text)
        logger.info(f"[LEVELS] {member} ist jetzt Level {level} in {guild.name}")
    except discord.Forbidden:
        logger.warning(f"[LEVELS] Keine Berechtigung, Level-Up-Nachricht in {channel} zu senden.")
    except discord.HTTPException as e:
        logger.warning(f"[LEVELS] Fehler beim Senden der Level-Up-Nachricht: {e}")

async def handle_level_xp(message: discord.Message):
    if levels_collection is None:
        return
    config = await get_config(message.guild.id)
    lvl_cfg = config.get("levels", {})
    if not lvl_cfg.get("enabled", False):
        return
    guild_id = message.guild.id
    user_id = message.author.id
    cooldown = lvl_cfg.get("cooldownSeconds", 60)
    now = datetime.now(BERLIN_TZ)
    cache_key = (guild_id, user_id)
    last = level_xp_cooldowns.get(cache_key)
    if last and (now - last).total_seconds() < cooldown:
        return
    level_xp_cooldowns[cache_key] = now
    xp_min = lvl_cfg.get("xpMin", 15)
    xp_max = lvl_cfg.get("xpMax", 25)
    amount = random.randint(min(xp_min, xp_max), max(xp_min, xp_max))
    doc = await add_level_xp(guild_id, user_id, amount)
    await check_level_up(message.guild, message.author, doc, lvl_cfg, fallback_channel=message.channel)

async def voice_xp_loop():
    await bot.wait_until_ready()
    while not bot.is_closed():
        for guild in bot.guilds:
            try:
                config = await get_config(guild.id)
                lvl_cfg = config.get("levels", {})
                voice_cfg = lvl_cfg.get("voice", {})
                if not lvl_cfg.get("enabled", False) or not voice_cfg.get("enabled", False):
                    continue
                amount = voice_cfg.get("xpPerMinute", 10)
                afk_channel_id = guild.afk_channel.id if guild.afk_channel else None
                for vc in guild.voice_channels:
                    if vc.id == afk_channel_id:
                        continue
                    for member in vc.members:
                        if member.bot or member.voice is None:
                            continue
                        if member.voice.self_mute or member.voice.self_deaf or member.voice.afk:
                            continue
                        doc = await add_level_xp(guild.id, member.id, amount)
                        await check_level_up(guild, member, doc, lvl_cfg, fallback_channel=None)
            except Exception as e:
                logger.error(f"[LEVELS] Voice-XP-Fehler bei {guild.name}: {e}")
        await asyncio.sleep(60)

async def get_levels_config(guild_id):
    config = await get_config(guild_id)
    return config.get("levels", {})

@bot.tree.command(name="xp_give", description="Vergibt (oder entzieht) einem Mitglied XP im Level-System.")
@app_commands.describe(user="Mitglied, das XP erhalten soll", amount="Anzahl XP (negative Zahl entzieht XP)")
async def xp_give(interaction: discord.Interaction, user: discord.Member, amount: int):
    await interaction.response.defer(ephemeral=True)
    guild = interaction.guild
    lvl_cfg = await get_levels_config(guild.id)
    give_role_id = lvl_cfg.get("xpGiveRoleId")
    is_admin = interaction.user.guild_permissions.administrator
    user_role_ids = {str(r.id) for r in interaction.user.roles}
    has_role = bool(give_role_id) and give_role_id in user_role_ids
    if not (is_admin or has_role):
        await interaction.followup.send("❌ Du hast keine Berechtigung, diesen Befehl zu nutzen.")
        return
    if user.bot:
        await interaction.followup.send("❌ Bots können keine XP erhalten.")
        return
    if amount == 0:
        await interaction.followup.send("❌ Bitte gib einen Wert ungleich 0 an.")
        return
    if levels_collection is None:
        await interaction.followup.send("❌ Datenbank nicht verfügbar.")
        return
    doc = await add_level_xp(guild.id, user.id, amount)
    if doc is None:
        await interaction.followup.send("❌ Fehler beim Vergeben der XP.")
        return
    if doc.get("xp", 0) < 0:
        try:
            await db_call(
                levels_collection.update_one,
                {"guildId": str(guild.id), "userId": str(user.id)},
                {"$set": {"xp": 0}}
            )
            doc["xp"] = 0
        except Exception as e:
            logger.error(f"[LEVELS] Fehler beim Begrenzen der XP: {e}")
    await check_level_up(guild, user, doc, lvl_cfg, fallback_channel=interaction.channel)
    verb = "erhalten" if amount > 0 else "verloren"
    await interaction.followup.send(
        f"✅ {user.mention} hat **{abs(amount)} XP** {verb}. (Level: {doc.get('level', 0)}, XP: {doc.get('xp', 0)})"
    )
    logger.info(f"[LEVELS] {interaction.user} hat {amount} XP an {user} in {guild.name} angepasst.")

@bot.event
async def on_message(message: discord.Message):
    if message.author.bot or message.guild is None:
        await bot.process_commands(message)
        return
    try:
        deleted = await handle_automod(message)
    except Exception as e:
        logger.error(f"[AUTOMOD] Fehler: {e}")
        deleted = False
    if deleted:
        return
    try:
        await handle_counting_message(message)
    except Exception as e:
        logger.error(f"[MINIGAMES] Fehler im Zählen-Spiel: {e}")
    try:
        await handle_guessgame_message(message, "flags")
    except Exception as e:
        logger.error(f"[MINIGAMES] Fehler im Flaggen-Spiel: {e}")
    try:
        await handle_guessgame_message(message, "emoji")
    except Exception as e:
        logger.error(f"[MINIGAMES] Fehler im Emoji-Spiel: {e}")
    try:
        await handle_level_xp(message)
    except Exception as e:
        logger.error(f"[LEVELS] Fehler bei der XP-Vergabe: {e}")
    await bot.process_commands(message)

# ============================================================
# REACTION ROLES
# ============================================================
async def get_reactionrole_panel_by_message(guild_id, message_id):
    config = await get_config(guild_id)
    panels = config.get("reactionroles", {}).get("panels", [])
    for panel in panels:
        if panel.get("messageId") and str(panel["messageId"]) == str(message_id):
            return panel
    return None

def find_reactionrole_mapping(panel: dict, emoji: discord.PartialEmoji):
    for mapping in panel.get("mappings", []):
        stored = mapping.get("emoji")
        if not stored:
            continue
        try:
            stored_emoji = discord.PartialEmoji.from_str(stored)
        except Exception:
            if str(emoji) == stored:
                return mapping
            continue
        if stored_emoji.id and emoji.id:
            if stored_emoji.id == emoji.id:
                return mapping
        elif not stored_emoji.id and not emoji.id:
            if stored_emoji.name == emoji.name:
                return mapping
    return None

@bot.event
async def on_raw_reaction_add(payload: discord.RawReactionActionEvent):
    if payload.guild_id is None:
        return
    if payload.member is None or payload.member.bot:
        return
    panel = await get_reactionrole_panel_by_message(payload.guild_id, payload.message_id)
    if not panel:
        return
    mapping = find_reactionrole_mapping(panel, payload.emoji)
    if not mapping:
        return
    guild = bot.get_guild(payload.guild_id)
    if not guild:
        return
    role = guild.get_role(int(mapping["roleId"]))
    if not role:
        return
    try:
        await payload.member.add_roles(role, reason="[REACTIONROLES] Reaktion hinzugefügt")
    except discord.Forbidden:
        logger.warning(f"[REACTIONROLES] Keine Berechtigung, Rolle {role} an {payload.member} zu vergeben.")
    except Exception as e:
        logger.warning(f"[REACTIONROLES] Fehler beim Vergeben der Rolle: {e}")

@bot.event
async def on_raw_reaction_remove(payload: discord.RawReactionActionEvent):
    if payload.guild_id is None:
        return
    panel = await get_reactionrole_panel_by_message(payload.guild_id, payload.message_id)
    if not panel:
        return
    mapping = find_reactionrole_mapping(panel, payload.emoji)
    if not mapping:
        return
    guild = bot.get_guild(payload.guild_id)
    if not guild:
        return
    member = guild.get_member(payload.user_id)
    if member is None:
        try:
            member = await guild.fetch_member(payload.user_id)
        except discord.NotFound:
            return
        except Exception as e:
            logger.warning(f"[REACTIONROLES] Konnte Mitglied nicht laden: {e}")
            return
    if member.bot:
        return
    role = guild.get_role(int(mapping["roleId"]))
    if not role:
        return
    try:
        await member.remove_roles(role, reason="[REACTIONROLES] Reaktion entfernt")
    except discord.Forbidden:
        logger.warning(f"[REACTIONROLES] Keine Berechtigung, Rolle {role} von {member} zu entfernen.")
    except Exception as e:
        logger.warning(f"[REACTIONROLES] Fehler beim Entfernen der Rolle: {e}")

# ============================================================
# SLASH COMMANDS - OPTIMIERT MIT SOFORTIGEM DEFER
# ============================================================

@bot.tree.command(name="teamliste", description="Zeigt die aktuelle Teamliste für diesen Server an.")
async def teamliste(interaction: discord.Interaction):
    await interaction.response.defer()
    embed = await build_teamliste_embed(interaction.guild)
    await interaction.followup.send(embed=embed)

# ============================================================
# RP INFO (/rp_start, /rp_stop)
# ============================================================
def _rp_format_placeholders(text: str, member: discord.Member, guild: discord.Guild) -> str:
    if not text:
        return text
    return (text
            .replace("{user}", member.mention)
            .replace("{username}", member.display_name)
            .replace("{server}", guild.name))

def _rp_has_permission(member: discord.Member, rp_cfg: dict) -> bool:
    if member.guild_permissions.administrator:
        return True
    role_ids = rp_cfg.get("allowedRoles", [])
    if not role_ids:
        return False
    member_role_ids = {str(r.id) for r in member.roles}
    return any(rid in member_role_ids for rid in role_ids)

@bot.tree.command(name="rp_start", description="Startet das Roleplay und postet die konfigurierte RP-Info-Nachricht.")
async def rp_start(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    guild = interaction.guild
    config = await get_config(guild.id)
    rp_cfg = config.get("rp", {})

    if not _rp_has_permission(interaction.user, rp_cfg):
        await interaction.followup.send("❌ Du hast keine Berechtigung, diesen Befehl zu nutzen.", ephemeral=True)
        return

    channel_id = rp_cfg.get("channelId")
    if not channel_id:
        await interaction.followup.send("❌ Es wurde kein Kanal für RP-Nachrichten konfiguriert (Dashboard → RP Info).", ephemeral=True)
        return
    channel = guild.get_channel(int(channel_id))
    if not channel:
        await interaction.followup.send("❌ Der konfigurierte Kanal wurde nicht gefunden.", ephemeral=True)
        return

    title = _rp_format_placeholders(rp_cfg.get("title") or "🎭 Roleplay gestartet", interaction.user, guild)
    text = _rp_format_placeholders(rp_cfg.get("text") or "Das Roleplay wurde gestartet!", interaction.user, guild)
    mode = rp_cfg.get("mode", "embed")

    try:
        if mode == "text":
            content = f"**{title}**\n{text}" if title else text
            sent = await channel.send(content)
        else:
            try:
                color_int = int((rp_cfg.get("color") or "#5865f2").lstrip("#"), 16)
            except ValueError:
                color_int = 0x5865F2
            embed = discord.Embed(title=title, description=text, color=color_int)
            image = rp_cfg.get("image")
            if image and image.startswith("http"):
                embed.set_image(url=image)
            embed.timestamp = datetime.now(BERLIN_TZ)
            sent = await channel.send(embed=embed)
    except discord.Forbidden:
        await interaction.followup.send("❌ Ich habe keine Berechtigung, in diesem Kanal zu schreiben.", ephemeral=True)
        return
    except Exception as e:
        logger.error(f"[RP] Fehler beim Senden der RP-Start-Nachricht: {e}")
        await interaction.followup.send("❌ Fehler beim Senden der Nachricht.", ephemeral=True)
        return

    if guild_configs is not None:
        await db_call(
            guild_configs.update_one,
            {"guildId": str(guild.id)},
            {"$set": {"rpMeta": {"messageId": str(sent.id), "channelId": str(channel.id), "active": True}}},
            upsert=True,
        )
    await interaction.followup.send(f"✅ Roleplay gestartet in {channel.mention}.", ephemeral=True)

@bot.tree.command(name="rp_stop", description="Beendet das aktuell laufende Roleplay.")
async def rp_stop(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    guild = interaction.guild
    config = await get_config(guild.id)
    rp_cfg = config.get("rp", {})

    if not _rp_has_permission(interaction.user, rp_cfg):
        await interaction.followup.send("❌ Du hast keine Berechtigung, diesen Befehl zu nutzen.", ephemeral=True)
        return

    if guild_configs is None:
        await interaction.followup.send("❌ Datenbank nicht verfügbar.", ephemeral=True)
        return

    doc = await db_call(guild_configs.find_one, {"guildId": str(guild.id)})
    meta = (doc or {}).get("rpMeta", {}) or {}
    if not meta.get("active"):
        await interaction.followup.send("ℹ️ Es läuft aktuell kein Roleplay.", ephemeral=True)
        return

    channel = guild.get_channel(int(meta["channelId"])) if meta.get("channelId") else None
    if channel:
        try:
            message = await channel.fetch_message(int(meta["messageId"]))
            if message.embeds:
                embed = message.embeds[0]
                embed.title = f"🔴 {embed.title} (beendet)" if embed.title else "🔴 Roleplay beendet"
                embed.color = discord.Color.red()
                await message.edit(embed=embed)
            elif message.content:
                await message.edit(content=f"{message.content}\n\n🔴 **Roleplay beendet.**")
        except (discord.NotFound, discord.Forbidden, discord.HTTPException):
            pass
        try:
            await channel.send(f"🔴 Das Roleplay wurde von {interaction.user.mention} beendet.")
        except discord.Forbidden:
            pass

    await db_call(
        guild_configs.update_one,
        {"guildId": str(guild.id)},
        {"$set": {"rpMeta.active": False}},
    )
    await interaction.followup.send("✅ Roleplay beendet.", ephemeral=True)

# ============================================================
# TEAMUPDATE / TEAM-MANAGEMENT COMMANDS (OPTIMIERT)
# ============================================================

async def get_teamupdate_command_config(guild_id, cmd_key: str):
    config = await get_config(guild_id)
    tu_cfg = config.get("teamupdate", {})
    cmd_cfg = tu_cfg.get("commands", {}).get(cmd_key, {})
    return tu_cfg, cmd_cfg

def is_command_enabled(cmd_cfg: dict) -> bool:
    return cmd_cfg.get("enabled", True)

def has_command_permission(member: discord.Member, cmd_cfg: dict) -> bool:
    if member.guild_permissions.administrator:
        return True
    role_ids = cmd_cfg.get("roles", [])
    if not role_ids:
        return False
    member_role_ids = {str(r.id) for r in member.roles}
    return any(rid in member_role_ids for rid in role_ids)

async def send_teamupdate_log(guild: discord.Guild, tu_cfg: dict, cmd_cfg: dict, content: str):
    channel_id = cmd_cfg.get("channelId") or (tu_cfg.get("channelId") if tu_cfg.get("enabled") else None)
    if not channel_id:
        return
    channel = guild.get_channel(int(channel_id))
    if not channel:
        return
    try:
        await channel.send(content)
    except Exception as e:
        logger.error(f"[TEAMUPDATE] Fehler beim Senden des Logs: {e}")

async def increment_team_warn(guild_id, user_id) -> int:
    if team_warns_collection is None:
        return 1
    try:
        doc = await db_call(
            team_warns_collection.find_one_and_update,
            {"guildId": str(guild_id), "userId": str(user_id)},
            {"$inc": {"count": 1}},
            upsert=True,
            return_document=ReturnDocument.AFTER
        )
        return doc.get("count", 1) if doc else 1
    except Exception as e:
        logger.error(f"[TEAMWARN] Fehler beim Aktualisieren des Warnzählers: {e}")
        return 1

MAX_EXTRA_SIGNATURES = 5

def collect_extra_signers(*members) -> list:
    seen = set()
    result = []
    for m in members:
        if m is not None and m.id not in seen:
            seen.add(m.id)
            result.append(m)
    return result

def has_role_hierarchy(actor: discord.Member, target: discord.Member) -> bool:
    if actor.id == target.id:
        return False
    if actor.guild.owner_id == actor.id:
        return True
    if actor.guild_permissions.administrator:
        return True
    return actor.top_role > target.top_role

async def validate_and_execute_teamupdate(interaction: discord.Interaction, cmd_key: str, action_label: str,
                                           extra_signers: list, execute_fn, target_member: discord.Member = None):
    # SOFORT defer - das ist der wichtigste Fix
    await interaction.response.defer(ephemeral=True)
    
    guild = interaction.guild
    if guild is None:
        await interaction.followup.send("❌ Dieser Befehl kann nur auf einem Server benutzt werden.")
        return
    tu_cfg, cmd_cfg = await get_teamupdate_command_config(guild.id, cmd_key)
    if not is_command_enabled(cmd_cfg):
        await interaction.followup.send("❌ Dieser Befehl ist im Dashboard deaktiviert.")
        return
    if not has_command_permission(interaction.user, cmd_cfg):
        await interaction.followup.send("❌ Du bist nicht berechtigt, diesen Befehl zu benutzen.")
        return
    if target_member is not None and not has_role_hierarchy(interaction.user, target_member):
        await interaction.followup.send(
            "❌ Deine höchste Rolle muss über der von "
            f"{target_member.mention} stehen, um diesen Befehl bei dieser Person zu benutzen."
        )
        return
    valid_signers = []
    for signer in extra_signers:
        if signer.id == interaction.user.id:
            await interaction.followup.send("❌ Du kannst nicht selbst als Nebenunterschrift eingetragen werden.")
            return
        if not has_command_permission(signer, cmd_cfg):
            await interaction.followup.send(f"❌ {signer.mention} ist nicht berechtigt, diesen Befehl mit zu unterschreiben.")
            return
        valid_signers.append(signer)
    
    await execute_fn(tu_cfg, cmd_cfg, valid_signers)
    await interaction.followup.send(f"✅ **{action_label}** wurde ausgeführt.")

@bot.tree.command(name="neuer_teamler", description="Fügt ein neues Teammitglied hinzu.")
@app_commands.describe(
    wer="Das neue Teammitglied",
    zu="Die zu vergebende Rolle",
    grund="Grund / Notiz",
    nebenrolle="Zusätzliche Rolle, die ebenfalls vergeben wird (optional)",
    zusatzunterschrift_1="Nebenunterschrift 1",
    zusatzunterschrift_2="Nebenunterschrift 2",
    zusatzunterschrift_3="Nebenunterschrift 3",
    zusatzunterschrift_4="Nebenunterschrift 4",
    zusatzunterschrift_5="Nebenunterschrift 5",
)
async def neuerteamler(
    interaction: discord.Interaction,
    wer: discord.Member,
    zu: discord.Role,
    grund: str,
    nebenrolle: discord.Role = None,
    zusatzunterschrift_1: discord.Member = None,
    zusatzunterschrift_2: discord.Member = None,
    zusatzunterschrift_3: discord.Member = None,
    zusatzunterschrift_4: discord.Member = None,
    zusatzunterschrift_5: discord.Member = None,
):
    extra_signers = collect_extra_signers(
        zusatzunterschrift_1, zusatzunterschrift_2, zusatzunterschrift_3, zusatzunterschrift_4, zusatzunterschrift_5
    )
    async def execute_fn(tu_cfg, cmd_cfg, signers):
        try:
            await wer.add_roles(zu, reason=f"/neuerteamler von {interaction.user}: {grund}")
        except discord.Forbidden:
            logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Rolle {zu} an {wer} zu vergeben.")
        if nebenrolle is not None:
            try:
                await wer.add_roles(nebenrolle, reason=f"/neuerteamler von {interaction.user}: {grund}")
            except discord.Forbidden:
                logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Nebenrolle {nebenrolle} an {wer} zu vergeben.")
        auto_role_ids = cmd_cfg.get("autoRoles", [])
        if auto_role_ids:
            auto_roles = [r for r in (interaction.guild.get_role(int(rid)) for rid in auto_role_ids) if r is not None]
            if auto_roles:
                try:
                    await wer.add_roles(*auto_roles, reason=f"/neuerteamler von {interaction.user}: {grund} (automatische Rollen)")
                except discord.Forbidden:
                    logger.warning(f"[TEAMUPDATE] Keine Berechtigung, automatische Rollen an {wer} zu vergeben.")
        content = f"# 🎉 | Neuer Teamler | 🎉\n"
        content += f"**Wer: {wer.mention}**\n"
        content += f"**Zu: {zu.mention}**\n"
        content += f"**Grund:** {grund}\n"
        content += f"**Unterschrift:** {interaction.user.mention}"
        if signers:
            content += "\nNebenunterschrift: " + " ".join(s.mention for s in signers)
        await send_teamupdate_log(interaction.guild, tu_cfg, cmd_cfg, content)
    await validate_and_execute_teamupdate(
        interaction, "neuer_teamler", "Neues Teammitglied", extra_signers, execute_fn, target_member=wer
    )

@bot.tree.command(name="uprank", description="Befördert ein Teammitglied in eine höhere Rolle.")
@app_commands.describe(
    wer="Das Teammitglied",
    von="Die bisherige Rolle",
    zu="Die neue Rolle",
    grund="Grund",
    neue_nebenrolle="Zusätzliche Rolle, die vergeben wird (optional)",
    alte_nebenrolle="Zusätzliche Rolle, die entfernt wird (optional)",
    zusatzunterschrift_1="Nebenunterschrift 1",
    zusatzunterschrift_2="Nebenunterschrift 2",
    zusatzunterschrift_3="Nebenunterschrift 3",
    zusatzunterschrift_4="Nebenunterschrift 4",
    zusatzunterschrift_5="Nebenunterschrift 5",
)
async def uprank(
    interaction: discord.Interaction,
    wer: discord.Member,
    von: discord.Role,
    zu: discord.Role,
    grund: str,
    neue_nebenrolle: discord.Role = None,
    alte_nebenrolle: discord.Role = None,
    zusatzunterschrift_1: discord.Member = None,
    zusatzunterschrift_2: discord.Member = None,
    zusatzunterschrift_3: discord.Member = None,
    zusatzunterschrift_4: discord.Member = None,
    zusatzunterschrift_5: discord.Member = None,
):
    extra_signers = collect_extra_signers(
        zusatzunterschrift_1, zusatzunterschrift_2, zusatzunterschrift_3, zusatzunterschrift_4, zusatzunterschrift_5
    )
    async def execute_fn(tu_cfg, cmd_cfg, signers):
        try:
            await wer.add_roles(zu, reason=f"/uprank von {interaction.user}: {grund}")
        except discord.Forbidden:
            logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Rolle {zu} an {wer} zu vergeben.")
        if alte_nebenrolle is not None:
            try:
                await wer.remove_roles(alte_nebenrolle, reason=f"/uprank von {interaction.user}: {grund}")
            except discord.Forbidden:
                logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Nebenrolle {alte_nebenrolle} von {wer} zu entfernen.")
        if neue_nebenrolle is not None:
            try:
                await wer.add_roles(neue_nebenrolle, reason=f"/uprank von {interaction.user}: {grund}")
            except discord.Forbidden:
                logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Nebenrolle {neue_nebenrolle} an {wer} zu vergeben.")
        content = f"# ⬆️ | Uprank | ⬆️\n"
        content += f"**Wer: {wer.mention}**\n"
        content += f"**Von: {von.mention}**\n"
        content += f"**Zu: {zu.mention}**\n"
        content += f"**Grund: {grund}**\n"
        content += f"**Unterzeichnet: {interaction.user.mention}**"
        if signers:
            content += "\nNebenunterschrift: " + " ".join(s.mention for s in signers)
        await send_teamupdate_log(interaction.guild, tu_cfg, cmd_cfg, content)
    await validate_and_execute_teamupdate(
        interaction, "uprank", "Beförderung", extra_signers, execute_fn, target_member=wer
    )

@bot.tree.command(name="downrank", description="Degradiert ein Teammitglied in eine niedrigere Rolle.")
@app_commands.describe(
    wer="Das Teammitglied",
    von="Die bisherige Rolle",
    zu="Die neue Rolle",
    grund="Grund",
    neue_nebenrolle="Zusätzliche Rolle, die vergeben wird (optional)",
    alte_nebenrolle="Zusätzliche Rolle, die entfernt wird (optional)",
    zusatzunterschrift_1="Nebenunterschrift 1",
    zusatzunterschrift_2="Nebenunterschrift 2",
    zusatzunterschrift_3="Nebenunterschrift 3",
    zusatzunterschrift_4="Nebenunterschrift 4",
    zusatzunterschrift_5="Nebenunterschrift 5",
)
async def downrank(
    interaction: discord.Interaction,
    wer: discord.Member,
    von: discord.Role,
    zu: discord.Role,
    grund: str,
    neue_nebenrolle: discord.Role = None,
    alte_nebenrolle: discord.Role = None,
    zusatzunterschrift_1: discord.Member = None,
    zusatzunterschrift_2: discord.Member = None,
    zusatzunterschrift_3: discord.Member = None,
    zusatzunterschrift_4: discord.Member = None,
    zusatzunterschrift_5: discord.Member = None,
):
    extra_signers = collect_extra_signers(
        zusatzunterschrift_1, zusatzunterschrift_2, zusatzunterschrift_3, zusatzunterschrift_4, zusatzunterschrift_5
    )
    async def execute_fn(tu_cfg, cmd_cfg, signers):
        try:
            await wer.add_roles(zu, reason=f"/downrank von {interaction.user}: {grund}")
        except discord.Forbidden:
            logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Rolle {zu} an {wer} zu vergeben.")
        if alte_nebenrolle is not None:
            try:
                await wer.remove_roles(alte_nebenrolle, reason=f"/downrank von {interaction.user}: {grund}")
            except discord.Forbidden:
                logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Nebenrolle {alte_nebenrolle} von {wer} zu entfernen.")
        if neue_nebenrolle is not None:
            try:
                await wer.add_roles(neue_nebenrolle, reason=f"/downrank von {interaction.user}: {grund}")
            except discord.Forbidden:
                logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Nebenrolle {neue_nebenrolle} an {wer} zu vergeben.")
        content = f"# ⬇️ | Downrank | ⬇️\n"
        content += f"**Wer: {wer.mention}**\n"
        content += f"**Von: {von.mention}**\n"
        content += f"**Zu: {zu.mention}**\n"
        content += f"**Grund: {grund}**\n"
        content += f"**Unterzeichnet: {interaction.user.mention}**"
        if signers:
            content += "\nNebenunterschrift: " + " ".join(s.mention for s in signers)
        await send_teamupdate_log(interaction.guild, tu_cfg, cmd_cfg, content)
    await validate_and_execute_teamupdate(
        interaction, "downrank", "Degradierung", extra_signers, execute_fn, target_member=wer
    )

@bot.tree.command(name="teamkick", description="Entfernt ein Teammitglied aus dem Team.")
@app_commands.describe(
    wer="Das Teammitglied",
    von="Die Rolle, aus der entfernt wird",
    grund="Grund",
    nebenrolle="Zusätzliche Rolle, die ebenfalls entfernt wird (optional)",
    zusatzunterschrift_1="Nebenunterschrift 1",
    zusatzunterschrift_2="Nebenunterschrift 2",
    zusatzunterschrift_3="Nebenunterschrift 3",
    zusatzunterschrift_4="Nebenunterschrift 4",
    zusatzunterschrift_5="Nebenunterschrift 5",
)
async def teamkick(
    interaction: discord.Interaction,
    wer: discord.Member,
    von: discord.Role,
    grund: str,
    nebenrolle: discord.Role = None,
    zusatzunterschrift_1: discord.Member = None,
    zusatzunterschrift_2: discord.Member = None,
    zusatzunterschrift_3: discord.Member = None,
    zusatzunterschrift_4: discord.Member = None,
    zusatzunterschrift_5: discord.Member = None,
):
    extra_signers = collect_extra_signers(
        zusatzunterschrift_1, zusatzunterschrift_2, zusatzunterschrift_3, zusatzunterschrift_4, zusatzunterschrift_5
    )
    async def execute_fn(tu_cfg, cmd_cfg, signers):
        try:
            await wer.remove_roles(von, reason=f"/teamkick von {interaction.user}: {grund}")
        except discord.Forbidden:
            logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Rolle {von} von {wer} zu entfernen.")
        if nebenrolle is not None:
            try:
                await wer.remove_roles(nebenrolle, reason=f"/teamkick von {interaction.user}: {grund}")
            except discord.Forbidden:
                logger.warning(f"[TEAMUPDATE] Keine Berechtigung, Nebenrolle {nebenrolle} von {wer} zu entfernen.")
        auto_role_ids = cmd_cfg.get("autoRoles", [])
        if auto_role_ids:
            auto_roles = [r for r in (interaction.guild.get_role(int(rid)) for rid in auto_role_ids) if r is not None]
            if auto_roles:
                try:
                    await wer.remove_roles(*auto_roles, reason=f"/teamkick von {interaction.user}: {grund} (automatische Rollen)")
                except discord.Forbidden:
                    logger.warning(f"[TEAMUPDATE] Keine Berechtigung, automatische Rollen von {wer} zu entfernen.")
        content = f"# ⛔ | Teamkick | ⛔\n"
        content += f"**Wer:** {wer.mention}\n"
        content += f"**Von:** {von.mention}\n"
        content += f"**Grund:** {grund}\n"
        content += f"**Unterschrift:** {interaction.user.mention}"
        if signers:
            content += "\nNebenunterschrift: " + " ".join(s.mention for s in signers)
        await send_teamupdate_log(interaction.guild, tu_cfg, cmd_cfg, content)
    await validate_and_execute_teamupdate(
        interaction, "teamkick", "Teamentfernung", extra_signers, execute_fn, target_member=wer
    )

@bot.tree.command(name="teamwarn", description="Verwarnt ein Teammitglied.")
@app_commands.describe(
    wer="Das Teammitglied",
    grund="Grund der Verwarnung",
    dauer="Dauer der Verwarnung (z.B. 10d, 1w) – optional",
    zusatzunterschrift_1="Nebenunterschrift 1",
    zusatzunterschrift_2="Nebenunterschrift 2",
    zusatzunterschrift_3="Nebenunterschrift 3",
    zusatzunterschrift_4="Nebenunterschrift 4",
    zusatzunterschrift_5="Nebenunterschrift 5",
)
async def teamwarn(
    interaction: discord.Interaction,
    wer: discord.Member,
    grund: str,
    dauer: str = None,
    zusatzunterschrift_1: discord.Member = None,
    zusatzunterschrift_2: discord.Member = None,
    zusatzunterschrift_3: discord.Member = None,
    zusatzunterschrift_4: discord.Member = None,
    zusatzunterschrift_5: discord.Member = None,
):
    extra_signers = collect_extra_signers(
        zusatzunterschrift_1, zusatzunterschrift_2, zusatzunterschrift_3, zusatzunterschrift_4, zusatzunterschrift_5
    )
    async def execute_fn(tu_cfg, cmd_cfg, signers):
        warn_count = await increment_team_warn(interaction.guild.id, wer.id)
        stages = cmd_cfg.get("warnStages", [])
        old_stage_role_ids = {rid for rid in stages if rid}
        old_stage_roles = [r for r in wer.roles if str(r.id) in old_stage_role_ids]
        if old_stage_roles:
            try:
                await wer.remove_roles(*old_stage_roles, reason="Warnstufe wird aktualisiert")
            except discord.Forbidden:
                pass
        new_role = None
        stage_index = min(warn_count, len(stages)) - 1
        if 0 <= stage_index < len(stages) and stages[stage_index]:
            new_role = interaction.guild.get_role(int(stages[stage_index]))
            if new_role:
                try:
                    await wer.add_roles(new_role, reason=f"Warnstufe {stage_index + 1} erreicht")
                except discord.Forbidden:
                    logger.warning(f"[TEAMWARN] Keine Berechtigung, Warnstufen-Rolle an {wer} zu vergeben.")
        title = "# ⚠️ | Temp Teamwarn | ⚠️" if dauer else "# ⚠️ | Teamwarn | ⚠️"
        content = f"{title}\n"
        content += f"**Wer: {wer.mention}**\n"
        content += f"**Grund: {grund}**\n"
        if dauer:
            content += f"**Dauer: {dauer}**\n"
        content += f"**Unterschrift: {interaction.user.mention}**"
        if signers:
            content += "\nNebenunterschrift: " + " ".join(s.mention for s in signers)
        await send_teamupdate_log(interaction.guild, tu_cfg, cmd_cfg, content)
    await validate_and_execute_teamupdate(
        interaction, "teamwarn", "Verwarnung", extra_signers, execute_fn, target_member=wer
    )

@bot.tree.command(name="reload-ticket-panel", description="Sendet das Ticket-Panel neu in den konfigurierten Kanal.")
async def reload_ticket_panel(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    await send_ticket_panel(interaction.guild)
    await interaction.followup.send("✅ Ticket-Panel wurde neu geladen!")

@bot.tree.command(name="reload-config", description="Erzwingt, dass der Bot die Server-Konfiguration sofort neu aus der Datenbank lädt.")
@app_commands.checks.has_permissions(administrator=True)
async def reload_config(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    invalidate_config_cache(interaction.guild.id)
    await interaction.followup.send(
        "✅ Konfigurations-Cache wurde geleert – Änderungen im Dashboard wirken jetzt sofort statt erst nach ein paar Sekunden."
    )

@bot.tree.command(name="show-config", description="Zeigt die aktuelle Willkommens-Konfiguration für diesen Server an.")
async def show_config(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    config = await get_config(interaction.guild.id)
    join = config.get("welcome", {}).get("join", {})
    if not join:
        await interaction.followup.send("❌ Keine Konfiguration gefunden.")
        return
    embed = discord.Embed(title="📋 Willkommens-Konfiguration", color=0xffffff, timestamp=datetime.now(BERLIN_TZ))
    embed.add_field(name="Aktiviert", value="✅ Ja" if join.get("enabled") else "❌ Nein", inline=True)
    embed.add_field(name="Kanal", value=f"<#{join.get('channelId')}>" if join.get("channelId") else "❌ Nicht gesetzt", inline=True)
    embed.add_field(name="Titel", value=join.get("title") or "❌ Nicht gesetzt", inline=False)
    embed.add_field(name="Nachricht", value=join.get("text") or "❌ Nicht gesetzt", inline=False)
    embed.add_field(name="Rollen", value=", ".join([f"<@&{r}>" for r in join.get("roles", [])]) or "❌ Keine", inline=False)
    await interaction.followup.send(embed=embed)

@bot.tree.command(name="test-welcome", description="Testet die Willkommensnachricht.")
async def test_welcome(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    config = await get_config(interaction.guild.id)
    welcome_config = config.get("welcome", {}).get("join", {})
    if not welcome_config.get("enabled", False):
        await interaction.followup.send("❌ Willkommens-System ist deaktiviert!")
        return
    channel = interaction.guild.get_channel(int(welcome_config.get("channelId", 0)))
    if not channel:
        await interaction.followup.send("❌ Kanal nicht gefunden!")
        return
    text = welcome_config.get("text", "Willkommen {user}!").replace("{user}", interaction.user.mention).replace("{username}", interaction.user.name).replace("{server}", interaction.guild.name).replace("{membercount}", str(interaction.guild.member_count))
    title = welcome_config.get("title", f"Willkommen auf {interaction.guild.name}!").replace("{user}", interaction.user.mention).replace("{username}", interaction.user.name).replace("{server}", interaction.guild.name).replace("{membercount}", str(interaction.guild.member_count))
    color_hex = welcome_config.get("color", "#ffffff")
    try:
        color = int(color_hex.lstrip('#'), 16)
    except:
        color = 0xffffff
    embed = discord.Embed(title=title, description=text, color=color, timestamp=datetime.now(BERLIN_TZ))
    if welcome_config.get("useAvatarThumbnail", True):
        embed.set_thumbnail(url=interaction.user.display_avatar.url)
    image_url = welcome_config.get("image")
    attachments = []
    if image_url:
        if image_url.startswith('data:image'):
            file = base64_to_attachment(image_url, "test_welcome_image")
            if file:
                attachments.append(file)
                embed.set_image(url=f"attachment://{file.filename}")
        elif image_url.startswith('http'):
            embed.set_image(url=image_url)
    if attachments:
        await channel.send(embed=embed, files=attachments)
    else:
        await channel.send(embed=embed)
    await interaction.followup.send(f"✅ Test-Nachricht in {channel.mention} gesendet!")

@bot.tree.command(name="giveaway", description="Erstelle ein Giveaway.")
@app_commands.describe(
    preis="Was wird verlost?",
    gewinner="Anzahl der Gewinner",
    beschreibung="Beschreibung",
    dauer="Dauer: 30s, 5m, 1h, 2d, 1w",
    max_teilnehmer="Maximale Teilnehmer (0 = unbegrenzt)",
    erforderliche_rolle="Rolle, die man braucht",
    verbotene_rolle="Rolle, die nicht darf",
    gewinner_rolle="Rolle für den Gewinner"
)
@app_commands.default_permissions(administrator=True)
async def giveaway(
    interaction: discord.Interaction,
    preis: str,
    gewinner: int = 1,
    beschreibung: str = None,
    dauer: str = "1h",
    max_teilnehmer: int = 0,
    erforderliche_rolle: discord.Role = None,
    verbotene_rolle: discord.Role = None,
    gewinner_rolle: discord.Role = None
):
    await interaction.response.defer()
    
    try:
        seconds = parse_duration(dauer)
    except:
        await interaction.followup.send("❌ Ungültige Dauer!")
        return
    if seconds <= 0:
        await interaction.followup.send("❌ Dauer muss > 0 sein.")
        return
    if gewinner < 1:
        await interaction.followup.send("❌ Es muss mindestens 1 Gewinner geben.")
        return
    if max_teilnehmer > 0 and gewinner > max_teilnehmer:
        await interaction.followup.send("❌ Die Anzahl der Gewinner darf nicht größer als die maximale Teilnehmerzahl sein.")
        return
    end_time = datetime.now(BERLIN_TZ) + timedelta(seconds=seconds)
    giveaway_id = str(random.randint(100000, 999999)) + str(int(datetime.now(BERLIN_TZ).timestamp()))[-6:]
    giveaway_data = {
        "_id": giveaway_id,
        "guild_id": str(interaction.guild_id),
        "channel_id": str(interaction.channel_id),
        "prize": preis,
        "description": beschreibung,
        "winner_count": gewinner,
        "max_participants": max_teilnehmer,
        "required_role_id": str(erforderliche_rolle.id) if erforderliche_rolle else None,
        "forbidden_role_id": str(verbotene_rolle.id) if verbotene_rolle else None,
        "winner_role_id": str(gewinner_rolle.id) if gewinner_rolle else None,
        "end_time": end_time,
        "participants": [],
        "ended": False,
        "created_by": str(interaction.user.id)
    }
    await db_call(giveaways_collection.insert_one, giveaway_data)
    embed = create_giveaway_embed(giveaway_data)
    view = GiveawayView(giveaway_id, 0)
    await interaction.followup.send(embed=embed, view=view)
    message = await interaction.original_response()
    await db_call(giveaways_collection.update_one, {"_id": giveaway_id}, {"$set": {"message_id": str(message.id)}})
    asyncio.create_task(schedule_giveaway_end(giveaway_id, end_time))

@bot.tree.command(name="invite", description="Lädt den APEX Bot auf deinen Server ein!")
async def invite(interaction: discord.Interaction):
    invite_url = "https://discord.com/api/oauth2/authorize?client_id=1525613011262377994&scope=bot%20applications.commands&permissions=8"
    embed = discord.Embed(title="Lade den APEX Bot ein", description="Lade dir hier den **APEX Bot** auf deinen Server ein!", color=0xffffff, timestamp=datetime.now(BERLIN_TZ))
    embed.add_field(name="Lade den Bot ein:", value=f"[Invite Link]({invite_url})", inline=False)
    embed.add_field(name="Support Server:", value="[Support Server](https://discord.gg/3eghXPKD4K)", inline=False)
    view = discord.ui.View()
    view.add_item(discord.ui.Button(label="APEX Bot Einladen", url=invite_url, style=discord.ButtonStyle.link))
    await interaction.response.send_message(embed=embed, view=view)

@bot.tree.command(name="invite-tracker", description="Zeigt die Rangliste der Einladungen an!")
async def invite_tracker(interaction: discord.Interaction):
    await interaction.response.defer()
    guild_data = invite_counts.get(interaction.guild_id, {})
    if not guild_data:
        await interaction.followup.send("❌ Keine Einladungen getrackt.")
        return
    sorted_invites = sorted(guild_data.items(), key=lambda x: x[1], reverse=True)[:10]
    description_lines = []
    for i, (user_id, count) in enumerate(sorted_invites):
        medal = "🥇" if i == 0 else "🥈" if i == 1 else "🥉" if i == 2 else f"**#{i+1}**"
        description_lines.append(f"{medal} <@{user_id}> — **{count}** Einladung(en)")
    embed = discord.Embed(title="📦 Invite Tracker", description="\n".join(description_lines), color=0xffffff, timestamp=datetime.now(BERLIN_TZ))
    await interaction.followup.send(embed=embed)

@bot.tree.command(name="help", description="Zeigt alle Befehle an.")
async def help_command(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    embed = discord.Embed(title="🤖 APEX Bot - Befehle", description="Alle verfügbaren Slash Commands:", color=0xffffff, timestamp=datetime.now(BERLIN_TZ))
    for cmd in ["/invite", "/invite-tracker", "/support", "/dashboard", "/help", "/giveaway", "/show-config", "/test-welcome", "/teamliste", "/reload-ticket-panel", "/reload-config", "/neuerteamler", "/uprank", "/downrank", "/teamkick", "/teamwarn", "/update-stats", "/leaderboard", "/rp_start", "/rp_stop"]:
        embed.add_field(name=cmd, value=" ", inline=False)
    await interaction.followup.send(embed=embed)

@bot.tree.command(name="leaderboard", description="Zeigt die Bestenliste für ein Quiz-Spiel.")
@app_commands.describe(game="Wähle das Quiz-Spiel aus", limit="Anzahl der Einträge (max. 20)")
async def leaderboard(
    interaction: discord.Interaction,
    game: str = "flags",
    limit: int = 10
):
    await interaction.response.defer()
    guild = interaction.guild
    if game not in ["flags", "emoji"]:
        await interaction.followup.send("❌ Ungültiges Spiel. Wähle `flags` oder `emoji`.")
        return
    limit = min(max(1, limit), 20)
    lb = await get_quiz_leaderboard(guild.id, game, limit)
    if not lb:
        await interaction.followup.send(f"📊 Noch keine Punkte für **{game}**-Quiz vorhanden.")
        return
    game_name = "Flaggen-Quiz" if game == "flags" else "Emoji-Quiz"
    embed = discord.Embed(
        title=f"🏆 Leaderboard – {game_name}",
        color=0x5865f2,
        timestamp=datetime.now(timezone.utc)
    )
    description = []
    for i, entry in enumerate(lb, start=1):
        user_id = entry["userId"]
        correct = entry.get("correct", 0)
        medal = "🥇" if i == 1 else "🥈" if i == 2 else "🥉" if i == 3 else f"#{i}"
        description.append(f"{medal} <@{user_id}> – **{correct}** richtige Antworten")
    embed.description = "\n".join(description)
    await interaction.followup.send(embed=embed)

@bot.tree.command(name="ping", description="Zeigt die aktuelle Verbindungsgeschwindigkeit des Bots an.")
async def ping(interaction: discord.Interaction):
    start = time.monotonic()
    await interaction.response.defer(ephemeral=True)
    api_latency = (time.monotonic() - start) * 1000

    ws_latency = bot.latency * 1000

    db_latency = None
    if db is not None:
        db_start = time.monotonic()
        try:
            await db_call(db.command, "ping")
            db_latency = (time.monotonic() - db_start) * 1000
        except Exception as e:
            logger.error(f"[PING] Fehler beim Prüfen der DB-Latenz: {type(e).__name__}: {e}")
            traceback.print_exc()

    def rate(ms):
        if ms < 150:
            return "🟢"
        elif ms < 350:
            return "🟡"
        else:
            return "🔴"

    embed = discord.Embed(title="🏓 Pong!", color=0x5865f2)
    embed.add_field(name="Websocket", value=f"{rate(ws_latency)} {ws_latency:.0f} ms", inline=True)
    embed.add_field(name="API-Antwortzeit", value=f"{rate(api_latency)} {api_latency:.0f} ms", inline=True)
    if db_latency is not None:
        embed.add_field(name="Datenbank", value=f"{rate(db_latency)} {db_latency:.0f} ms", inline=True)
    else:
        embed.add_field(name="Datenbank", value="⚪ nicht verbunden", inline=True)
    await interaction.followup.send(embed=embed, ephemeral=True)

@bot.tree.command(name="support", description="Tritt unserem Support-Server bei.")
async def support(interaction: discord.Interaction):
    await interaction.response.send_message("🛠️ **APEX Support**\n\n👉 [Hier klicken zum Beitreten](https://discord.gg/3eghXPKD4K)")

@bot.tree.command(name="dashboard", description="Link zur APEX Website.")
async def dashboard(interaction: discord.Interaction):
    await interaction.response.send_message("🌐 [APEX DASHBOARD](https://apex-bot-website-ob3yip2pe-zainghg1-creators-projects.vercel.app/)")

@bot.tree.command(name="serverlist", description="Zeigt alle Server an (nur für Zain).")
async def serverlist(interaction: discord.Interaction):
    if interaction.user.id != 1086731728468578477:
        await interaction.response.send_message("❌ Nur Zain darf diesen Command benutzen.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)
    sorted_guilds = sorted(bot.guilds, key=lambda g: g.member_count, reverse=True)

    entries = []
    for guild in sorted_guilds:
        invite_url = "Kein Link"
        for channel in guild.text_channels:
            if channel.permissions_for(guild.me).create_instant_invite:
                try:
                    invite_url = (await channel.create_invite(max_age=3600, max_uses=1)).url
                    break
                except:
                    continue
        entries.append(f"• **{guild.name}** — `{guild.member_count}` Member\n  🔗 {invite_url}")

    MAX_DESC_LENGTH = 4000
    MAX_EMBEDS_PER_MESSAGE = 10

    chunks = []
    current_chunk = []
    current_length = 0
    for entry in entries:
        entry_length = len(entry) + 2
        if current_chunk and current_length + entry_length > MAX_DESC_LENGTH:
            chunks.append(current_chunk)
            current_chunk = []
            current_length = 0
        current_chunk.append(entry)
        current_length += entry_length
    if current_chunk:
        chunks.append(current_chunk)

    total_pages = len(chunks)
    embeds = []
    for i, chunk in enumerate(chunks, start=1):
        title = f"🌐 Serverliste ({len(bot.guilds)} Server)"
        if total_pages > 1:
            title += f" — Seite {i}/{total_pages}"
        embed = discord.Embed(
            title=title,
            description="\n\n".join(chunk),
            color=0xffffff,
            timestamp=datetime.now(BERLIN_TZ)
        )
        embeds.append(embed)

    for i in range(0, len(embeds), MAX_EMBEDS_PER_MESSAGE):
        batch = embeds[i:i + MAX_EMBEDS_PER_MESSAGE]
        await interaction.followup.send(embeds=batch)

@bot.tree.command(name="update-stats", description="Aktualisiert sofort alle Statistik-Kanäle auf diesem Server.")
async def update_stats(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    try:
        await update_stats_channels(interaction.guild)
        await interaction.followup.send("✅ Statistik-Kanäle wurden aktualisiert!")
    except Exception as e:
        await interaction.followup.send(f"❌ Fehler: {e}")
        logger.error(f"[STATS] Fehler bei update-stats: {e}")

# ============================================================
# VERIFIZIERUNG
# ============================================================
async def apply_verification_role_cleanup(member: discord.Member, guild_id):
    config = await get_config(guild_id)
    verify_cfg = config.get("verification", {})
    remove_ids = verify_cfg.get("removeRoleIds", []) or []
    if not remove_ids:
        return
    roles_to_remove = []
    for role_id in remove_ids:
        try:
            role = member.guild.get_role(int(role_id))
        except (TypeError, ValueError):
            continue
        if role and role in member.roles:
            roles_to_remove.append(role)
    if not roles_to_remove:
        return
    try:
        await member.remove_roles(*roles_to_remove, reason="[VERIFICATION] Rollen nach Verifizierung entfernt")
        logger.info(f"[VERIFICATION] Rollen {[r.name for r in roles_to_remove]} von {member} entfernt")
    except discord.Forbidden:
        logger.warning(f"[VERIFICATION] Keine Berechtigung, Rollen von {member} zu entfernen.")
    except Exception as e:
        logger.warning(f"[VERIFICATION] Fehler beim Entfernen der Rollen von {member}: {e}")

class VerifyMathModal(discord.ui.Modal, title="Mathe-Aufgabe"):
    def __init__(self, a: int, b: int, answer: int, guild_id: str, role_id: str):
        super().__init__()
        self.a = a
        self.b = b
        self.answer = answer
        self.guild_id = guild_id
        self.role_id = role_id
        self.add_item(discord.ui.TextInput(label=f"Was ist {a} + {b}?", placeholder="Gib die Zahl ein...", required=True))

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        user_input = self.children[0].value
        try:
            user_answer = int(user_input)
        except ValueError:
            await interaction.followup.send("❌ Bitte gib eine gültige Zahl ein.", ephemeral=True)
            return
        if user_answer == self.answer:
            role = interaction.guild.get_role(int(self.role_id))
            if role:
                if role in interaction.user.roles:
                    await interaction.followup.send("✅ Du bist bereits verifiziert!", ephemeral=True)
                    return
                try:
                    await interaction.user.add_roles(role)
                    await apply_verification_role_cleanup(interaction.user, self.guild_id)
                    await interaction.followup.send("✅ Richtig! Du wurdest verifiziert.", ephemeral=True)
                except discord.Forbidden:
                    await interaction.followup.send("❌ Ich habe keine Berechtigung, die Rolle zu vergeben.", ephemeral=True)
            else:
                await interaction.followup.send("❌ Rolle nicht gefunden.", ephemeral=True)
        else:
            await interaction.followup.send("❌ Falsche Antwort. Versuche es erneut.", ephemeral=True)

# ============================================================
# BUTTON-ACTION-HANDLER
# ============================================================
@bot.event
async def on_interaction(interaction: discord.Interaction):
    if interaction.type == discord.InteractionType.component:
        custom_id = interaction.data.get('custom_id', '')

        if custom_id.startswith('verify_button_'):
            parts = custom_id.split('_')
            if len(parts) >= 4:
                await interaction.response.defer(ephemeral=True)
                role_id = parts[3]
                role = interaction.guild.get_role(int(role_id))
                if not role:
                    await interaction.followup.send("❌ Rolle nicht gefunden.", ephemeral=True)
                    return
                if role in interaction.user.roles:
                    await interaction.followup.send("✅ Du bist bereits verifiziert!", ephemeral=True)
                    return
                try:
                    await interaction.user.add_roles(role)
                    await apply_verification_role_cleanup(interaction.user, interaction.guild_id)
                    await interaction.followup.send("✅ Du wurdest erfolgreich verifiziert!", ephemeral=True)
                except discord.Forbidden:
                    await interaction.followup.send("❌ Ich habe keine Berechtigung, die Rolle zu vergeben.", ephemeral=True)
            return

        if custom_id.startswith('gg_'):
            parts = custom_id.split('_')
            if len(parts) < 3 or interaction.guild is None:
                await interaction.response.send_message("❌ Ungültige Button-ID.", ephemeral=True)
                return
            action = parts[1]
            game_key = parts[2]
            guild = interaction.guild
            channel_id = interaction.channel.id
            state = await get_guessgame_state(guild.id, channel_id, game_key)
            if not state:
                await interaction.response.send_message("❌ Es läuft gerade keine Runde in diesem Kanal.", ephemeral=True)
                return
            item = get_guessgame_item(game_key, state.get("itemId"))
            if not item:
                await interaction.response.send_message("❌ Die Runde konnte nicht geladen werden.", ephemeral=True)
                return
            if action == "skip":
                await interaction.response.send_message(f"⏭️ {interaction.user.mention} hat übersprungen! Die Antwort war **{item['answers'][0]}**.")
                await clear_guessgame_state(guild.id, channel_id, game_key)
                await start_guessgame_round(guild, channel_id, game_key, exclude_id=item["id"])
            elif action == "hint":
                hint_text = item.get("hint") or "Kein Tipp verfügbar."
                await interaction.response.send_message(f"💡 Tipp: {hint_text}", ephemeral=True)
            elif action == "letter":
                first_letter = item["answers"][0][0].upper()
                await interaction.response.send_message(f"🔤 Die Antwort beginnt mit **{first_letter}**.", ephemeral=True)
            else:
                await interaction.response.send_message("❌ Unbekannte Aktion.", ephemeral=True)
            return

        elif custom_id.startswith('verify_math_'):
            parts = custom_id.split('_')
            if len(parts) >= 4:
                role_id = parts[3]
                a = random.randint(1, 10)
                b = random.randint(1, 10)
                answer = a + b
                modal = VerifyMathModal(a, b, answer, interaction.guild_id, role_id)
                await interaction.response.send_modal(modal)
            return

        if custom_id.startswith('act_'):
            action_id = custom_id[4:]
            if button_actions is None:
                await interaction.response.send_message("❌ Datenbank nicht verfügbar.", ephemeral=True)
                return
            try:
                doc = await db_call(button_actions.find_one, {"id": action_id})
                if not doc:
                    await interaction.response.send_message("❌ Diese Aktion existiert nicht mehr (abgelaufen).", ephemeral=True)
                    return
                action = doc.get("action", {})
                action_type = action.get("type")
                role_id = action.get("roleId")
                target_channel_id = action.get("channelId")
                message_text = action.get("message")
                guild = interaction.guild
                user = interaction.user
                member = guild.get_member(user.id) or user
                if action_type == "role_add":
                    if role_id:
                        role = guild.get_role(int(role_id))
                        if role:
                            if role in member.roles:
                                await interaction.response.send_message("ℹ️ Du hast diese Rolle bereits.", ephemeral=True)
                            else:
                                try:
                                    await member.add_roles(role, reason="Button-Aktion: Rolle hinzufügen")
                                    await interaction.response.send_message(f"✅ Rolle {role.name} wurde hinzugefügt.", ephemeral=True)
                                except discord.Forbidden:
                                    await interaction.response.send_message("❌ Der Bot hat keine Berechtigung, diese Rolle zu vergeben.", ephemeral=True)
                                except Exception as e:
                                    await interaction.response.send_message(f"❌ Fehler: {e}", ephemeral=True)
                        else:
                            await interaction.response.send_message("❌ Rolle nicht gefunden.", ephemeral=True)
                    else:
                        await interaction.response.send_message("❌ Keine Rolle angegeben.", ephemeral=True)
                elif action_type == "role_remove":
                    if role_id:
                        role = guild.get_role(int(role_id))
                        if role:
                            if role in member.roles:
                                try:
                                    await member.remove_roles(role, reason="Button-Aktion: Rolle entfernen")
                                    await interaction.response.send_message(f"✅ Rolle {role.name} wurde entfernt.", ephemeral=True)
                                except discord.Forbidden:
                                    await interaction.response.send_message("❌ Der Bot hat keine Berechtigung, diese Rolle zu entfernen.", ephemeral=True)
                                except Exception as e:
                                    await interaction.response.send_message(f"❌ Fehler: {e}", ephemeral=True)
                            else:
                                await interaction.response.send_message("ℹ️ Du hast diese Rolle nicht.", ephemeral=True)
                        else:
                            await interaction.response.send_message("❌ Rolle nicht gefunden.", ephemeral=True)
                    else:
                        await interaction.response.send_message("❌ Keine Rolle angegeben.", ephemeral=True)
                elif action_type == "role_toggle":
                    if role_id:
                        role = guild.get_role(int(role_id))
                        if role:
                            if role in member.roles:
                                try:
                                    await member.remove_roles(role, reason="Button-Aktion: Rolle toggeln (entfernt)")
                                    await interaction.response.send_message(f"✅ Rolle {role.name} wurde entfernt.", ephemeral=True)
                                except discord.Forbidden:
                                    await interaction.response.send_message("❌ Der Bot hat keine Berechtigung, diese Rolle zu entfernen.", ephemeral=True)
                                except Exception as e:
                                    await interaction.response.send_message(f"❌ Fehler: {e}", ephemeral=True)
                            else:
                                try:
                                    await member.add_roles(role, reason="Button-Aktion: Rolle toggeln (hinzugefügt)")
                                    await interaction.response.send_message(f"✅ Rolle {role.name} wurde hinzugefügt.", ephemeral=True)
                                except discord.Forbidden:
                                    await interaction.response.send_message("❌ Der Bot hat keine Berechtigung, diese Rolle zu vergeben.", ephemeral=True)
                                except Exception as e:
                                    await interaction.response.send_message(f"❌ Fehler: {e}", ephemeral=True)
                        else:
                            await interaction.response.send_message("❌ Rolle nicht gefunden.", ephemeral=True)
                    else:
                        await interaction.response.send_message("❌ Keine Rolle angegeben.", ephemeral=True)
                elif action_type == "message_send":
                    if target_channel_id and message_text:
                        channel = guild.get_channel(int(target_channel_id))
                        if channel:
                            try:
                                await channel.send(message_text)
                                await interaction.response.send_message("✅ Nachricht wurde gesendet.", ephemeral=True)
                            except discord.Forbidden:
                                await interaction.response.send_message("❌ Der Bot hat keine Berechtigung, in diesen Kanal zu schreiben.", ephemeral=True)
                            except Exception as e:
                                await interaction.response.send_message(f"❌ Fehler beim Senden: {e}", ephemeral=True)
                        else:
                            await interaction.response.send_message("❌ Zielkanal nicht gefunden.", ephemeral=True)
                    else:
                        await interaction.response.send_message("❌ Zielkanal oder Nachricht fehlt.", ephemeral=True)
                else:
                    await interaction.response.send_message("❌ Unbekannte Aktion.", ephemeral=True)
            except Exception as e:
                logger.error(f"Fehler bei Button-Aktion {action_id}: {e}")
                await interaction.response.send_message(f"❌ Ein Fehler ist aufgetreten: {e}", ephemeral=True)
            return

        if custom_id.startswith('app_accept_') or custom_id.startswith('app_reject_'):
            action = 'accepted' if custom_id.startswith('app_accept_') else 'rejected'
            parts = custom_id.split('_')
            app_id = '_'.join(parts[2:]) if len(parts) > 2 else ''
            if not app_id:
                await interaction.response.send_message("❌ Ungültige Button-ID.", ephemeral=True)
                return
            if applications_collection is None:
                await interaction.response.send_message("❌ Datenbank nicht verfügbar.", ephemeral=True)
                return
            try:
                doc = await db_call(applications_collection.find_one, {"_id": app_id})
                if not doc:
                    await interaction.response.send_message("❌ Diese Bewerbung existiert nicht mehr.", ephemeral=True)
                    return
                if doc.get("status") != "pending":
                    await interaction.response.send_message("❌ Diese Bewerbung wurde bereits bearbeitet.", ephemeral=True)
                    return
                member = interaction.guild.get_member(interaction.user.id)
                if not member:
                    await interaction.response.send_message("❌ Du bist nicht auf diesem Server.", ephemeral=True)
                    return
                is_admin = member.guild_permissions.administrator
                review_roles = doc.get("reviewRoles", [])
                has_role = any(r in review_roles for r in [str(role.id) for role in member.roles])
                if not is_admin and not has_role:
                    await interaction.response.send_message("❌ Du hast keine Berechtigung, über diese Bewerbung zu entscheiden.", ephemeral=True)
                    return
                await interaction.response.send_modal(ApplicationDecisionModal(app_id, action))
            except Exception as e:
                logger.error(f"[BEWERBUNG] Fehler bei der Bearbeitung der Bewerbung {app_id}: {e}")
                await interaction.response.send_message(f"❌ Fehler: {e}", ephemeral=True)
            return

# ============================================================
# STATISTIK-KANÄLE
# ============================================================
async def update_stats_channel_id(guild_id, entry_id, channel_id):
    if guild_configs is None:
        return
    try:
        doc = await db_call(guild_configs.find_one, {"guildId": str(guild_id)})
        if not doc:
            return
        data = doc.get("data", {})
        stats = data.get("stats", {})
        channels = stats.get("channels", [])
        for ch in channels:
            if ch.get("id") == entry_id:
                ch["channelId"] = str(channel_id)
                break
        stats["channels"] = channels
        data["stats"] = stats
        await db_call(
            guild_configs.update_one,
            {"guildId": str(guild_id)},
            {"$set": {"data": data}}
        )
        invalidate_config_cache(guild_id)
        logger.info(f"[STATS] Kanal-ID {channel_id} für Eintrag {entry_id} gespeichert")
    except Exception as e:
        logger.error(f"[STATS] Fehler beim Aktualisieren der Kanal-ID: {e}")

async def update_stats_channels(guild):
    config = await get_config(guild.id)
    stats_cfg = config.get("stats", {})
    if not stats_cfg.get("enabled", False):
        return
    for entry in stats_cfg.get("channels", []):
        category_id = entry.get("categoryId")
        name_template = entry.get("channelName")
        stat_type = entry.get("statType")
        role_id = entry.get("roleId")
        channel_id = entry.get("channelId")
        entry_id = entry.get("id")
        if not category_id or not name_template or not stat_type:
            continue
        category = guild.get_channel(int(category_id))
        if not category:
            continue
        if stat_type == "members":
            count = len([m for m in guild.members if not m.bot])
        elif stat_type == "bots":
            count = len([m for m in guild.members if m.bot])
        elif stat_type == "roles":
            count = len(guild.roles) - 1
        elif stat_type == "boosts":
            count = guild.premium_subscription_count or 0
        elif stat_type == "role_count":
            if role_id:
                role = guild.get_role(int(role_id))
                count = len(role.members) if role else 0
            else:
                count = 0
        else:
            continue
        channel_name = name_template.replace("{stat}", str(count))[:100]
        if channel_id:
            channel = guild.get_channel(int(channel_id))
            if channel is None:
                try:
                    channel = await guild.create_voice_channel(
                        name=channel_name,
                        category=category,
                        reason="Statistik-Kanal (wiederhergestellt)"
                    )
                    await update_stats_channel_id(guild.id, entry_id, channel.id)
                except discord.Forbidden:
                    logger.warning(f"[STATS] Keine Berechtigung, Kanal in {guild.name} zu erstellen.")
                    continue
            else:
                if channel.name != channel_name:
                    try:
                        await channel.edit(name=channel_name, reason="Statistik aktualisiert")
                    except discord.Forbidden:
                        logger.warning(f"[STATS] Keine Berechtigung, Kanalnamen in {guild.name} zu ändern.")
                    except discord.HTTPException as e:
                        logger.warning(f"[STATS] Fehler beim Aktualisieren des Kanalnamens: {e}")
        else:
            try:
                channel = await guild.create_voice_channel(
                    name=channel_name,
                    category=category,
                    reason="Statistik-Kanal erstellt"
                )
                await update_stats_channel_id(guild.id, entry_id, channel.id)
            except discord.Forbidden:
                logger.warning(f"[STATS] Keine Berechtigung, Kanal in {guild.name} zu erstellen.")
                continue
        try:
            await channel.set_permissions(guild.default_role, connect=False)
            await channel.set_permissions(guild.me, connect=True)
        except discord.Forbidden:
            logger.warning(f"[STATS] Keine Berechtigung, Berechtigungen für {channel.name} zu setzen.")
        except discord.HTTPException as e:
            logger.warning(f"[STATS] Fehler beim Setzen der Berechtigungen: {e}")

async def stats_update_loop():
    await bot.wait_until_ready()
    while not bot.is_closed():
        for guild in bot.guilds:
            try:
                await update_stats_channels(guild)
            except Exception as e:
                logger.error(f"[STATS] Fehler bei {guild.name}: {e}")
        await asyncio.sleep(30)

@bot.event
async def on_guild_join(guild):
    await update_stats_channels(guild)

# ============================================================
# SHIFT-SYSTEM (mit konfigurierbarem Log-Titel)
# ============================================================
async def get_shift_config(guild_id):
    config = await get_config(guild_id)
    return config.get("shiftsystem", {})

_active_shift_cache = TTLCache(ttl=15, name="active_shift")
_shift_stats_cache = TTLCache(ttl=30, name="shift_stats")
_shift_leaderboard_cache = TTLCache(ttl=30, name="shift_leaderboard")

def _invalidate_shift_caches(guild_id, user_id=None):
    guild_id = str(guild_id)
    if user_id is not None:
        _active_shift_cache.invalidate(f"{guild_id}:{user_id}")
        _shift_stats_cache.invalidate(f"{guild_id}:{user_id}")
    _shift_leaderboard_cache.invalidate(guild_id)

async def get_active_shift(guild_id, user_id):
    cache_key = f"{guild_id}:{user_id}"
    cached = _active_shift_cache.get(cache_key, "__miss__")
    if cached != "__miss__":
        return cached
    if shifts_collection is None:
        return None
    try:
        doc = await db_call(
            shifts_collection.find_one,
            {
                "guildId": str(guild_id),
                "userId": str(user_id),
                "status": {"$in": ["active", "paused"]}
            }
        )
        _active_shift_cache.set(cache_key, doc)
        return doc
    except Exception as e:
        logger.error(f"[SHIFT] Fehler beim Laden der aktiven Schicht: {e}")
        return None

async def create_shift(guild_id, user_id, start_time, shift_type=None):
    if shifts_collection is None:
        return None
    try:
        start = ensure_aware(start_time)
        doc = {
            "guildId": str(guild_id),
            "userId": str(user_id),
            "startTime": start,
            "pausedAt": None,
            "isPaused": False,
            "totalPausedDuration": 0,
            "endTime": None,
            "totalSeconds": 0,
            "status": "active",
            # shift_type: {"id": ..., "name": ...} oder None (= allgemeine/klassische Schicht)
            "shiftType": shift_type
        }
        await db_call(shifts_collection.insert_one, doc)
        _invalidate_shift_caches(guild_id, user_id)
        return doc
    except Exception as e:
        logger.error(f"[SHIFT] Fehler beim Erstellen der Schicht: {e}")
        return None

async def pause_shift(shift_doc, pause_time):
    if shifts_collection is None:
        return None
    try:
        pause = ensure_aware(pause_time)
        shift_doc["isPaused"] = True
        shift_doc["pausedAt"] = pause
        await db_call(
            shifts_collection.update_one,
            {"_id": shift_doc["_id"]},
            {"$set": {"isPaused": True, "pausedAt": pause}}
        )
        _invalidate_shift_caches(shift_doc["guildId"], shift_doc["userId"])
        return shift_doc
    except Exception as e:
        logger.error(f"[SHIFT] Fehler beim Pausieren der Schicht: {e}")
        return None

async def stop_shift(shift_doc, end_time):
    if shifts_collection is None:
        return None
    try:
        start = ensure_aware(shift_doc["startTime"])
        end = ensure_aware(end_time)
        total_paused = shift_doc.get("totalPausedDuration", 0)
        if shift_doc.get("isPaused", False):
            paused_at = shift_doc.get("pausedAt")
            if paused_at:
                paused_at_aware = ensure_aware(paused_at)
                total_paused += (end - paused_at_aware).total_seconds()
        total_seconds = max(0, (end - start).total_seconds() - total_paused)
        shift_doc["endTime"] = end
        shift_doc["totalSeconds"] = total_seconds
        shift_doc["status"] = "ended"
        await db_call(
            shifts_collection.update_one,
            {"_id": shift_doc["_id"]},
            {"$set": {
                "endTime": end,
                "totalSeconds": total_seconds,
                "status": "ended",
                "totalPausedDuration": total_paused,
                "isPaused": False,
                "pausedAt": None
            }}
        )
        _invalidate_shift_caches(shift_doc["guildId"], shift_doc["userId"])
        await update_shift_stats(shift_doc["guildId"], shift_doc["userId"], total_seconds)
        return shift_doc
    except Exception as e:
        logger.error(f"[SHIFT] Fehler beim Beenden der Schicht: {e}")
        return None

async def update_shift_stats(guild_id, user_id, seconds):
    if shift_stats_collection is None:
        return
    try:
        await db_call(
            shift_stats_collection.update_one,
            {"guildId": str(guild_id), "userId": str(user_id)},
            {"$inc": {"totalSeconds": seconds}, "$set": {"lastUpdated": datetime.now(timezone.utc)}},
            upsert=True
        )
        _invalidate_shift_caches(guild_id, user_id)
    except Exception as e:
        logger.error(f"[SHIFT] Fehler beim Aktualisieren der Statistiken: {e}")

async def get_user_shift_stats(guild_id, user_id):
    cache_key = f"{guild_id}:{user_id}"
    cached = _shift_stats_cache.get(cache_key, "__miss__")
    if cached != "__miss__":
        return cached
    if shift_stats_collection is None:
        return None
    try:
        doc = await db_call(shift_stats_collection.find_one, {"guildId": str(guild_id), "userId": str(user_id)})
        _shift_stats_cache.set(cache_key, doc)
        return doc
    except Exception as e:
        logger.error(f"[SHIFT] Fehler beim Laden der Statistiken: {e}")
        return None

async def get_leaderboard_shifts(guild_id, limit=10):
    cache_key = f"{guild_id}:{limit}"
    cached = _shift_leaderboard_cache.get(cache_key, "__miss__")
    if cached != "__miss__":
        return cached
    if shift_stats_collection is None:
        return []
    try:
        cursor = shift_stats_collection.find({"guildId": str(guild_id)}).sort("totalSeconds", -1).limit(limit)
        docs = await db_call(cursor.to_list, length=limit)
        _shift_leaderboard_cache.set(cache_key, docs)
        return docs
    except Exception as e:
        logger.error(f"[SHIFT] Fehler beim Laden der Bestenliste: {e}")
        return []

def find_shift_type(config: dict, shift_type_id: str):
    """Sucht eine konfigurierte Schichtart anhand ihrer ID (oder ihres Namens als Fallback)."""
    if not shift_type_id:
        return None
    for t in config.get("shiftTypes", []) or []:
        if t.get("id") == shift_type_id or t.get("name") == shift_type_id:
            return t
    return None

async def has_shift_permission(interaction: discord.Interaction, target_user: discord.Member = None, shift_type_id: str = None):
    guild = interaction.guild
    user = interaction.user
    config = await get_shift_config(guild.id)
    if not config.get("enabled", False):
        return False, False, "Das Shift-System ist deaktiviert."
    if user.guild_permissions.administrator:
        return True, True, "Admin"
    manager_role_ids = config.get("managerRoleIds", [])
    self_role_ids = config.get("selfRoleIds", [])
    user_role_ids = {str(r.id) for r in user.roles}
    is_manager = bool(user_role_ids.intersection(set(manager_role_ids)))
    if target_user is not None and target_user.id != user.id:
        if not is_manager:
            return False, False, "Du darfst nur deine eigene Schicht verwalten."
        return True, True, "Manager"
    if is_manager:
        return True, True, "Manager"
    if not self_role_ids or user_role_ids.intersection(set(self_role_ids)):
        # Grundsätzliche Shift-Berechtigung vorhanden – jetzt ggf. noch die Schichtart selbst prüfen
        shift_type = find_shift_type(config, shift_type_id)
        if shift_type:
            type_role_ids = shift_type.get("roleIds", [])
            if type_role_ids and not user_role_ids.intersection(set(type_role_ids)):
                return False, False, f"Du hast keine Berechtigung, die Schichtart „{shift_type.get('name')}“ zu starten."
        return True, False, "Self"
    return False, False, "Du hast keine Berechtigung, Schichten zu verwalten."

# ============================================================
# NEU: log_shift_event mit konfigurierbarem Titel
# ============================================================
async def log_shift_event(guild: discord.Guild, title: str, description: str):
    config = await get_shift_config(guild.id)
    log_title = config.get("title") or "🕒 Schicht"
    embed = discord.Embed(title=log_title, description=description, color=0x5865f2, timestamp=datetime.now(timezone.utc))
    log_channel_id = config.get("logChannelId")
    if not log_channel_id:
        return
    channel = guild.get_channel(int(log_channel_id))
    if not channel:
        return
    try:
        await channel.send(embed=embed)
    except Exception as e:
        logger.error(f"[SHIFT] Fehler beim Logging: {e}")

# ============================================================
# SHIFT COMMANDS - OPTIMIERT
# ============================================================

async def shift_type_autocomplete(interaction: discord.Interaction, current: str):
    """Schlägt die im Dashboard konfigurierten Schichtarten vor, gefiltert nach Eingabe und Berechtigung."""
    config = await get_shift_config(interaction.guild_id)
    shift_types = config.get("shiftTypes", []) or []
    user_role_ids = {str(r.id) for r in interaction.user.roles} if isinstance(interaction.user, discord.Member) else set()
    is_privileged = (
        interaction.user.guild_permissions.administrator
        or user_role_ids.intersection(set(config.get("managerRoleIds", [])))
    )
    choices = []
    for t in shift_types:
        name = t.get("name", "")
        if not name:
            continue
        if current and current.lower() not in name.lower():
            continue
        type_role_ids = t.get("roleIds", [])
        if type_role_ids and not is_privileged and not user_role_ids.intersection(set(type_role_ids)):
            continue
        choices.append(app_commands.Choice(name=name, value=t.get("id", name)))
    return choices[:25]

@bot.tree.command(name="shift_start", description="Starte eine neue Schicht.")
@app_commands.describe(user="Für wen die Schicht gestartet werden soll (nur Manager)", schichtart="Welche Schichtart (falls konfiguriert)")
@app_commands.autocomplete(schichtart=shift_type_autocomplete)
async def shift_start(interaction: discord.Interaction, user: discord.Member = None, schichtart: str = None):
    await interaction.response.defer()
    guild = interaction.guild
    target = user or interaction.user
    if target.bot:
        await interaction.followup.send("❌ Bots haben keine Schichten.")
        return
    config = await get_shift_config(guild.id)
    shift_type = find_shift_type(config, schichtart)
    if schichtart and not shift_type:
        await interaction.followup.send("❌ Unbekannte Schichtart. Bitte über die Vorschläge auswählen.")
        return
    darf, is_manager, grund = await has_shift_permission(interaction, target, shift_type_id=schichtart)
    if not darf:
        await interaction.followup.send(f"❌ {grund}")
        return
    active = await get_active_shift(guild.id, target.id)
    if active:
        status_text = "aktiv" if active.get("status") == "active" else "pausiert"
        await interaction.followup.send(
            f"❌ {target.mention} hat bereits eine {status_text} Schicht (gestartet <t:{int(active['startTime'].timestamp())}:R>)."
        )
        return
    now = datetime.now(timezone.utc)
    shift_type_data = {"id": shift_type.get("id"), "name": shift_type.get("name")} if shift_type else None
    shift = await create_shift(guild.id, target.id, now, shift_type=shift_type_data)
    if not shift:
        await interaction.followup.send("❌ Fehler beim Erstellen der Schicht.")
        return
    type_suffix = f" ({shift_type_data['name']})" if shift_type_data else ""
    msg = f"✅ Schicht{type_suffix} für {target.mention} gestartet um <t:{int(now.timestamp())}:T>."
    if is_manager and target.id != interaction.user.id:
        msg += f"\n(ausgeführt von {interaction.user.mention})"
    await interaction.followup.send(msg)
    await log_shift_event(guild, f"Schicht{type_suffix} gestartet von {target.display_name}", msg)

@bot.tree.command(name="shift_pause", description="Pausiere deine aktive Schicht.")
@app_commands.describe(user="Für wen die Schicht pausiert werden soll (nur Manager)")
async def shift_pause(interaction: discord.Interaction, user: discord.Member = None):
    await interaction.response.defer()
    guild = interaction.guild
    target = user or interaction.user
    if target.bot:
        await interaction.followup.send("❌ Bots haben keine Schichten.")
        return
    darf, is_manager, grund = await has_shift_permission(interaction, target)
    if not darf:
        await interaction.followup.send(f"❌ {grund}")
        return
    active = await get_active_shift(guild.id, target.id)
    if not active:
        await interaction.followup.send(f"❌ {target.mention} hat keine aktive Schicht.")
        return
    if active.get("isPaused", False):
        await interaction.followup.send(f"❌ Die Schicht von {target.mention} ist bereits pausiert.")
        return
    now = datetime.now(timezone.utc)
    updated = await pause_shift(active, now)
    if not updated:
        await interaction.followup.send("❌ Fehler beim Pausieren der Schicht.")
        return
    msg = f"⏸️ Schicht für {target.mention} pausiert um <t:{int(now.timestamp())}:T>."
    if is_manager and target.id != interaction.user.id:
        msg += f"\n(ausgeführt von {interaction.user.mention})"
    await interaction.followup.send(msg)
    await log_shift_event(guild, f"Schicht pausiert von {target.display_name}", msg)

@bot.tree.command(name="shift_stop", description="Beende deine aktive Schicht.")
@app_commands.describe(user="Für wen die Schicht beendet werden soll (nur Manager)")
async def shift_stop(interaction: discord.Interaction, user: discord.Member = None):
    await interaction.response.defer()
    guild = interaction.guild
    target = user or interaction.user
    if target.bot:
        await interaction.followup.send("❌ Bots haben keine Schichten.")
        return
    darf, is_manager, grund = await has_shift_permission(interaction, target)
    if not darf:
        await interaction.followup.send(f"❌ {grund}")
        return
    active = await get_active_shift(guild.id, target.id)
    if not active:
        await interaction.followup.send(f"❌ {target.mention} hat keine aktive Schicht.")
        return
    now = datetime.now(timezone.utc)
    stopped = await stop_shift(active, now)
    if not stopped:
        await interaction.followup.send("❌ Fehler beim Beenden der Schicht.")
        return
    total_seconds = stopped.get("totalSeconds", 0)
    hours = int(total_seconds // 3600)
    minutes = int((total_seconds % 3600) // 60)
    seconds = int(total_seconds % 60)
    duration_str = f"{hours}h {minutes}m {seconds}s" if hours else f"{minutes}m {seconds}s"
    msg = f"✅ Schicht für {target.mention} beendet.\n**Dauer (aktiv):** {duration_str}"
    if is_manager and target.id != interaction.user.id:
        msg += f"\n(ausgeführt von {interaction.user.mention})"
    await interaction.followup.send(msg)
    await log_shift_event(guild, f"Schicht beendet von {target.display_name}", msg)

@bot.tree.command(name="shift_status", description="Zeige den aktuellen Schichtstatus.")
@app_commands.describe(user="Nutzer, dessen Status angezeigt werden soll (optional)")
async def shift_status(interaction: discord.Interaction, user: discord.Member = None):
    await interaction.response.defer(ephemeral=True)
    guild = interaction.guild
    target = user or interaction.user
    config = await get_shift_config(guild.id)
    if not config.get("enabled", False):
        await interaction.followup.send("❌ Das Shift-System ist deaktiviert.")
        return
    if target.id != interaction.user.id:
        manager_role_ids = config.get("managerRoleIds", [])
        user_role_ids = {str(r.id) for r in interaction.user.roles}
        if not (interaction.user.guild_permissions.administrator or user_role_ids.intersection(set(manager_role_ids))):
            await interaction.followup.send("❌ Du darfst nur deinen eigenen Status einsehen.")
            return
    active = await get_active_shift(guild.id, target.id)
    stats = await get_user_shift_stats(guild.id, target.id)
    total_seconds = stats.get("totalSeconds", 0) if stats else 0
    hours = int(total_seconds // 3600)
    minutes = int((total_seconds % 3600) // 60)
    seconds = int(total_seconds % 60)
    total_str = f"{hours}h {minutes}m {seconds}s" if hours else f"{minutes}m {seconds}s"

    embed = discord.Embed(title=f"🕒 Schichtstatus – {target.display_name}", color=0x5865f2)
    if active:
        start = active["startTime"]
        status_text = "⏸️ Pausiert" if active.get("isPaused") else "🟢 Aktiv"
        shift_type = active.get("shiftType")
        if shift_type:
            embed.add_field(name="Schichtart", value=shift_type.get("name", "-"), inline=True)
        embed.add_field(name="Status", value=status_text, inline=True)
        embed.add_field(name="Beginn", value=f"<t:{int(start.timestamp())}:R>", inline=True)
        if active.get("isPaused") and active.get("pausedAt"):
            embed.add_field(name="Pause seit", value=f"<t:{int(active['pausedAt'].timestamp())}:R>", inline=True)
        embed.add_field(name="Bisherige Gesamtzeit (aktiv)", value=total_str, inline=False)
    else:
        embed.add_field(name="Status", value="❌ Keine aktive Schicht", inline=False)
        embed.add_field(name="Bisherige Gesamtzeit (alle Schichten)", value=total_str, inline=False)
    await interaction.followup.send(embed=embed)

@bot.tree.command(name="shift_leaderboard", description="Zeige die Bestenliste der Schichtzeiten.")
async def shift_leaderboard(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    guild = interaction.guild
    config = await get_shift_config(guild.id)
    if not config.get("enabled", False):
        await interaction.followup.send("❌ Das Shift-System ist deaktiviert.")
        return
    manager_role_ids = config.get("managerRoleIds", [])
    user_role_ids = {str(r.id) for r in interaction.user.roles}
    if not (interaction.user.guild_permissions.administrator or user_role_ids.intersection(set(manager_role_ids))):
        await interaction.followup.send("❌ Du hast keine Berechtigung, die Bestenliste einzusehen.")
        return
    lb = await get_leaderboard_shifts(guild.id, limit=10)
    if not lb:
        await interaction.followup.send("📊 Noch keine Schichtdaten vorhanden.")
        return
    embed = discord.Embed(title="🏆 Schicht-Bestenliste", color=0x5865f2, timestamp=datetime.now(timezone.utc))
    description = []
    for i, entry in enumerate(lb, start=1):
        user_id = entry["userId"]
        total_seconds = entry.get("totalSeconds", 0)
        hours = int(total_seconds // 3600)
        minutes = int((total_seconds % 3600) // 60)
        seconds = int(total_seconds % 60)
        time_str = f"{hours}h {minutes}m {seconds}s" if hours else f"{minutes}m {seconds}s"
        medal = "🥇" if i == 1 else "🥈" if i == 2 else "🥉" if i == 3 else f"#{i}"
        description.append(f"{medal} <@{user_id}> – **{time_str}**")
    embed.description = "\n".join(description)
    await interaction.followup.send(embed=embed)

# ============================================================
# ABMELDE-SYSTEM (Team & Support) – mit konfigurierbarem Log-Titel
# ============================================================
async def get_abmeldesystem_config(guild_id):
    config = await get_config(guild_id)
    return config.get("abmeldesystem", {})

class AbmeldeView(discord.ui.View):
    """Persistente View mit den 2 Buttons 'Abmeldung erstellen' und 'Anmelden'."""
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="Abmeldung erstellen", style=discord.ButtonStyle.primary, custom_id="abm_create")
    async def abm_create(self, interaction: discord.Interaction, button: discord.ui.Button):
        cfg = await get_abmeldesystem_config(interaction.guild_id)
        if not cfg.get("enabled", False):
            await interaction.response.send_message("❌ Das Abmelde-System ist nicht aktiviert.", ephemeral=True)
            return
        if not cfg.get("abgemeldeteRoleId"):
            await interaction.response.send_message("❌ Es ist keine 'Abgemeldet'-Rolle konfiguriert. Bitte im Dashboard einrichten.", ephemeral=True)
            return
        await interaction.response.send_modal(AbmeldeModal())

    @discord.ui.button(label="Anmelden", style=discord.ButtonStyle.success, custom_id="abm_return")
    async def abm_return(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)
        guild = interaction.guild
        cfg = await get_abmeldesystem_config(guild.id)
        if not cfg.get("enabled", False):
            await interaction.followup.send("❌ Das Abmelde-System ist nicht aktiviert.", ephemeral=True)
            return
        member = guild.get_member(interaction.user.id) or interaction.user
        role_id = cfg.get("abgemeldeteRoleId")
        role = guild.get_role(int(role_id)) if role_id else None
        had_role = bool(role and role in getattr(member, "roles", []))
        if role and had_role:
            try:
                await member.remove_roles(role, reason="Anmeldung über Abmelde-System")
            except discord.Forbidden:
                await interaction.followup.send("⚠️ Rolle konnte nicht entfernt werden (fehlende Berechtigung), du wurdest dennoch angemeldet.", ephemeral=True)

        active_doc = None
        if logouts_collection is not None:
            try:
                active_doc = await db_call(
                    logouts_collection.find_one_and_update,
                    {"guildId": str(guild.id), "userId": str(interaction.user.id), "active": True},
                    {"$set": {"active": False, "returnedAt": datetime.now(timezone.utc)}},
                    return_document=ReturnDocument.AFTER
                )
            except Exception as e:
                logger.error(f"[ABMELDESYSTEM] Fehler beim Beenden der Abmeldung: {e}")

        if not had_role and not active_doc:
            await interaction.followup.send("ℹ️ Du warst nicht als abgemeldet eingetragen.", ephemeral=True)
            return

        await interaction.followup.send("✅ Du bist jetzt wieder angemeldet.", ephemeral=True)
        await send_abmeldesystem_log(guild, cfg, interaction.user, active_doc, event="return")

class AbmeldeModal(discord.ui.Modal, title="Abmeldung erstellen"):
    von = discord.ui.TextInput(label="Von", placeholder="z.B. 30.07.2026", required=True, max_length=100)
    bis = discord.ui.TextInput(label="Bis", placeholder="z.B. 15.08.2026", required=True, max_length=100)
    grund = discord.ui.TextInput(label="Grund", style=discord.TextStyle.paragraph, placeholder="Warum meldest du dich ab?", required=True, max_length=500)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        guild = interaction.guild
        cfg = await get_abmeldesystem_config(guild.id)
        if not cfg.get("enabled", False):
            await interaction.followup.send("❌ Das Abmelde-System ist nicht aktiviert.", ephemeral=True)
            return
        role_id = cfg.get("abgemeldeteRoleId")
        role = guild.get_role(int(role_id)) if role_id else None
        member = guild.get_member(interaction.user.id) or interaction.user

        if role:
            try:
                await member.add_roles(role, reason="Abmeldung erstellt")
            except discord.Forbidden:
                await interaction.followup.send("⚠️ Die 'Abgemeldet'-Rolle konnte nicht vergeben werden (fehlende Berechtigung). Die Abmeldung wurde trotzdem gespeichert.", ephemeral=True)

        doc = {
            "_id": f"abm_{guild.id}_{interaction.user.id}_{int(datetime.now(timezone.utc).timestamp())}",
            "guildId": str(guild.id),
            "userId": str(interaction.user.id),
            "von": str(self.von.value).strip(),
            "bis": str(self.bis.value).strip(),
            "grund": str(self.grund.value).strip(),
            "createdAt": datetime.now(timezone.utc),
            "active": True
        }
        if logouts_collection is not None:
            try:
                await db_call(logouts_collection.insert_one, doc)
            except Exception as e:
                logger.error(f"[ABMELDESYSTEM] Fehler beim Speichern der Abmeldung: {e}")

        await interaction.followup.send("✅ Deine Abmeldung wurde erstellt.", ephemeral=True)
        await send_abmeldesystem_log(guild, cfg, interaction.user, doc, event="create")

# ============================================================
# NEU: send_abmeldesystem_log mit konfigurierbarem Titel
# ============================================================
async def send_abmeldesystem_log(guild: discord.Guild, cfg: dict, user: discord.abc.User, doc: dict, event: str):
    log_channel_id = cfg.get("logChannelId")
    if not log_channel_id:
        return
    channel = guild.get_channel(int(log_channel_id))
    if not channel:
        return
    log_title = cfg.get("title") or "📋 Abmeldung"
    try:
        if event == "create":
            embed = discord.Embed(title=log_title, color=0xE67E22, timestamp=datetime.now(timezone.utc))
            embed.add_field(name="User", value=user.mention, inline=False)
            embed.add_field(name="Von", value=doc.get("von", "-"), inline=True)
            embed.add_field(name="Bis", value=doc.get("bis", "-"), inline=True)
            embed.add_field(name="Grund", value=doc.get("grund", "-"), inline=False)
            embed.set_footer(text="Status: 🔴 Abgemeldet")
        else:
            embed = discord.Embed(title="📋 Anmeldung", color=0x2ECC71, timestamp=datetime.now(timezone.utc))
            embed.add_field(name="User", value=user.mention, inline=False)
            if doc:
                embed.add_field(name="War abgemeldet", value=f"{doc.get('von', '-')} – {doc.get('bis', '-')}", inline=False)
                embed.add_field(name="Grund war", value=doc.get("grund", "-"), inline=False)
            embed.set_footer(text="Status: 🟢 Wieder angemeldet")
        await channel.send(embed=embed)
    except discord.Forbidden:
        logger.warning(f"[ABMELDESYSTEM] Keine Berechtigung, im Log-Kanal von {guild.name} zu schreiben.")
    except Exception as e:
        logger.error(f"[ABMELDESYSTEM] Fehler beim Senden des Log-Embeds: {e}")

# ============================================================
# GLOBALER FEHLER-HANDLER
# ============================================================
@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    if isinstance(error, app_commands.MissingPermissions):
        message = "❌ Dir fehlen die nötigen Berechtigungen für diesen Befehl."
    elif isinstance(error, app_commands.CommandOnCooldown):
        message = f"⏳ Bitte warte noch {error.retry_after:.1f} Sekunden, bevor du das nochmal versuchst."
    elif isinstance(error, discord.InteractionResponded):
        return
    elif isinstance(error, discord.NotFound):
        message = "❌ Die Interaktion ist abgelaufen. Bitte versuche es erneut."
    elif isinstance(error, asyncio.TimeoutError):
        message = "❌ Die Anfrage hat zu lange gedauert. Bitte versuche es später erneut."
    else:
        logger.error(f"[SLASH-COMMAND] Unerwarteter Fehler bei /{interaction.command.name if interaction.command else '?'}: {error}")
        traceback.print_exc()
        message = "❌ Es ist ein unerwarteter Fehler aufgetreten. Das Team wurde informiert."
    try:
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)
    except Exception:
        pass

# ============================================================
# BOT STARTEN
# ============================================================
BOT_TOKEN = os.getenv("BOT_TOKEN")
if not BOT_TOKEN:
    logger.error("❌ Kein BOT_TOKEN in .env gefunden!")
    exit(1)

logger.info("🚀 Starte Bot...")
try:
    bot.run(BOT_TOKEN)
except Exception as e:
    logger.error(f"❌ Bot konnte nicht starten: {e}")
    traceback.print_exc()
    exit(1)
