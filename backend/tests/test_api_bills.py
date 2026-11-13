"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
import uuid

from api_helpers import (
    _account,
    _book,
    _expense,
    auth,
    new_book_with_accounts,
    signed_up,
)
from sqlalchemy import text


def test_bill_dates():
    """The statement day's own transactions belong to its statement; a month without that day uses its
    last; a card is due on the first repayment day after the statement date, a loan on its next payment day."""
    from datetime import date as d

    from app.domain.bills import first_after, last_statement, next_on_or_after
    assert last_statement(d(2026, 10, 20), 25) == d(2026, 9, 25)
    assert last_statement(d(2026, 9, 25), 25) == d(2026, 8, 25)            # the statement day itself is still open
    assert last_statement(d(2026, 9, 26), 25) == d(2026, 9, 25)
    assert last_statement(d(2027, 3, 10), 31) == d(2027, 2, 28)            # February has no 31st
    assert last_statement(d(2027, 1, 5), 25) == d(2026, 12, 25)
    assert first_after(d(2026, 9, 25), 10) == d(2026, 10, 10) and first_after(d(2026, 9, 5), 25) == d(2026, 9, 25)
    assert first_after(d(2026, 12, 25), 10) == d(2027, 1, 10)
    assert next_on_or_after(d(2026, 10, 15), 15) == d(2026, 10, 15) and next_on_or_after(d(2026, 10, 16), 15) == d(2026, 11, 15)


def test_monthly_bills(client, database):
    """A credit card's bill is its statement balance minus the money in since; a loan's is its
    installment, with a one-off fee on the first payment and the interest part recorded as an expense."""
    from datetime import date as d
    from types import SimpleNamespace

    from sqlalchemy.orm import Session

    from app.domain.bills import bill_for, fee_transaction_id, interest_transaction_id
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}"

    def account(kind, opening, opened_on="2026-08-01", **details):
        r = client.post(f"{base}/accounts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": f"{kind} {uuid.uuid4().hex[:6]}",
                        "kind": kind, "opening_balance": opening, "opened_on": opened_on, **details})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    def txn(type_, day, *entries, txn_id=None):
        r = client.post(f"{base}/transactions", headers=auth(u), json={"id": str(txn_id or uuid.uuid4()), "type": type_,
                        "occurred_on": day, "entries": [{"account_id": a, "amount": m} for a, m in entries]})
        assert r.status_code == 201, r.text

    def bill(account_id, today):
        a = SimpleNamespace(**next(x for x in client.get(f"{base}/accounts", headers=auth(u)).json() if x["id"] == account_id))
        a.id = uuid.UUID(a.id)
        with Session(database) as s:
            return bill_for(s, a, today)

    # A card owing 1,000,000 from before, statement on the 25th, due on the 10th.
    card = account("credit_card", -1_000_000, statement_day=25, payment_due_day=10, credit_limit=10_000_000)
    txn("expense", "2026-09-05", (card, -300_000))
    txn("expense", "2026-09-25", (card, -200_000))                      # on the statement day: in that statement
    txn("expense", "2026-09-26", (card, -50_000))                       # the next statement's
    txn("refund", "2026-09-30", (card, 20_000))
    txn("transfer", "2026-10-05", (accts["Bank"], -400_000), (card, 400_000))
    b = bill(card, d(2026, 10, 20))
    assert (b.kind, b.period_start, b.period_end, b.due_on) == ("card", d(2026, 8, 26), d(2026, 9, 25), d(2026, 10, 10))
    assert (b.amount, b.paid, b.remaining, b.owed_now) == (1_500_000, 420_000, 1_080_000, 1_130_000)
    assert b.pay_from == uuid.UUID(accts["Bank"])
    txn("transfer", "2026-10-09", (accts["Bank"], -1_080_000), (card, 1_080_000))
    b = bill(card, d(2026, 10, 20))                                     # paid: the next statement so far
    assert (b.statement_open, b.period_end, b.amount, b.remaining) == (True, d(2026, 10, 25), 50_000, 50_000)
    assert bill(card, d(2026, 9, 25)).period_end == d(2026, 9, 25)      # the statement day itself is still open

    # A 0 % installment contract: 12,000,000 over 12 months, a 240,000 fee with the first payment.
    phone = account("loan", -12_000_000, "2026-10-01", installment=1_000_000, payment_due_day=15, installment_fee=240_000)
    b = bill(phone, d(2026, 10, 20))
    assert (b.kind, b.due_on, b.amount, b.fee, b.interest, b.paid, b.remaining) == ("loan", d(2026, 11, 15), 1_240_000,
                                                                                   240_000, 0, 0, 1_240_000)
    assert b.fee_transaction_id == fee_transaction_id(uuid.UUID(phone))
    txn("expense", "2026-10-20", (phone, -240_000), txn_id=b.fee_transaction_id)                # what Pay records
    txn("transfer", "2026-10-20", (accts["Bank"], -1_240_000), (phone, 1_240_000))
    b = bill(phone, d(2026, 10, 20))
    assert (b.amount, b.fee, b.remaining, b.owed_now) == (1_000_000, 0, 0, 11_000_000)     # the fee once; down by 1,000,000
    assert bill(phone, d(2026, 11, 16)).remaining == 1_000_000          # the next month's, without the fee

    # 12 % a year: the month's interest is the part of the installment recorded as an expense.
    car = account("loan", -10_000_000, "2026-10-01", installment=500_000, payment_due_day=15, interest_rate_bp=1_200)
    b = bill(car, d(2026, 10, 20))
    assert (b.amount, b.interest, b.fee, b.remaining) == (500_000, 100_000, 0, 500_000)
    assert b.interest_transaction_id == interest_transaction_id(uuid.UUID(car), d(2026, 11, 15))
    txn("expense", "2026-10-20", (car, -100_000), txn_id=b.interest_transaction_id)
    txn("transfer", "2026-10-20", (accts["Bank"], -200_000), (car, 200_000))                  # paid in two parts
    b = bill(car, d(2026, 10, 20))
    assert (b.amount, b.interest, b.remaining) == (500_000, 0, 300_000)                       # the interest once a month
    txn("transfer", "2026-10-21", (accts["Bank"], -300_000), (car, 300_000))
    b = bill(car, d(2026, 10, 21))
    assert (b.amount, b.remaining, b.owed_now) == (500_000, 0, 9_600_000)                      # principal 400,000

    # The last installment is what's left.
    last = account("loan", -300_000, "2026-10-01", installment=500_000, payment_due_day=15)
    assert (bill(last, d(2026, 10, 20)).amount, bill(last, d(2026, 10, 20)).remaining) == (300_000, 300_000)

    # The API: today's bill; none for other kinds or without what a bill needs; not someone else's.
    assert client.get(f"{base}/accounts/{card}/bill", headers=auth(u)).json()["kind"] == "card"
    assert client.get(f"{base}/accounts/{accts['Cash']}/bill", headers=auth(u)).json() is None
    no_days = account("credit_card", 0)
    assert client.get(f"{base}/accounts/{no_days}/bill", headers=auth(u)).json() is None
    assert client.get(f"{base}/accounts/{card}/bill", headers=auth(signed_up(client))).status_code == 404

    # Loan details: only on loans, an installment above 0; a card can't have them.
    for kind, details in (("credit_card", {"installment": 1}), ("cash", {"installment_fee": 1}), ("loan", {"installment": 0}),
                          ("cash", {"payment_due_day": 5})):
        r = client.post(f"{base}/accounts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": uuid.uuid4().hex[:8],
                        "kind": kind, **details})
        assert r.status_code == 422, (kind, details)


def test_open_statement(client, database):
    """R-ACC-9: a card shows last month's statement while it has something to pay, then the next statement so far,
    with only what's new in it: spending up to its date and the installments and fees it will bill, less any
    payment beyond last month's statement. Once last month's is paid off, or had nothing to pay, only the open one
    shows; when that one closes unpaid, it's the one due."""
    from datetime import date as d
    from types import SimpleNamespace

    from sqlalchemy.orm import Session

    from app.domain.bills import bill_for, bills_for
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}"

    def account(**details):
        r = client.post(f"{base}/accounts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": uuid.uuid4().hex[:8],
                        "kind": "credit_card", "opening_balance": 0, "opened_on": "2026-08-01", "statement_day": 1,
                        "payment_due_day": 15, **details})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    def txn(type_, day, *entries, payee=None):
        txn_id = str(uuid.uuid4())
        r = client.post(f"{base}/transactions", headers=auth(u), json={"id": txn_id, "type": type_, "occurred_on": day,
                        "payee": payee, "entries": [{"account_id": a, "amount": m} for a, m in entries]})
        assert r.status_code == 201, r.text
        return txn_id

    def bills(account_id, today, one=False):
        a = SimpleNamespace(**next(x for x in client.get(f"{base}/accounts", headers=auth(u)).json() if x["id"] == account_id))
        a.id = uuid.UUID(a.id)
        with Session(database) as s:
            return bill_for(s, a, today) if one else bills_for(s, a, today)

    def summary(b):
        return (b.statement_open, b.period_start, b.period_end, b.due_on, b.amount, b.remaining)

    # Statements on the 1st, due on the 15th. September's 300,000 isn't paid yet; in October, a laptop in six
    # installments with a 60,000 fee split into them, and a coffee.
    card = account(credit_limit=10_000_000)
    txn("expense", "2026-09-20", (card, -300_000))
    laptop = txn("expense", "2026-10-05", (card, -4_390_793), payee="Laptop")
    txn("expense", "2026-10-21", (card, -120_000))
    r = client.post(f"{base}/installments", headers=auth(u), json={"id": str(uuid.uuid4()), "transaction_id": laptop,
                    "months": 6, "fee": 60_000, "fee_split": True})
    assert r.status_code == 201 and r.json()["first_statement"] == "2026-11-01"
    due, upcoming = bills(card, d(2026, 10, 22))
    assert summary(due) == (False, d(2026, 9, 2), d(2026, 10, 1), d(2026, 10, 15), 300_000, 300_000)
    assert summary(upcoming) == (True, d(2026, 10, 2), d(2026, 11, 1), d(2026, 11, 15), 861_798, 861_798)
    assert [(i["number"], i["amount"]) for i in upcoming.installments] == [(1, 731_798)]
    assert ([f["amount"] for f in upcoming.fees], upcoming.fee, upcoming.paid) == ([10_000], 10_000, 0)
    assert not bills(card, d(2026, 10, 22), one=True).statement_open           # the one due comes first

    # Paid off: only the open statement. Paying more brings it down.
    txn("transfer", "2026-10-10", (accts["Bank"], -300_000), (card, 300_000))
    [only] = bills(card, d(2026, 10, 22))
    assert summary(only) == (True, d(2026, 10, 2), d(2026, 11, 1), d(2026, 11, 15), 861_798, 861_798)
    assert only.owed_now == 4_510_793
    txn("transfer", "2026-10-22", (accts["Bank"], -100_000), (card, 100_000))
    assert [b.amount for b in bills(card, d(2026, 10, 22))] == [761_798]

    # Nothing on the last statement: the open one only. Once it closes unpaid, it's due, and the next has nothing yet.
    fresh = account()
    txn("expense", "2026-10-21", (fresh, -50_000))
    assert [summary(b) for b in bills(fresh, d(2026, 10, 22))] == [(True, d(2026, 10, 2), d(2026, 11, 1), d(2026, 11, 15), 50_000, 50_000)]
    assert [(b.statement_open, b.amount) for b in bills(fresh, d(2026, 11, 2))] == [(False, 50_000), (True, 0)]

    # The API: the list, and the one due on its own.
    r = client.get(f"{base}/accounts/{card}/bills", headers=auth(u))
    from datetime import datetime
    from datetime import timezone as tz
    today = datetime.now(tz.utc).date()                      # the book's timezone is UTC; the API reads the real day
    assert r.status_code == 200 and [b["statement_open"] for b in r.json()] == [b.statement_open for b in bills(card, today)]
    assert client.get(f"{base}/accounts/{accts['Cash']}/bills", headers=auth(u)).json() == []
    assert client.get(f"{base}/accounts/{card}/bills", headers=auth(signed_up(client))).status_code == 404


def test_a_card_purchase_billed_on_the_next_statement(client, database):
    """R-ACC-10: a card purchase can be billed on the next statement (the bank posted it after the statement closed):
    it leaves the statement its date falls in and is on the one after; the card's balance doesn't change; only an
    expense on a card with a statement day takes it, within a month of its date; a purchase paid in installments is
    billed by its plan; the edit history keeps it and a restored purchase gets it back."""
    from datetime import date as d
    from types import SimpleNamespace

    from sqlalchemy.orm import Session

    from app.domain.bills import bills_for
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}"
    r = client.post(f"{base}/accounts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Card", "kind": "credit_card",
                    "opening_balance": 0, "opened_on": "2026-08-01", "statement_day": 1, "payment_due_day": 15})
    assert r.status_code == 201, r.text
    card = r.json()["id"]

    def txn(type_, day, account, amount, **more):
        return client.post(f"{base}/transactions", headers=auth(u), json={
            "id": str(uuid.uuid4()), "type": type_, "occurred_on": day, "entries": [{"account_id": account, "amount": amount}], **more})

    def bills(today):
        a = SimpleNamespace(**next(x for x in client.get(f"{base}/accounts", headers=auth(u)).json() if x["id"] == card))
        a.id = uuid.UUID(a.id)
        with Session(database) as s:
            return [(b.statement_open, b.period_end, b.amount, b.owed_now) for b in bills_for(s, a, today)]

    assert txn("expense", "2026-10-20", card, -100_000).status_code == 201
    late = txn("expense", "2026-10-31", card, -40_000, posted_on="2026-11-02")
    assert late.status_code == 201 and late.json()["posted_on"] == "2026-11-02"
    late = late.json()
    # The statement closing 1 Nov leaves the late purchase to the next one; what the card owes counts it all along.
    assert bills(d(2026, 10, 31)) == [(True, d(2026, 11, 1), 100_000, 140_000)]
    assert bills(d(2026, 11, 5)) == [(False, d(2026, 11, 1), 100_000, 140_000), (True, d(2026, 12, 1), 40_000, 140_000)]

    def put(**change):
        body = {"type": "expense", "occurred_on": "2026-10-31", "entries": [{"account_id": card, "amount": -40_000}],
                "version": client.get(f"{base}/transactions/{late['id']}", headers=auth(u)).json()["version"], **change}
        return client.put(f"{base}/transactions/{late['id']}", headers=auth(u), json=body)

    # Unticked, it's back on the statement of its date; ticked again, it moves again.
    assert put().json()["posted_on"] is None
    assert bills(d(2026, 11, 5)) == [(False, d(2026, 11, 1), 140_000, 140_000), (True, d(2026, 12, 1), 0, 140_000)]
    assert put(posted_on="2026-11-02").json()["posted_on"] == "2026-11-02"
    history = client.get(f"{base}/transactions/{late['id']}/history", headers=auth(u)).json()
    assert [h.get("posted_on") for h in history] == ["2026-11-02", None, "2026-11-02"]

    # Refused: on or before its date, more than a month later, not an expense, not on a card with a statement day.
    for bad in (put(posted_on="2026-10-31"), put(posted_on="2026-10-30"), put(posted_on="2026-12-02"),
                txn("refund", "2026-10-31", card, 40_000, posted_on="2026-11-02"),
                txn("expense", "2026-10-31", accts["Cash"], -40_000, posted_on="2026-11-02")):
        assert (bad.status_code, bad.json()) == (422, {"detail": "invalid"}), bad.text

    # Paid in installments, the plan says which statements bill it.
    r = client.post(f"{base}/installments", headers=auth(u), json={"id": str(uuid.uuid4()), "transaction_id": late["id"], "months": 2})
    assert r.status_code == 201 and r.json()["first_statement"] == "2026-11-01"
    assert bills(d(2026, 11, 5)) == [(False, d(2026, 11, 1), 120_000, 140_000), (True, d(2026, 12, 1), 20_000, 140_000)]
    client.delete(f"{base}/installments/{r.json()['id']}?version={r.json()['version']}", headers=auth(u))
    assert bills(d(2026, 11, 5))[0][2] == 100_000

    # Deleted and restored, it's still on the next statement.
    version = client.get(f"{base}/transactions/{late['id']}", headers=auth(u)).json()["version"]
    assert client.delete(f"{base}/transactions/{late['id']}?version={version}", headers=auth(u)).status_code == 204
    assert client.post(f"{base}/transactions/{late['id']}/restore", headers=auth(u)).status_code == 200
    assert client.get(f"{base}/transactions/{late['id']}", headers=auth(u)).json()["posted_on"] == "2026-11-02"

    import csv
    import io
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(u)).content))
    rows = list(csv.DictReader(io.StringIO(z.read("transactions.csv").decode("utf-8-sig"))))
    assert sorted((r["Date"], r["Billed from"]) for r in rows if r["Account"] == "Card") == [("2026-10-20", ""), ("2026-10-31", "2026-11-02")]
    edits = list(csv.DictReader(io.StringIO(z.read("edit_history.csv").decode("utf-8-sig"))))
    assert [r["Billed from"] for r in edits if r["Transaction date"] == "2026-10-31" and r["Action"] != "deleted"] == [
        "2026-11-02", "", "2026-11-02", "2026-11-02"]


def test_installment_plans(client, database):
    """R-ACC-8: a card purchase paid in installments stays one expense for its full amount; each statement bills one
    installment per plan, the fee at once or split into the installments, nothing charged twice; ending early bills
    the rest; the unbilled part counts toward the limit unless the plan says otherwise."""
    from datetime import date as d
    from types import SimpleNamespace

    from sqlalchemy.orm import Session

    from app.domain.bills import bill_for, installment_plans
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}"

    def account(kind, **details):
        r = client.post(f"{base}/accounts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": f"{kind} {uuid.uuid4().hex[:6]}",
                        "kind": kind, "opening_balance": 0, "opened_on": "2026-08-01", **details})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    def txn(type_, day, *entries, txn_id=None, payee=None):
        txn_id = str(txn_id or uuid.uuid4())
        r = client.post(f"{base}/transactions", headers=auth(u), json={"id": txn_id, "type": type_, "occurred_on": day,
                        "payee": payee, "entries": [{"account_id": a, "amount": m} for a, m in entries]})
        assert r.status_code == 201, r.text
        return txn_id

    def plan(transaction_id, as_user=None, **fields):
        return client.post(f"{base}/installments", headers=auth(as_user or u),
                           json={"id": str(uuid.uuid4()), "transaction_id": transaction_id, **fields})

    def bill(account_id, today):
        a = SimpleNamespace(**next(x for x in client.get(f"{base}/accounts", headers=auth(u)).json() if x["id"] == account_id))
        a.id = uuid.UUID(a.id)
        with Session(database) as s:
            return bill_for(s, a, today)

    # A card with its statement on the 25th, due on the 10th; a laptop for 6,000,000 over 6 months, a 120,000 fee.
    card = account("credit_card", statement_day=25, payment_due_day=10, credit_limit=20_000_000)
    laptop = txn("expense", "2026-09-10", (card, -6_000_000), payee="Laptop")
    txn("expense", "2026-09-15", (card, -300_000))
    r = plan(laptop, months=6, fee=120_000)
    assert r.status_code == 201, r.text
    p = r.json()
    assert (p["account_id"], p["months"], p["converted_on"], p["first_statement"], p["fee"], p["fee_split"]) == (
        card, 6, "2026-09-10", "2026-09-25", 120_000, False)
    assert (p["counts_toward_limit"], p["ended_on"], p["installment"], p["version"]) == (True, None, 1_000_000, 1)
    r = plan(laptop, months=3)
    assert (r.status_code, r.json()) == (409, {"detail": "installment_exists"})       # one plan per purchase

    # The September statement: 300,000 plus the first installment, and the whole fee.
    b = bill(card, d(2026, 10, 1))
    assert (b.amount, b.fee) == (1_420_000, 120_000)
    assert [(i["number"], i["months"], i["amount"]) for i in b.installments] == [(1, 6, 1_000_000)]
    [fee] = b.fees
    assert fee["amount"] == 120_000
    txn("expense", "2026-10-02", (card, -120_000), txn_id=fee["transaction_id"])           # what Pay records
    txn("transfer", "2026-10-02", (accts["Bank"], -1_420_000), (card, 1_420_000))
    b = bill(card, d(2026, 10, 3))                                     # paid: October's statement so far
    assert (b.statement_open, b.amount, b.fee, b.fees) == (True, 1_000_000, 0, [])          # the fee once
    assert [i["number"] for i in b.installments] == [2]

    # October: the second installment only; the balance still says what's owed.
    b = bill(card, d(2026, 11, 1))
    assert (b.amount, b.owed_now) == (1_000_000, 5_000_000)
    assert [i["number"] for i in b.installments] == [2]
    assert b.limit_used == 5_000_000
    r = client.patch(f"{base}/installments/{p['id']}", headers=auth(u), json={"version": 1, "counts_toward_limit": False})
    assert r.status_code == 200 and r.json()["version"] == 2
    assert bill(card, d(2026, 11, 1)).limit_used == 1_000_000          # the 4,000,000 not billed yet doesn't count

    # A phone bought on the 30th, converted on 2 November: its first installment is on the November statement,
    # and its fee is split into the three.
    phone = txn("expense", "2026-10-30", (card, -3_000_000), payee="Phone")
    r = plan(phone, months=3, converted_on="2026-11-02", fee=100_000, fee_split=True)
    assert r.status_code == 201 and r.json()["first_statement"] == "2026-11-25"
    assert bill(card, d(2026, 11, 3)).amount == 1_000_000              # not on the October statement
    txn("transfer", "2026-11-05", (accts["Bank"], -1_000_000), (card, 1_000_000))
    b = bill(card, d(2026, 11, 26))
    assert b.amount == 2_033_333
    assert sorted((i["months"], i["number"], i["amount"]) for i in b.installments) == [(3, 1, 1_000_000), (6, 3, 1_000_000)]
    assert [f["amount"] for f in b.fees] == [33_333]

    # Paid off early: the rest is on the next statement.
    with Session(database) as s:
        lap = next(x for x in installment_plans(s, uuid.UUID(bid), d(2026, 11, 26)) if str(x["transaction_id"]) == laptop)
    assert (lap["billed"], lap["left_to_bill"]) == (3, 3_000_000)
    r = client.patch(f"{base}/installments/{lap['id']}", headers=auth(u), json={"version": lap["version"], "ended_on": "2026-11-28"})
    assert r.status_code == 200, r.text
    b = bill(card, d(2026, 12, 26))
    assert sorted((i["months"], i["number"], i["amount"]) for i in b.installments) == [(3, 2, 1_000_000), (6, 6, 3_000_000)]
    assert [f["amount"] for f in b.fees] == [33_333, 33_333]         # November's part was never recorded: it carries over

    # Editing the purchase's amount recalculates the plan; moving it off the card removes it.
    client.put(f"{base}/transactions/{phone}", headers=auth(u), json={"type": "expense", "occurred_on": "2026-10-30", "version": 1,
               "payee": "Phone", "entries": [{"account_id": card, "amount": -3_300_000}]})
    ph = next(x for x in client.get(f"{base}/installments", headers=auth(u)).json() if x["transaction_id"] == phone)
    assert ph["installment"] == 1_100_000
    r = client.put(f"{base}/transactions/{phone}", headers=auth(u), json={"type": "expense", "occurred_on": "2026-10-30", "version": 2,
                   "payee": "Phone", "entries": [{"account_id": accts["Cash"], "amount": -3_300_000}]})
    assert r.status_code == 200, r.text
    assert [x["transaction_id"] for x in client.get(f"{base}/installments", headers=auth(u)).json()] == [laptop]

    # Deleting the purchase deletes its plan.
    client.delete(f"{base}/transactions/{laptop}?version=1", headers=auth(u))
    assert client.get(f"{base}/installments", headers=auth(u)).json() == []

    # Only an expense on a credit card with a statement day, 2 to 60 months.
    cash_buy = txn("expense", "2026-10-01", (accts["Cash"], -500_000))
    no_day = account("credit_card")
    no_day_buy = txn("expense", "2026-10-01", (no_day, -500_000))
    refund = txn("refund", "2026-10-01", (card, 500_000))
    card_buy = txn("expense", "2026-10-01", (card, -500_000))
    for tid, fields in ((cash_buy, {"months": 3}), (no_day_buy, {"months": 3}), (refund, {"months": 3}),
                        (card_buy, {"months": 1}), (card_buy, {"months": 61}), (card_buy, {"months": 3, "fee": -1}),
                        (card_buy, {"months": 3, "converted_on": "2026-09-30"})):
        r = plan(tid, **fields)
        assert r.status_code == 422, (tid, fields, r.text)

    # Nobody else sees it; a viewer can't add one.
    assert client.get(f"{base}/installments", headers=auth(signed_up(client))).status_code == 404
    viewer_name = f"v_{uuid.uuid4().hex[:8]}"
    viewer = signed_up(client, viewer_name)
    client.post(f"{base}/members", headers=auth(u), json={"username": viewer_name, "role": "viewer"})
    client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(viewer))
    assert plan(card_buy, as_user=viewer, months=3).status_code == 403

    # The export lists them.
    assert plan(card_buy, months=3).status_code == 201
    import io
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(u)).content))
    rows = z.read("installments.csv").decode("utf-8-sig").splitlines()
    assert rows[0].startswith("Book,Card,Purchase,Date,Amount,Months") and len(rows) == 2


def test_a_card_with_installments_keeps_its_statement_day(client, database):
    """A card's plans bill on its statements: losing the statement day is refused while it has plans, and the plans
    of a card that lost it anyway are left out instead of failing every installments call."""
    u = signed_up(client)
    bid = _book(client, u)
    card = _account(client, u, bid, "credit_card", statement_day=20, payment_due_day=5, credit_limit=50_000_000)
    laptop = _expense(client, u, bid, card, 12_000_000)
    assert client.post(f"/v1/books/{bid}/installments", headers=auth(u),
                       json={"id": str(uuid.uuid4()), "transaction_id": laptop["id"], "months": 6}).status_code == 201
    for change in ({"statement_day": None}, {"kind": "loan"}):
        r = client.patch(f"/v1/books/{bid}/accounts/{card}", headers=auth(u), json={"version": 1, **change})
        assert (r.status_code, r.json()) == (409, {"detail": "card_has_installments"})
    with database.connect() as c:                       # a card that lost it before this check existed
        c.execute(text("update accounts set statement_day = null where id = :a"), {"a": card})
    assert client.get(f"/v1/books/{bid}/installments", headers=auth(u)).status_code == 200


def test_monthly_interest_rounds_half_up_in_whole_units():
    from app.domain.bills import monthly_interest
    assert monthly_interest(60_000, 1) == 1                         # 0.5 rounds up
    assert monthly_interest(10_000_000, 1_200) == 100_000
    assert monthly_interest(9_007_199_254_740_993, 1_200) == 90_071_992_547_410   # exact past 2**53
