-- A card purchase the bank posted after its statement closed is billed on the next one: posted_on is the first day
-- that statement covers. The purchase keeps its date, so balances and spending don't move.
alter table transactions add column if not exists posted_on date;
alter table transactions drop constraint if exists transactions_posted_on_check;
alter table transactions add constraint transactions_posted_on_check
  check (posted_on is null or (type = 'expense' and posted_on > occurred_on and posted_on <= occurred_on + 31));
grant insert (posted_on), update (posted_on) on transactions to app_user;

-- As in 20261107100000_restore_transactions.sql, with posted_on.
create or replace function restore_transaction(p_book uuid, p_txn uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  gone transaction_history;
  s jsonb;
  plan installment_plans;
begin
  if not can_write_book(p_book) then
    raise exception 'not allowed to change this book' using errcode = 'insufficient_privilege';
  end if;
  select * into gone from transaction_history
   where book_id = p_book and transaction_id = p_txn and action = 'deleted' order by version desc, id desc limit 1;
  if not found then
    raise exception 'not_found: no deleted transaction with this id in this book';
  end if;
  if exists (select 1 from transactions where id = p_txn) then
    raise exception 'already_restored: this transaction is back already';
  end if;
  if gone.changed_at < now() - interval '30 days' then
    raise exception 'restore_expired: a deleted transaction can be brought back for 30 days';
  end if;
  -- This book's own snapshot: ids come from clients, and another book may have used the same one since.
  select snapshot into s from transaction_history
   where book_id = p_book and transaction_id = p_txn and action <> 'deleted' and version <= gone.version
   order by version desc, id desc limit 1;
  if s is null then
    raise exception 'not_found: no saved version of this transaction in this book';
  end if;
  -- The same number in another currency would be another amount.
  if exists (select 1 from jsonb_array_elements(s->'entries') e
               left join accounts a on a.id = (e->>'account_id')::uuid and a.book_id = p_book
              where a.id is null or a.currency is distinct from e->>'currency') then
    raise exception 'restore_changed: an account of this transaction is gone or has another currency now';
  end if;

  insert into transactions (id, book_id, type, occurred_on, posted_on, occurred_time, category_id, payee, note,
                            created_by, created_at, version)
  values (p_txn, p_book, (s->>'type')::txn_type, (s->>'occurred_on')::date, (s->>'posted_on')::date,
          coalesce((s->>'occurred_time')::time, '00:00'),
          (select c.id from categories c                -- a category deleted or changed since is left off
            where c.id = (s->>'category_id')::uuid and c.book_id = p_book and (c.kind = 'transfer') = (s->>'type' = 'transfer')),
          s->>'payee', s->>'note',
          (select id from users where id = (s->>'created_by')::uuid), (s->>'created_at')::timestamptz, gone.version + 1)
  on conflict do nothing;        -- another restore of it committed first; this one waited for it
  if not found then
    raise exception 'already_restored: this transaction is back already';
  end if;
  insert into entries (book_id, transaction_id, account_id, amount)
  select p_book, p_txn, (e->>'account_id')::uuid, (e->>'amount')::bigint from jsonb_array_elements(s->'entries') e;

  -- The plan deleted with it: its audit row has the same time as the deletion. It comes back while the purchase is
  -- still an expense on a card with a statement day, converted when it was, even if the purchase moved later since.
  select p.* into plan
    from audit_log a, jsonb_populate_record(null::installment_plans, a.old_row) p
   where a.table_name = 'installment_plans' and a.action = 'DELETE' and a.book_id = p_book
     and a.old_row->>'transaction_id' = p_txn::text and a.at = gone.changed_at
   order by a.id desc limit 1;
  if found and s->>'type' = 'expense' and jsonb_array_length(s->'entries') = 1 and exists (
       select 1 from accounts a where a.id = (s->'entries'->0->>'account_id')::uuid and a.book_id = p_book
          and a.kind = 'credit_card' and a.statement_day is not null) then
    perform set_config('waterflow.restoring_plan', plan.id::text, true);
    insert into installment_plans values (plan.*) on conflict do nothing;
    perform set_config('waterflow.restoring_plan', '', true);
  end if;
end $$;
grant execute on function restore_transaction(uuid, uuid) to app_user;
