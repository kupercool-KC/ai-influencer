-- Release gate: nothing is published without the owner's tap shortly before its slot.
-- Statuses on scheduled_dispatches now mean: pending (draft awaiting the first approval),
-- approved (queued for release; the Buffer post stays a DRAFT), scheduled (released to Buffer at
-- its slot after the owner tapped publish), skipped / missed (not published).
-- reminder_sent_at marks that the "15 minutes to go" Telegram prompt went out.
alter table scheduled_dispatches add column reminder_sent_at timestamptz;
alter table scheduled_dispatches add column released_at timestamptz;

-- Every minute, pg_cron asks the Vercel endpoint to send due prompts. The shared secret lives in
-- service_credentials (service-role only), generated here so it never appears in the repo.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
insert into service_credentials (name, value)
  values ('cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;
select cron.schedule(
  'release-reminders',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://ai-influencer-lovat.vercel.app/api/cron/release-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select value from public.service_credentials where name = 'cron_secret')),
    body := '{}'::jsonb
  );
  $cron$
);
