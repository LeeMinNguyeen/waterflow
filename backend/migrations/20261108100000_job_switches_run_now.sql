-- Every daily job can be turned off, the backup and the purge included (Server admin warns what that means), and
-- any can be asked to run now: the API can't run one itself (the backup needs the owner's login), so it leaves a
-- request the scheduler picks up at its next look.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.jobs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%enabled%rates%';
  if c is not null then
    execute format('alter table jobs drop constraint %I', c);
  end if;
end $$;
alter table jobs add column if not exists run_requested_at timestamptz;

drop function if exists admin_jobs();
create function admin_jobs()
returns table (name text, at_minute int, timezone text, enabled boolean, changed_at timestamptz,
               last_started_at timestamptz, last_finished_at timestamptz, last_result text, last_detail text,
               run_requested_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  return query
    select j.name, j.at_minute, j.timezone, j.enabled, j.changed_at, j.last_started_at, j.last_finished_at,
           j.last_result, j.last_detail, j.run_requested_at
      from jobs j order by array_position(array['purge', 'backup', 'rates'], j.name);
end $$;
revoke execute on function admin_jobs() from public;
grant execute on function admin_jobs() to app_user;

create or replace function admin_run_job(p_name text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  if not exists (select 1 from jobs where name = p_name) then
    raise exception 'not_found: no such job';
  end if;
  -- A run that started and never finished (killed, or a restore of a backup it was making) stops counting as
  -- running after 45 minutes, as the scheduler retries it then.
  update jobs set run_requested_at = now()
   where name = p_name and (last_started_at is null or last_started_at <= coalesce(last_finished_at, '-infinity')
                            or last_started_at < now() - interval '45 minutes');
  if not found then
    raise exception 'job_running: this job is running now';
  end if;
end $$;
revoke execute on function admin_run_job(text) from public;
grant execute on function admin_run_job(text) to app_user;

-- The scheduler reads Run now from here, beside job_schedule(), which keeps its columns.
create or replace function job_run_requests()
returns table (name text, run_requested_at timestamptz)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select j.name, j.run_requested_at from jobs j
$$;
revoke execute on function job_run_requests() from public;
grant execute on function job_run_requests() to account_purger;

-- For everyone, before sign-in too: the app says when closed accounts aren't being deleted.
create or replace function account_purge_on() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select enabled from jobs where name = 'purge'), true)
$$;
revoke execute on function account_purge_on() from public;
grant execute on function account_purge_on() to app_user;
