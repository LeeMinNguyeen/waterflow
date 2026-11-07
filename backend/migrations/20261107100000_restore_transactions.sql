-- A deleted transaction comes back for 30 days, as it was last saved: same id, the next version, and history action
-- 'restored'. Its card installment plan, deleted with it, comes back too.
alter table transaction_history drop constraint if exists transaction_history_action_check;
alter table transaction_history add constraint transaction_history_action_check
  check (action in ('created', 'edited', 'deleted', 'restored'));

create or replace function record_transaction_history() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  t transactions;
begin
  if tg_op = 'DELETE' then
    -- The whole book is being deleted: nothing to keep.
    if not exists (select 1 from books where id = old.book_id) then return null; end if;
    insert into transaction_history (book_id, transaction_id, version, action, snapshot, changed_by)
    values (old.book_id, old.id, old.version, 'deleted', to_jsonb(old), current_app_user())
    on conflict do nothing;
    return null;
  end if;

  -- Deferred to commit: read the row as finally saved, with its entries.
  select * into t from transactions where id = new.id;
  if not found then return null; end if;   -- created and deleted in the same DB transaction
  insert into transaction_history (book_id, transaction_id, version, action, snapshot, changed_by)
  values (t.book_id, t.id, t.version,
          -- Only restore_transaction() inserts a version past 1.
          case when t.version = 1 then 'created' when tg_op = 'INSERT' then 'restored' else 'edited' end,
          to_jsonb(t) || jsonb_build_object('entries',
            (select coalesce(jsonb_agg(jsonb_build_object('account_id', e.account_id, 'amount', e.amount,
                                                          'currency', a.currency)
                                       order by e.amount), '[]'::jsonb)
               from entries e join accounts a on a.id = e.account_id where e.transaction_id = t.id)),
          t.modified_by)
  on conflict do nothing;                  -- one snapshot per version
  return null;
end $$;

-- Security definer: the app's login can't set a row's version, creator or creation time. So it checks the caller
-- can write the book itself.
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

  insert into transactions (id, book_id, type, occurred_on, occurred_time, category_id, payee, note,
                            created_by, created_at, version)
  values (p_txn, p_book, (s->>'type')::txn_type, (s->>'occurred_on')::date, coalesce((s->>'occurred_time')::time, '00:00'),
          (select c.id from categories c                -- a category deleted or changed since is left off
            where c.id = (s->>'category_id')::uuid and c.book_id = p_book and (c.kind = 'transfer') = (s->>'type' = 'transfer')),
          s->>'payee', s->>'note',
          (select id from users where id = (s->>'created_by')::uuid), (s->>'created_at')::timestamptz, gone.version + 1)
  on conflict (id) do nothing;   -- another restore of it at the same moment, which waits for this one
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

-- As in 20261101210000_review_fixes.sql, except a plan restore_transaction() brings back keeps its conversion date.
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
  if (tg_op = 'INSERT' and current_setting('waterflow.restoring_plan', true) is distinct from new.id::text)
     or (tg_op = 'UPDATE' and (new.converted_on is distinct from old.converted_on or new.transaction_id <> old.transaction_id)) then
    if new.converted_on < t.occurred_on then
      raise exception 'installment_invalid: a purchase is converted on or after its date';
    end if;
  end if;
  new.account_id := t.account_id;
  return new;
end $$;
