-- Applied directly against the remote project earlier and only backfilled
-- into this repo afterward — see agents/README.md's Telegram bot section.

alter table telegram_chats
  add column if not exists mode text not null default 'chat',
  add column if not exists histories jsonb not null default '{"scout": [], "generate": [], "dispatch": [], "chat": []}'::jsonb;

-- Migrate any existing single-thread history into the "chat" tab so nothing is lost.
update telegram_chats
set histories = jsonb_set(histories, '{chat}', coalesce(messages, '[]'::jsonb))
where messages is not null and messages != '[]'::jsonb;
