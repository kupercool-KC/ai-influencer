create table if not exists deleted_influencers (
  id text primary key,
  deleted_at timestamptz default now()
);
