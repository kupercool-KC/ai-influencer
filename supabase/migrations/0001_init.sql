-- Core schema for AI Influencer Studio's backend database.
--
-- Design note: influencer profiles have many free-form, evolving fields
-- (wardrobe slots, brand deals, palette, prompts — see src/store.jsx seeds).
-- Rather than a rigid column per field, well-known scalar fields get real
-- columns (for filtering/joins) and the rest lives in `data jsonb`, so the
-- schema doesn't need a migration every time the app adds a profile field.
--
-- All tables have RLS enabled with no public policies: only the service-role
-- key (used exclusively from Vercel serverless functions, never the browser)
-- can read/write. There is no separate end-user auth system yet.

create table influencers (
  id            text primary key,
  name          text not null,
  gender        text,
  niche         text,
  created_at    timestamptz not null default now(),
  data          jsonb not null default '{}'::jsonb
);

create table media_assets (
  id             uuid primary key default gen_random_uuid(),
  influencer_id  text references influencers(id) on delete cascade,
  type           text not null check (type in ('image', 'video')),
  label          text,
  url            text not null,
  source         text,
  created_at     timestamptz not null default now()
);

create table activity_logs (
  id             uuid primary key default gen_random_uuid(),
  event_type     text not null,
  influencer_id  text references influencers(id) on delete set null,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

-- One row per (content, platform) we asked Postiz to publish. We don't
-- duplicate Postiz's own scheduling engine — postiz_post_id is just a
-- pointer back to the post it owns and is tracking.
create table scheduled_dispatches (
  id              uuid primary key default gen_random_uuid(),
  influencer_id   text references influencers(id) on delete cascade,
  media_asset_id  uuid references media_assets(id) on delete set null,
  platform        text not null check (platform in ('tiktok', 'instagram', 'youtube', 'facebook')),
  postiz_post_id  text,
  status          text not null default 'pending' check (status in ('pending', 'scheduled', 'posted', 'failed')),
  scheduled_for   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Placeholder for the future FanView feature. Structure only — no app code
-- reads/writes this yet. Exists now because retrofitting a relation onto
-- existing data later is costlier than sketching it up front.
create table fan_interactions (
  id             uuid primary key default gen_random_uuid(),
  influencer_id  text references influencers(id) on delete cascade,
  fan_identifier text not null,
  message        text,
  created_at     timestamptz not null default now()
);

alter table influencers           enable row level security;
alter table media_assets          enable row level security;
alter table activity_logs         enable row level security;
alter table scheduled_dispatches  enable row level security;
alter table fan_interactions      enable row level security;
