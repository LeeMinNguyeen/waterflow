-- Usage numbers for the server's admin, off until they turn it on: per day, per feature, per person, a count. The
-- person is a keyed hash of the user id, so the table can't be joined to users by reading it, and a new key (when
-- the admin deletes the numbers) makes old rows meaningless. Nothing of anyone's data: no amount, text or id.
alter table instance_settings add column if not exists usage_stats boolean not null default false;
alter table instance_settings add column if not exists usage_keep_days int not null default 90;
alter table instance_settings add column if not exists usage_key bytea;
alter table instance_settings drop constraint if exists instance_settings_usage_keep_days_check;
alter table instance_settings add constraint instance_settings_usage_keep_days_check
  check (usage_keep_days in (30, 90, 180, 365));

-- Everything that can be counted. from_client: reported by the app itself (POST /v1/usage), as only it knows.
create table if not exists usage_features (
  name         text primary key check (name ~ '^[a-z][a-z0-9_]{1,39}$'),
  from_client  boolean not null default false
);
insert into usage_features (name, from_client) values
  ('active', false),
  ('transaction_expense', false), ('transaction_income', false), ('transaction_transfer', false),
  ('transaction_refund', false), ('transaction_other', false),
  ('transaction_edit', false), ('transaction_delete', false), ('transaction_restore', false),
  ('filters', false), ('budget', false), ('category', false), ('account', false), ('person', false),
  ('installment', false), ('next_statement', false), ('book_shared', false), ('export', false),
  ('card_pay', true), ('hide_amounts', true), ('appearance_dark', true), ('appearance_light', true),
  ('layout_phone', true), ('layout_desktop', true)
on conflict (name) do nothing;

create table if not exists usage_days (
  day       date not null,
  feature   text not null references usage_features(name) on delete cascade,
  user_ref  bytea not null check (length(user_ref) = 32),
  count     int not null default 1 check (count > 0),
  primary key (day, feature, user_ref)
);
-- No policies and no grants: written and read only through the functions below.
alter table usage_features enable row level security;
alter table usage_days enable row level security;
revoke all on usage_features, usage_days from public;

create or replace function usage_on() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select usage_stats from instance_settings
$$;

-- False when the feature isn't one of the list (or not the app's to report). Does nothing while collecting is off.
create or replace function usage_count(p_feature text, p_from_client boolean default false) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  s instance_settings;
  who uuid := current_app_user();
  today date := (now() at time zone 'utc')::date;
  ref bytea;
begin
  if not exists (select 1 from usage_features where name = p_feature and from_client = p_from_client and name <> 'active') then
    return false;
  end if;
  select * into s from instance_settings;
  if not s.usage_stats or s.usage_key is null or who is null then
    return true;
  end if;
  ref := sha256(s.usage_key || uuid_send(who));
  insert into usage_days (day, feature, user_ref) values (today, p_feature, ref)
  on conflict (day, feature, user_ref) do update set count = usage_days.count + 1;
  insert into usage_days (day, feature, user_ref) values (today, 'active', ref) on conflict do nothing;
  return true;
end $$;

create or replace function admin_set_usage(p_on boolean, p_keep_days int) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  update instance_settings
     set usage_stats = coalesce(p_on, usage_stats),
         usage_keep_days = coalesce(p_keep_days, usage_keep_days),
         usage_key = case when coalesce(p_on, usage_stats) and usage_key is null
                          then sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())) else usage_key end;
end $$;

create or replace function admin_delete_usage() returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform require_admin();
  delete from usage_days;
  update instance_settings
     set usage_key = case when usage_stats then sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())) end;
end $$;

create or replace function admin_usage() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  today date := (now() at time zone 'utc')::date;
begin
  perform require_admin();
  return jsonb_build_object(
    'collecting', (select usage_stats from instance_settings),
    'keep_days', (select usage_keep_days from instance_settings),
    'since', (select min(day) from usage_days),
    'people', jsonb_build_object(
      'accounts', (select count(*) from users where deleted_at is null),
      'new_this_month', (select count(*) from users where deleted_at is null and created_at >= date_trunc('month', now())),
      'today', (select count(distinct user_ref) from usage_days where feature = 'active' and day = today),
      'days_7', (select count(distinct user_ref) from usage_days where feature = 'active' and day > today - 7),
      'days_30', (select count(distinct user_ref) from usage_days where feature = 'active' and day > today - 30)),
    'days', (select jsonb_agg(jsonb_build_object('day', d::date, 'people',
                      (select count(*) from usage_days u where u.feature = 'active' and u.day = d::date)) order by d)
               from generate_series(today - 29, today, interval '1 day') d),
    'features', (select coalesce(jsonb_agg(jsonb_build_object('feature', f.feature, 'people', f.people, 'times', f.times)
                                           order by f.people desc, f.times desc, f.feature), '[]'::jsonb)
                   from (select feature, count(distinct user_ref) as people, sum(count) as times
                           from usage_days where feature <> 'active' and day > today - 30 group by feature) f),
    'server', jsonb_build_object(
      'books', (select count(*) from books),
      'shared_books', (select count(*) from (select book_id from book_members where accepted_at is not null
                                              group by book_id having count(*) > 1) s)));
end $$;

create or replace function purge_usage() returns int
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  n int;
begin
  delete from usage_days
   where day < (now() at time zone 'utc')::date - (select usage_keep_days from instance_settings);
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function usage_on(), usage_count(text, boolean), admin_set_usage(boolean, int), admin_delete_usage(),
  admin_usage(), purge_usage() from public;
grant execute on function usage_on(), usage_count(text, boolean), admin_set_usage(boolean, int), admin_delete_usage(),
  admin_usage() to app_user;
grant execute on function purge_usage() to account_purger;
