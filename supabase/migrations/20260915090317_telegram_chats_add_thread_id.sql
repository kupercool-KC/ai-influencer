alter table telegram_chats add column if not exists thread_id text not null default '';
alter table telegram_chats add column if not exists topic_name text;
alter table telegram_chats drop constraint if exists telegram_chats_pkey;
alter table telegram_chats add primary key (chat_id, thread_id);
