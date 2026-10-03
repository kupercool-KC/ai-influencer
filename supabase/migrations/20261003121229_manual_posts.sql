-- "Post by message": the owner sends photos/videos with a caption to the bot and it posts them.
-- Telegram files can't be handed to Buffer (their URLs contain the bot token), so they are copied
-- into a public storage bucket first; telegram_uploads collects the items of one album.
insert into storage.buckets (id, name, public) values ('post-media', 'post-media', true) on conflict (id) do nothing;

create table telegram_uploads (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  thread_id text,
  message_id bigint not null,
  media_group_id text,
  kind text not null check (kind in ('photo', 'video')),
  url text not null,
  caption text,
  created_at timestamptz not null default now()
);
create index telegram_uploads_group_idx on telegram_uploads (media_group_id);
alter table telegram_uploads enable row level security;
revoke all on telegram_uploads from anon, authenticated;
