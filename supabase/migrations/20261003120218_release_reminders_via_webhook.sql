-- Vercel Hobby allows 12 serverless functions per deployment; the reminder job now rides on the
-- existing Telegram webhook function (?job=release-reminders) instead of its own api/ file.
select cron.unschedule('release-reminders');
select cron.schedule(
  'release-reminders',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://ai-influencer-lovat.vercel.app/api/telegram/webhook?job=release-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select value from public.service_credentials where name = 'cron_secret')),
    body := '{}'::jsonb
  );
  $cron$
);
