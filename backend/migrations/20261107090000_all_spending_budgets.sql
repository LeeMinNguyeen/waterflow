-- A budget with no category is for all spending in the book, with or without a category, except the expense
-- categories it leaves out (and their sub-categories). One per period, as there is one per category and period.
alter table budgets alter column category_id drop not null;
alter table budgets add column if not exists excluded_category_ids uuid[] not null default '{}';
create unique index if not exists budgets_all_spending_period on budgets (book_id, period) where category_id is null;

-- Only what a statement adds is checked: one left out earlier and since changed doesn't lock the budget.
create or replace function budget_exclusions_valid() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  added uuid[] := new.excluded_category_ids;
begin
  if tg_op = 'UPDATE' then
    added := array(select x from unnest(new.excluded_category_ids) x where x <> all (old.excluded_category_ids));
  end if;
  if cardinality(new.excluded_category_ids) > 0 and new.category_id is not null or exists (
       select 1 from unnest(added) x
        where not exists (select 1 from categories c where c.id = x and c.book_id = new.book_id and c.kind = 'expense')) then
    raise exception using errcode = 'check_violation',
      message = 'budget_exclusions: only a budget for all spending leaves out categories, and only its own book''s expense ones';
  end if;
  return new;
end $$;
drop trigger if exists budgets_exclusions_valid on budgets;
create trigger budgets_exclusions_valid before insert or update of category_id, excluded_category_ids on budgets
  for each row execute function budget_exclusions_valid();
grant execute on function budget_exclusions_valid() to app_user;

create or replace function category_leaves_budgets() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if not exists (select 1 from books where id = old.book_id) then return null; end if;   -- the whole book goes
  update budgets set excluded_category_ids = array_remove(excluded_category_ids, old.id)
   where book_id = old.book_id and old.id = any (excluded_category_ids);
  return null;
end $$;
drop trigger if exists categories_leave_budgets on categories;
create trigger categories_leave_budgets after delete on categories
  for each row execute function category_leaves_budgets();
grant execute on function category_leaves_budgets() to app_user;

create or replace view budget_progress with (security_invoker = true) as
with b as (
  select bu.*, (now() at time zone bk.timezone)::date as today
    from budgets bu join books bk on bk.id = bu.book_id
), p as (
  select b.*,
         date_trunc(case b.period when 'daily' then 'day' when 'weekly' then 'week'
                                  when 'monthly' then 'month' when 'quarterly' then 'quarter'
                                  else 'year' end, b.today::timestamp)::date as period_start
    from b
   where b.starts_on <= b.today and (b.ends_on is null or b.ends_on >= b.today)
), q as (
  select p.*,
         (period_start + case period when 'daily' then interval '1 day' when 'weekly' then interval '1 week'
                                     when 'monthly' then interval '1 month' when 'quarterly' then interval '3 months'
                                     else interval '1 year' end)::date - 1 as period_end
    from p
)
select q.id as budget_id, q.book_id, q.category_id, c.name as category, q.period,
       q.period_start, q.period_end, q.amount as budget,
       coalesce(s.spent, 0)::bigint as spent,
       (q.amount - coalesce(s.spent, 0))::bigint as remaining,
       round(100.0 * coalesce(s.spent, 0) / q.amount, 1) as percent_used,
       coalesce(s.not_converted, 0) as not_converted,
       q.excluded_category_ids
  from q
  left join categories c on c.id = q.category_id
  left join lateral (
    select -sum(x.base_amount) as spent,
           count(*) filter (where x.base_amount is null) as not_converted
      from book_txn_amounts x
     where x.book_id = q.book_id
       and x.type in ('expense', 'refund')
       and x.occurred_on between greatest(q.period_start, q.starts_on) and q.period_end
       and case when q.category_id is null
                then not exists (select 1 from category_ancestors ca
                                  where ca.category_id = x.category_id and ca.ancestor_id = any (q.excluded_category_ids))
                else exists (select 1 from category_ancestors ca
                              where ca.category_id = x.category_id and ca.ancestor_id = q.category_id) end
  ) s on true
 where q.category_id is null or c.archived_at is null;   -- archiving a category hides its own budgets
