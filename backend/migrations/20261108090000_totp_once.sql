-- RFC 6238 §5.2: a two-step code is accepted once. The last time step used is kept, and only a later one is taken.
alter table local_credentials add column if not exists totp_last_step bigint;

-- Called before anyone is signed in, so security definer. Only a step far ahead could block later codes, so it
-- refuses one more than 5 minutes past the database's clock, which allows for a server clock that differs that much.
create or replace function use_totp_step(p_user uuid, p_step bigint) returns boolean
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if p_step is null or p_step > floor(extract(epoch from clock_timestamp()) / 30) + 10 then
    return false;
  end if;
  update local_credentials set totp_last_step = p_step
   where user_id = p_user and totp_secret is not null and (totp_last_step is null or totp_last_step < p_step);
  return found;
end $$;
grant execute on function use_totp_step(uuid, bigint) to app_user;

-- A new secret starts with no step used.
create or replace function totp_secret_resets_step() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  new.totp_last_step := null;
  return new;
end $$;
drop trigger if exists totp_secret_resets_step on local_credentials;
create trigger totp_secret_resets_step before update of totp_secret on local_credentials
  for each row when (new.totp_secret is distinct from old.totp_secret) execute function totp_secret_resets_step();
