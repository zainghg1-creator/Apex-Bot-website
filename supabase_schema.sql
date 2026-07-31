-- ==========================================
-- Apex Bot: MongoDB -> Supabase Schema (v2)
-- ==========================================
-- Jede ehemalige MongoDB-Collection wird 1:1 als Tabelle mit
-- (id, guild_id, document jsonb) abgebildet. Das komplette Mongo-Dokument
-- landet unverändert in "document" - dadurch braucht main.py nur einen
-- neuen DB-Adapter (supabase_compat.py) statt 50+ Stellen umzuschreiben.
--
-- guild_id ist NICHT für Filter-Queries nötig (die laufen über document->>...),
-- sondern nur als Index/Debugging-Hilfe vorhanden.
--
-- Falls du das Schema neu ausführst: vorher alte Tabellen droppen, z.B.
--   drop table if exists shifts, shift_stats, minigame_rounds, quiz_stats,
--     giveaways, teamwarns, transcripts, counting, levels, applications,
--     tickets, button_actions, logouts, guild_configs cascade;

create table if not exists guild_configs (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists giveaways (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists teamwarns (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists counting (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists levels (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

-- button_actions hatte in MongoDB einen TTL-Index (Auto-Löschung nach 1h).
-- Postgres kennt das nicht nativ, daher: created_at-Spalte + pg_cron-Job unten.
create table if not exists button_actions (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists applications (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists minigame_rounds (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists transcripts (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists shifts (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists shift_stats (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists quiz_stats (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists logouts (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

create table if not exists tickets (
  id text primary key,
  guild_id text,
  document jsonb not null default '{}'::jsonb
);

-- ==========================================
-- Indizes: guild_id (Debug/Reporting) + GIN auf document
-- für performante Abfragen über document->>feld
-- ==========================================
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'guild_configs','giveaways','teamwarns','counting','levels',
    'button_actions','applications','minigame_rounds','transcripts',
    'shifts','shift_stats','quiz_stats','logouts','tickets'
  ])
  loop
    execute format('create index if not exists idx_%s_guild_id on %I (guild_id);', t, t);
    execute format('create index if not exists idx_%s_document_gin on %I using gin (document);', t, t);
  end loop;
end $$;

-- ==========================================
-- Ersatz für den MongoDB TTL-Index auf button_actions
-- (löscht automatisch alles, was älter als 1h ist)
-- ==========================================
create extension if not exists pg_cron;

select cron.schedule(
  'apex_cleanup_button_actions',
  '0 * * * *',  -- stündlich
  $$ delete from button_actions where created_at < now() - interval '1 hour'; $$
);
-- Falls das Scheduling fehlschlägt (pg_cron ist je nach Supabase-Plan evtl.
-- nicht aktivierbar): einfach diesen Block weglassen und stattdessen
-- gelegentlich manuell "delete from button_actions where created_at < now() - interval '1 hour';"
-- ausführen, oder das Aufräumen im Bot selbst per Zeitschleife ergänzen.
