-- Written idempotently: the table was already created by hand (via the SQL
-- Editor, to unblock testing on dev before this migration was reviewed and
-- merged) with a simplified schema missing the check constraints and FKs
-- below. This version works whether run against a fresh database or ours,
-- which already has the bare table.

create table if not exists expenses (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,
  provider        text not null,
  label           text not null,
  amount_usd      numeric(10,2) not null,
  billing_period  text,
  influencer_id   text,
  media_asset_id  uuid,
  occurred_at     date not null default current_date,
  notes           text,
  created_at      timestamptz not null default now()
);

do $$ begin
  alter table expenses add constraint expenses_kind_check check (kind in ('recurring', 'one_time', 'per_use'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table expenses add constraint expenses_billing_period_check check (billing_period in ('monthly', 'yearly'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table expenses add constraint expenses_influencer_id_fkey foreign key (influencer_id) references influencers(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table expenses add constraint expenses_media_asset_id_fkey foreign key (media_asset_id) references media_assets(id) on delete set null;
exception when duplicate_object then null; end $$;

alter table expenses enable row level security;

grant select, insert, update, delete on expenses to service_role;

insert into expenses (kind, provider, label, amount_usd, billing_period, notes)
select 'recurring', 'anthropic', 'Claude Pro', 20.00, 'monthly', null
where not exists (select 1 from expenses where provider = 'anthropic' and label = 'Claude Pro');

insert into expenses (kind, provider, label, amount_usd, billing_period, notes)
select 'recurring', 'railway', 'Railway (Postiz hosting)', 5.00, 'monthly', 'Currently in 30-day free trial — this is the cost once it ends'
where not exists (select 1 from expenses where provider = 'railway' and label = 'Railway (Postiz hosting)');
