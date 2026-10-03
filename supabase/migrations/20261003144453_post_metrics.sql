-- Performance of Ivy's published posts (Buffer metrics, refreshed daily) so planning can learn from what worked.
create table post_metrics (
  buffer_post_id text primary key,
  platform text not null,
  kind text,                      -- post | story | reel | tiktok
  text text,
  posted_at timestamptz,
  external_link text,
  metrics jsonb not null default '{}'::jsonb,   -- {views, reach, reactions, comments, shares, saves, follows, engagementRate}
  updated_at timestamptz not null default now()
);
create index post_metrics_posted_idx on post_metrics (posted_at desc);
alter table post_metrics enable row level security;
revoke all on post_metrics from anon, authenticated;
