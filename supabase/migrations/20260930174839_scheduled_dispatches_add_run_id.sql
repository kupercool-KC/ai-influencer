-- Groups all of one day's Buffer drafts (feed post, TikTok, both Stories) under the
-- content-scout run that produced them, so a single Telegram "Approve" tap can look up
-- and schedule every row from that run in one shot.
alter table scheduled_dispatches add column run_id text;
create index scheduled_dispatches_run_id_idx on scheduled_dispatches (run_id);
