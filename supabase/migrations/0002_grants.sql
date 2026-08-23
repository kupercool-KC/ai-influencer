-- Tables created directly via the SQL Editor don't automatically receive the
-- standard privilege grants Supabase's dashboard tooling normally applies —
-- service_role hit "permission denied" on every table as a result (RLS being
-- on is a separate, row-level layer; this is the more basic table-level
-- grant that has to exist underneath it).
--
-- Fixes existing tables, and sets default privileges so any table created by
-- a future migration gets this automatically too.

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;
