create table expenses (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('recurring', 'one_time', 'per_use')),
  provider        text not null,
  label           text not null,
  amount_usd      numeric(10,2) not null,
  billing_period  text check (billing_period in ('monthly', 'yearly')),
  influencer_id   text references influencers(id) on delete set null,
  media_asset_id  uuid references media_assets(id) on delete set null,
  occurred_at     date not null default current_date,
  notes           text,
  created_at      timestamptz not null default now()
);

alter table expenses enable row level security;

-- Explicit grant even though 0002's default-privileges should already cover
-- this — cheap to be certain rather than repeat that debugging cycle.
grant select, insert, update, delete on expenses to service_role;

insert into expenses (kind, provider, label, amount_usd, billing_period, notes) values
  ('recurring', 'anthropic', 'Claude Pro', 20.00, 'monthly', null),
  ('recurring', 'railway', 'Railway (Postiz hosting)', 5.00, 'monthly', 'Currently in 30-day free trial — this is the cost once it ends');
