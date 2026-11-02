-- A purged owner's shared book goes to a co-member whose account is closed but can still be restored, rather than
-- being deleted, when no open member is left: within their 30 days everything is back as it was.
create or replace function purge_account(u uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  solo uuid[];
  b record;
  successor uuid;
begin
  -- Books nobody else uses: delete them (their audit rows go with them).
  select coalesce(array_agg(m.book_id), '{}') into solo
    from book_members m
   where m.user_id = u
     and not exists (select 1 from book_members o where o.book_id = m.book_id and o.user_id <> u);
  delete from books where id = any(solo);

  -- Shared books where they were the only open owner: hand over, to an open account first, else to one that is
  -- closed but can still be restored within its 30 days (a purge removes the books it then has alone).
  for b in select m.book_id from book_members m
            where m.user_id = u and m.role = 'owner' and m.accepted_at is not null
              and not exists (select 1 from book_members o join users ou on ou.id = o.user_id
                               where o.book_id = m.book_id and o.user_id <> u
                                 and o.role = 'owner' and o.accepted_at is not null
                                 and ou.deletion_requested_at is null)
  loop
    select o.user_id into successor from book_members o
      join users ou on ou.id = o.user_id
     where o.book_id = b.book_id and o.user_id <> u and o.accepted_at is not null
       and ou.deletion_requested_at is null
     order by o.role, o.accepted_at          -- owner, then editor, then viewer
     limit 1;
    if successor is null then
      select o.user_id into successor from book_members o
        join users ou on ou.id = o.user_id
       where o.book_id = b.book_id and o.user_id <> u and o.accepted_at is not null and ou.deleted_at is null
       order by o.role, o.accepted_at
       limit 1;
    end if;
    if successor is null then          -- only pending invites left
      delete from books where id = b.book_id;
    else
      update book_members set role = 'owner' where book_id = b.book_id and user_id = successor;
    end if;
  end loop;

  -- Everything personal goes. The id stays as a bare row, so what they did in
  -- shared books shows as "Deleted user" (see book_people) and two deleted
  -- users stay distinct. With the login deleted too, nothing links the id to
  -- a person. The username is freed: someone new can take it, with a new id.
  delete from book_members where user_id = u;          -- books they created move to another owner (move_book_creator)
  delete from local_credentials where user_id = u;
  delete from recovery_codes where user_id = u;
  delete from sessions where user_id = u;
  update users set username = null, display_name = null, timezone = 'UTC', language = 'vi', is_admin = false,
                   disabled_at = null, deletion_requested_at = null, deleted_at = now()
   where id = u;
end $$;

-- Sign-out after inactivity is 1 to 60 minutes, or never, as the app offers.
update users set idle_sign_out_minutes = 60 where idle_sign_out_minutes > 60;
alter table users drop constraint if exists users_idle_sign_out_minutes_check;
alter table users add constraint users_idle_sign_out_minutes_check check (idle_sign_out_minutes between 1 and 60);
