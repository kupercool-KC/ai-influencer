-- Postiz (previously self-hosted on Railway) has been decommissioned in
-- favor of Buffer. Renaming the column it left behind and removing the
-- Railway hosting cost now that the account is deleted.

alter table scheduled_dispatches rename column postiz_post_id to buffer_post_id;

delete from expenses where provider = 'railway' and label = 'Railway (Postiz hosting)';
