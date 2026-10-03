-- The release gate adds three states: approved (queued for release, Buffer post still a draft),
-- skipped (owner cancelled it) and missed (slot passed without a tap).
alter table scheduled_dispatches drop constraint scheduled_dispatches_status_check;
alter table scheduled_dispatches add constraint scheduled_dispatches_status_check
  check (status = any (array['pending','approved','scheduled','posted','failed','skipped','missed']));
