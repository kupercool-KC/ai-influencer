-- Phase 2: one shared record per piece of content, managed inspiration sources, owner preferences, auto-release.

-- A content item follows a post from inspiration to published, so every agent (and every Telegram button)
-- talks about the same thing by run_id.
create table content_items (
  id uuid primary key default gen_random_uuid(),
  run_id text not null unique,
  influencer_id text default 'ivy-vale',
  kind text,                       -- image | carousel | video
  source_url text,                 -- the inspiration link, when there was one
  source_summary text,
  status text not null default 'planned',   -- planned | in_review | approved | scheduled | published | failed | deleted
  plan jsonb,                      -- the content plan day (prompts, captions, ...)
  media jsonb,                     -- generated pictures/video + slot times
  notes jsonb not null default '[]'::jsonb, -- owner feedback / revisions, newest last
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Accounts Scout watches. Managed from Telegram instead of being hard-coded in the workflow.
create table inspiration_accounts (
  platform text not null check (platform in ('instagram', 'tiktok')),
  handle text not null,
  active boolean not null default true,
  added_at timestamptz not null default now(),
  primary key (platform, handle)
);
insert into inspiration_accounts (platform, handle) values
  ('instagram', 'nika_yammys'), ('instagram', 'milena_milenko'), ('instagram', 'sophiebatzloff'), ('instagram', 'ellarayblond'),
  ('tiktok', 'millane'), ('tiktok', 'chiaraking'), ('tiktok', 'sydneyschiffer'), ('tiktok', 'ell_turner');

-- Posts Scout pushed to the owner (so none repeats) and what he did with them.
create table inspiration_candidates (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  platform text,
  author text,
  score numeric,
  summary_he text,
  status text not null default 'sent',      -- sent | used | skipped
  created_at timestamptz not null default now()
);

-- Standing instructions ("from now on ...") that every agent and the plan prompts must follow.
create table owner_preferences (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table scheduled_dispatches add column auto_release boolean not null default false;

alter table content_items enable row level security;
alter table inspiration_accounts enable row level security;
alter table inspiration_candidates enable row level security;
alter table owner_preferences enable row level security;
revoke all on content_items, inspiration_accounts, inspiration_candidates, owner_preferences from anon, authenticated;
