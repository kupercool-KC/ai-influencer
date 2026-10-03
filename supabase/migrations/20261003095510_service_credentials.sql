-- Server-side secrets that must be rewritten by automation itself (e.g. the Higgsfield OAuth
-- session, whose refresh token rotates on use, so a static GitHub secret goes stale).
-- RLS on with no policies = only the service role can read/write; anon/authenticated get nothing.
create table service_credentials (
  name text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table service_credentials enable row level security;
revoke all on service_credentials from anon, authenticated;
