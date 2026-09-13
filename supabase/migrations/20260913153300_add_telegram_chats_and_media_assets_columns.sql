-- Applied directly against the remote project earlier and only backfilled
-- into this repo afterward — see docs/db-schema.md's telegram_chats section.
-- Kept IF NOT EXISTS / IF NOT EXISTS throughout so this stays safe to run
-- against a database that either already has these objects or doesn't.

create table if not exists telegram_chats (
  chat_id     text primary key,
  messages    jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table media_assets
  add column if not exists slot text,
  add column if not exists prompt text,
  add column if not exists model text,
  add column if not exists aspect_ratio text,
  add column if not exists is_current boolean not null default true;

create index if not exists media_assets_influencer_slot_idx
  on media_assets (influencer_id, slot);
