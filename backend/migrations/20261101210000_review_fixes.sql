-- A category is never its own parent, and a cycle two moves at once can still make (A under B while B moves under A)
-- ends the ancestors' walk, which budgets and the transaction filter read: union, not union all.
update categories set parent_id = null where parent_id = id;
alter table categories drop constraint if exists categories_not_own_parent;
alter table categories add constraint categories_not_own_parent check (parent_id is distinct from id);

create or replace view category_ancestors with (security_invoker = true) as
with recursive up as (
  select id as category_id, id as ancestor_id, parent_id from categories
  union
  select up.category_id, c.id, c.parent_id
    from up join categories c on c.id = up.parent_id
)
select category_id, ancestor_id from up;

-- The book is locked first, so of two owners removing or demoting each other at once the second waits and then sees
-- the first's change.
create or replace function keep_an_owner() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.role = 'owner' and old.accepted_at is not null and (tg_op = 'DELETE' or new.role <> 'owner') then
    perform 1 from books where id = old.book_id for update;
    if exists (select 1 from books where id = old.book_id)
       and not exists (select 1 from book_members
                        where book_id = old.book_id and user_id <> old.user_id
                          and role = 'owner' and accepted_at is not null) then
      raise exception 'owner_required: a book needs at least one owner; make someone else owner first';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- A budget's category stays an expense one.
create or replace function category_kind_keeps_budgets() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.kind <> 'expense' and exists (select 1 from budgets where category_id = new.id) then
    raise exception 'budget_expense_only: budgets can only be set on expense categories';
  end if;
  return new;
end $$;

drop trigger if exists categories_keep_budgets on categories;
create trigger categories_keep_budgets before update of kind on categories
  for each row when (new.kind is distinct from old.kind) execute function category_kind_keeps_budgets();
grant execute on function category_kind_keeps_budgets() to app_user;

-- A plan's conversion date is checked when it's made or that date changes, so a purchase moved to a later date keeps
-- a plan that can still change (Pay off early). Errors carry a code.
create or replace function installment_plan_fits() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  t record;
begin
  select tx.type, tx.occurred_on, a.id as account_id, a.kind, a.statement_day,
         (select count(*) from entries x where x.transaction_id = tx.id) as entry_count
    into t
    from transactions tx join entries e on e.transaction_id = tx.id join accounts a on a.id = e.account_id
   where tx.id = new.transaction_id
   limit 1;
  if not found or t.type <> 'expense' or t.entry_count <> 1 or t.kind <> 'credit_card' or t.statement_day is null then
    raise exception 'installment_invalid: an installment plan needs an expense on a credit card with a statement day';
  end if;
  if tg_op = 'INSERT' or new.converted_on is distinct from old.converted_on or new.transaction_id <> old.transaction_id then
    if new.converted_on < t.occurred_on then
      raise exception 'installment_invalid: a purchase is converted on or after its date';
    end if;
  end if;
  new.account_id := t.account_id;
  return new;
end $$;

-- A run that started and never finished (killed midway) counts as failed, so it's retried like one.
create or replace function job_schedule()
returns table (name text, at_minute int, timezone text, enabled boolean, changed_at timestamptz,
               last_started_at timestamptz, last_result text)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select j.name, j.at_minute, j.timezone, j.enabled, j.changed_at, j.last_started_at,
         case when j.last_started_at > coalesce(j.last_finished_at, '-infinity') then 'failed' else j.last_result end
    from jobs j order by array_position(array['purge', 'backup', 'rates'], j.name)
$$;

-- The people of a book (book_people) and its history read the edit history by book.
create index if not exists transaction_history_book_idx on transaction_history (book_id);
