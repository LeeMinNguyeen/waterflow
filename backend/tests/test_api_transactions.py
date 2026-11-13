"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
import threading
import time
import uuid

from api_helpers import (
    _account,
    _book,
    _expense,
    add_category,
    auth,
    new_book_with_accounts,
    signed_up,
)
from sqlalchemy import text


def test_a_deleted_transaction_comes_back(client, database):
    """R-TXN-11: a deleted transaction is listed for 30 days and comes back as it was, with its id and its card
    installment plan; the history reads created, edited, deleted, restored, with who."""
    owner = signed_up(client)
    names = {k: f"{k}_{uuid.uuid4().hex[:8]}" for k in ("editor", "viewer")}
    users = {k: signed_up(client, n) for k, n in names.items()}
    bid, accts = new_book_with_accounts(client, owner)
    base = f"/v1/books/{bid}/transactions"
    for k in ("editor", "viewer"):
        client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": names[k], "role": k})
        client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(users[k]))
    food = add_category(client, owner, bid, "Food")
    tid = str(uuid.uuid4())
    client.post(base, headers=auth(owner), json={"id": tid, "type": "expense", "occurred_on": "2026-10-05",
                                                "occurred_time": "08:30", "category_id": food["id"], "payee": "Phở",
                                                "note": "with Lan", "entries": [{"account_id": accts["Cash"], "amount": -50_000}]})
    saved = client.put(f"{base}/{tid}", headers=auth(owner), json={"version": 1, "type": "expense", "occurred_on": "2026-10-05",
                                                                  "category_id": food["id"], "payee": "Phở", "note": "with Lan",
                                                                  "entries": [{"account_id": accts["Cash"], "amount": -60_000}]}).json()
    assert saved["version"] == 2
    cash = lambda: next(a for a in client.get(f"/v1/books/{bid}/accounts", headers=auth(owner)).json() if a["id"] == accts["Cash"])["balance"]  # noqa: E731
    before = cash()

    assert client.delete(f"{base}/{tid}?version=2", headers=auth(owner)).status_code == 204
    assert cash() == before + 60_000
    gone = client.get(f"{base}/deleted", headers=auth(users["viewer"])).json()
    assert [(g["id"], g["payee"], g["category_id"], g["occurred_on"], g["deleted_by"]) for g in gone] == \
        [(tid, "Phở", food["id"], "2026-10-05", client.get("/v1/me", headers=auth(owner)).json()["profile"]["username"])]
    assert gone[0]["entries"] == [{"account_id": accts["Cash"], "amount": -60_000, "currency": "VND"}]

    assert client.post(f"{base}/{tid}/restore", headers=auth(users["viewer"])).status_code == 403
    back = client.post(f"{base}/{tid}/restore", headers=auth(users["editor"]))
    assert back.status_code == 200, back.text
    back = back.json()
    keep = ("id", "type", "occurred_on", "occurred_time", "category_id", "payee", "note", "entries", "created_at", "created_by")
    assert {k: back[k] for k in keep} == {k: saved[k] for k in keep}
    assert (back["version"], back["modified_by"]) == (3, names["editor"])
    assert cash() == before
    history = client.get(f"{base}/{tid}/history", headers=auth(owner)).json()
    assert [(h["version"], h["action"]) for h in history] == [(1, "created"), (2, "edited"), (2, "deleted"), (3, "restored")]
    assert history[-1]["changed_by"] == names["editor"]
    again = client.post(f"{base}/{tid}/restore", headers=auth(users["editor"]))
    assert (again.status_code, again.json()) == (409, {"detail": "already_restored"})
    assert client.get(f"{base}/deleted", headers=auth(owner)).json() == []

    assert client.delete(f"{base}/{tid}?version=3", headers=auth(owner)).status_code == 204
    with database.connect() as c:
        c.execute(text("update transaction_history set changed_at = now() - interval '31 days'"
                       " where transaction_id = :t and action = 'deleted'"), {"t": tid})
    old = client.post(f"{base}/{tid}/restore", headers=auth(owner))
    assert (old.status_code, old.json()) == (409, {"detail": "restore_expired"})
    assert client.get(f"{base}/deleted", headers=auth(owner)).json() == []
    stranger = signed_up(client)
    assert client.post(f"{base}/{tid}/restore", headers=auth(stranger)).json() == {"detail": "not_found"}
    assert client.get(f"{base}/deleted", headers=auth(stranger)).json() == {"detail": "not_found"}
    assert client.post(f"{base}/{uuid.uuid4()}/restore", headers=auth(owner)).json() == {"detail": "not_found"}

    # The same id reused in another book, edited past this one's version and deleted there, doesn't stand in for it.
    reused = str(uuid.uuid4())
    client.post(base, headers=auth(owner), json={"id": reused, "type": "expense", "occurred_on": "2026-10-06", "payee": "Mine",
                                                "entries": [{"account_id": accts["Cash"], "amount": -10_000}]})
    client.delete(f"{base}/{reused}?version=1", headers=auth(owner))
    other_bid, other_accts = new_book_with_accounts(client, stranger)
    other = f"/v1/books/{other_bid}/transactions"
    body = {"type": "expense", "occurred_on": "2026-10-06", "payee": "Theirs", "entries": [{"account_id": other_accts["Cash"], "amount": -5}]}
    assert client.post(other, headers=auth(stranger), json={"id": reused, **body}).status_code == 201
    for v in (1, 2):
        client.put(f"{other}/{reused}", headers=auth(stranger), json={"version": v, **body, "note": f"v{v + 1}"})
    client.delete(f"{other}/{reused}?version=3", headers=auth(stranger))
    assert [g["payee"] for g in client.get(f"{base}/deleted", headers=auth(owner)).json()] == ["Mine"]
    mine = client.post(f"{base}/{reused}/restore", headers=auth(owner))
    assert (mine.status_code, mine.json()["payee"]) == (200, "Mine"), mine.text

    card = str(uuid.uuid4())
    client.post(f"/v1/books/{bid}/accounts", headers=auth(owner), json={"id": card, "name": "Visa", "kind": "credit_card",
                                                                       "opened_on": "2026-08-01", "statement_day": 20})
    buy = str(uuid.uuid4())
    client.post(base, headers=auth(owner), json={"id": buy, "type": "expense", "occurred_on": "2026-10-01",
                                                "entries": [{"account_id": card, "amount": -3_000_000}]})
    plan = client.post(f"/v1/books/{bid}/installments", headers=auth(owner), json={"id": str(uuid.uuid4()), "transaction_id": buy, "months": 3})
    assert plan.status_code == 201, plan.text
    client.delete(f"{base}/{buy}?version=1", headers=auth(owner))
    assert client.get(f"/v1/books/{bid}/installments", headers=auth(owner)).json() == []
    assert client.post(f"{base}/{buy}/restore", headers=auth(owner)).status_code == 200
    plans = client.get(f"/v1/books/{bid}/installments", headers=auth(owner)).json()
    assert [(p["id"], p["months"]) for p in plans] == [(plan.json()["id"], 3)]
def test_transaction_filters_by_amount_and_no_category_with_a_summary(client, database):
    """R-TXN-10: amount from and to, in each entry's own currency (a transfer by what left); no category; the
    filtered list's count, spending, income and difference in the book's currency, missing rates counted."""
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/transactions"
    kwd = str(uuid.uuid4())
    client.post(f"/v1/books/{bid}/accounts", headers=auth(u), json={"id": kwd, "name": "Kuwait", "kind": "cash",
                                                                   "currency": "KWD", "opened_on": "2026-10-01"})
    usd = str(uuid.uuid4())
    client.post(f"/v1/books/{bid}/accounts", headers=auth(u), json={"id": usd, "name": "US bank", "kind": "checking",
                                                                   "currency": "USD", "opened_on": "2026-10-01"})
    food = add_category(client, u, bid, "Food")
    coffee = add_category(client, u, bid, "Coffee", parent=food["id"])
    salary = add_category(client, u, bid, "Salary", kind="income")
    gadgets = add_category(client, u, bid, "Gadgets")

    def add(type_, entries, category=None, payee=None):
        r = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "type": type_, "occurred_on": "2026-10-05",
                                                     "category_id": category, "payee": payee,
                                                     "entries": [{"account_id": a, "amount": m} for a, m in entries]})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    latte = add("expense", [(accts["Cash"], -50_000)], coffee["id"], "Latte")
    dinner = add("expense", [(accts["Bank"], -200_000)], food["id"], "Dinner")
    loose = add("expense", [(accts["Cash"], -30_000)], payee="Market")
    back = add("refund", [(accts["Cash"], 20_000)], coffee["id"], "Latte back")
    paid = add("income", [(accts["Bank"], 1_000_000)], payee="Side job")
    add("income", [(accts["Bank"], 9_000_000)], salary["id"], "Salary")
    moved = add("transfer", [(accts["Bank"], -500_000), (accts["Cash"], 500_000)])
    abroad = add("expense", [(kwd, -1_000)], payee="Kuwait shop")                  # 1.000 KWD
    espresso = add("expense", [(usd, -300)], gadgets["id"], "Espresso")            # $3.00
    laptop = add("expense", [(usd, -25_000)], gadgets["id"], "Laptop")              # $250.00
    dollars = add("transfer", [(accts["Bank"], -2_600_000), (usd, 10_000)])        # $100.00 in

    def ids(**params):
        return {i["id"] for i in client.get(base, headers=auth(u), params=params).json()["items"]}

    assert ids(min=40_000, max=600_000) == {latte, dinner, moved}
    assert ids(min=900_000, type="income") == {paid, *ids(category_id=salary["id"])}
    assert ids(max=1_000) == {abroad, espresso, laptop}                            # 1, 3 and 250 in their own currency
    assert ids(min=2, max=5) == {espresso}
    assert laptop not in ids(min=20_000, max=30_000)
    assert ids(account_id=usd, min=5_000, max=15_000) == {dollars}                # $50 to $150, on that account's side
    assert ids(category_id="none") == {loose, paid, abroad}
    assert ids(category_id="none", type="transfer") == {moved, dollars}
    assert ids(currency="USD") == {espresso, laptop}                               # a transfer by what left: VND
    assert ids(currency="USD,KWD") == {espresso, laptop, abroad}
    assert ids(currency="USD", min=200, max=500) == {espresso}                    # one currency: $2.00 to $5.00
    assert ids(currency="USD,VND", min=20_000, max=30_000) == {loose, back}       # several: read as the book's, ₫
    assert ids(account_id=usd, currency="VND") == set()                            # the account's own side: USD
    for bad in ("usd", "USD,", "US", ",".join(["USD"] * 21)):
        assert client.get(base, headers=auth(u), params={"currency": bad}).status_code == 422, bad
    assert client.get(base, headers=auth(u), params={"category_id": "nothing"}).status_code == 422
    assert client.get(base, headers=auth(u), params={"min": -1}).status_code == 422

    def summary(**params):
        r = client.get(f"{base}/summary", headers=auth(u), params=params)
        assert r.status_code == 200, r.text
        return r.json()

    assert summary(category_id="none") == {"count": 3, "spent": 30_000, "income": 1_000_000, "net": 970_000, "not_converted": 1}
    assert summary(category_id=food["id"]) == {"count": 3, "spent": 230_000, "income": 0, "net": -230_000, "not_converted": 0}
    assert summary(account_id=accts["Cash"], min=10_000, max=600_000) == {
        "count": 4, "spent": 60_000, "income": 0, "net": -60_000, "not_converted": 0}
    assert summary(q="latte") == {"count": 2, "spent": 30_000, "income": 0, "net": -30_000, "not_converted": 0}
    assert {back} <= ids(q="back")

    other = signed_up(client)
    assert client.get(f"{base}/summary", headers=auth(other)).json() == {"detail": "not_found"}


def test_a_restore_after_things_changed(client, database):
    """What changed since the delete: a category gone is left off; an account in another currency or gone is refused;
    a plan that no longer fits stays off; two restores at once, one wins."""
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/transactions"

    def add(account, amount, **fields):
        tid = str(uuid.uuid4())
        r = client.post(base, headers=auth(u), json={"id": tid, "type": "expense", "occurred_on": "2026-10-05",
                                                     "entries": [{"account_id": account, "amount": amount}], **fields})
        assert r.status_code == 201, r.text
        client.delete(f"{base}/{tid}?version=1", headers=auth(u))
        return tid

    def account(**fields):
        aid = str(uuid.uuid4())
        assert client.post(f"/v1/books/{bid}/accounts", headers=auth(u),
                           json={"id": aid, "name": f"A {aid[:6]}", "opened_on": "2026-08-01", **fields}).status_code == 201
        return aid

    snacks = add_category(client, u, bid, "Snacks")
    snack = add(accts["Cash"], -20_000, category_id=snacks["id"])
    client.delete(f"/v1/books/{bid}/categories/{snacks['id']}?version=1", headers=auth(u))
    back = client.post(f"{base}/{snack}/restore", headers=auth(u))
    assert (back.status_code, back.json()["category_id"]) == (200, None), back.text

    usd = account(kind="checking", currency="USD")
    dollars = add(usd, -500)
    v = next(a for a in client.get(f"/v1/books/{bid}/accounts", headers=auth(u)).json() if a["id"] == usd)["version"]
    assert client.patch(f"/v1/books/{bid}/accounts/{usd}", headers=auth(u), json={"version": v, "currency": "VND"}).status_code == 200
    changed = client.post(f"{base}/{dollars}/restore", headers=auth(u))
    assert (changed.status_code, changed.json()) == (409, {"detail": "restore_changed"})

    card = account(kind="credit_card", statement_day=20)
    buy = str(uuid.uuid4())
    client.post(base, headers=auth(u), json={"id": buy, "type": "expense", "occurred_on": "2026-10-01",
                                             "entries": [{"account_id": card, "amount": -3_000_000}]})
    client.post(f"/v1/books/{bid}/installments", headers=auth(u), json={"id": str(uuid.uuid4()), "transaction_id": buy, "months": 3})
    client.delete(f"{base}/{buy}?version=1", headers=auth(u))
    v = next(a for a in client.get(f"/v1/books/{bid}/accounts", headers=auth(u)).json() if a["id"] == card)["version"]
    assert client.patch(f"/v1/books/{bid}/accounts/{card}", headers=auth(u), json={"version": v, "kind": "checking"}).status_code == 200
    assert client.post(f"{base}/{buy}/restore", headers=auth(u)).status_code == 200
    assert client.get(f"/v1/books/{bid}/installments", headers=auth(u)).json() == []

    card2 = account(kind="credit_card", statement_day=20)
    moved = str(uuid.uuid4())
    client.post(base, headers=auth(u), json={"id": moved, "type": "expense", "occurred_on": "2026-10-01",
                                             "entries": [{"account_id": card2, "amount": -3_000_000}]})
    plan = client.post(f"/v1/books/{bid}/installments", headers=auth(u), json={"id": str(uuid.uuid4()), "transaction_id": moved, "months": 3}).json()
    client.put(f"{base}/{moved}", headers=auth(u), json={"version": 1, "type": "expense", "occurred_on": "2026-10-05",
                                                         "entries": [{"account_id": card2, "amount": -3_000_000}]})
    client.delete(f"{base}/{moved}?version=2", headers=auth(u))
    assert client.post(f"{base}/{moved}/restore", headers=auth(u)).status_code == 200
    plans = client.get(f"/v1/books/{bid}/installments", headers=auth(u)).json()
    assert [(p["id"], p["converted_on"]) for p in plans] == [(plan["id"], plan["converted_on"])]   # kept though the purchase moved later

    lunch = add(accts["Cash"], -50_000)
    result = {}

    def restore():
        result["r"] = client.post(f"{base}/{lunch}/restore", headers=auth(u))

    with database.connect() as other:                 # another restore of it, not committed yet
        other.exec_driver_sql("begin")
        other.execute(text("select set_config('app.user_id', :u, true)"), {"u": str(u)})
        other.execute(text("select restore_transaction(:b, :t)"), {"b": bid, "t": lunch})
        second = threading.Thread(target=restore)
        second.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and "r" not in result and not other.execute(text(
                "select count(*) from pg_locks where locktype = 'transactionid' and not granted")).scalar():
            time.sleep(0.05)
        other.exec_driver_sql("commit")
        second.join(10)
    assert (result["r"].status_code, result["r"].json()) == (409, {"detail": "already_restored"})


def test_transactions_and_two_browsers(client):
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/transactions"
    food = add_category(client, u, bid, "Food")
    lunch = add_category(client, u, bid, "Lunch", parent=food["id"])
    move = add_category(client, u, bid, "Move", kind="transfer")

    tid = str(uuid.uuid4())
    expense = {"id": tid, "type": "expense", "occurred_on": "2026-10-03", "category_id": lunch["id"], "payee": "Phở 24",
               "note": "with Tom", "entries": [{"account_id": accts["Cash"], "amount": -65_000}]}
    r = client.post(base, headers=auth(u), json=expense)
    assert r.status_code == 201
    assert (r.json()["version"], r.json()["entries"][0]["currency"], r.json()["created_by"]) == (1, "VND", r.json()["modified_by"])
    assert client.post(base, headers=auth(u), json=expense).json()["version"] == 1          # retry: saved once
    client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "type": "transfer", "occurred_on": "2026-10-04",
                                             "category_id": move["id"], "entries": [
                                                 {"account_id": accts["Bank"], "amount": -2_000_000},
                                                 {"account_id": accts["Cash"], "amount": 2_000_000}]})
    client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "type": "income", "occurred_on": "2026-10-05",
                                             "payee": "Salary", "entries": [{"account_id": accts["Bank"], "amount": 20_000_000}]})

    # A shape error is found at commit: it must come back as an error, not 201.
    bad = client.post(base, headers=auth(u), json={**expense, "id": str(uuid.uuid4()),
                                                   "entries": [{"account_id": accts["Cash"], "amount": 65_000}]})
    assert (bad.status_code, bad.json()) == (422, {"detail": "txn_shape"})
    wrong_kind = client.post(base, headers=auth(u), json={**expense, "id": str(uuid.uuid4()), "category_id": move["id"]})
    assert wrong_kind.json() == {"detail": "category_kind"}

    def listed(**params):
        return client.get(base, headers=auth(u), params=params).json()

    assert [t["type"] for t in listed()["items"]] == ["income", "transfer", "expense", "opening_balance", "opening_balance"]
    cash = listed(account_id=accts["Cash"])["items"]
    assert [(t["type"], t["running_balance"]) for t in cash] == [("transfer", 2_935_000), ("expense", 935_000),
                                                                 ("opening_balance", 1_000_000)]
    assert [t["payee"] for t in listed(category_id=food["id"])["items"]] == ["Phở 24"]          # includes Lunch
    assert [t["type"] for t in listed(**{"from": "2026-10-04", "to": "2026-10-04"})["items"]] == ["transfer"]
    assert [t["type"] for t in listed(type="income")["items"]] == ["income"]
    assert [t["payee"] for t in listed(q="TOM")["items"]] == ["Phở 24"]                        # note, any case
    page1 = listed(limit=2)
    page2 = listed(limit=2, after=page1["next"])
    page3 = listed(limit=2, after=page2["next"])
    assert [t["id"] for t in page1["items"] + page2["items"] + page3["items"]] == [t["id"] for t in listed()["items"]]
    assert page3["next"] is None

    # Two browsers loaded version 1. The first save wins; the second gets 409 and changes nothing.
    edit = {k: v for k, v in expense.items() if k != "id"}
    first = client.put(f"{base}/{tid}", headers=auth(u), json={**edit, "version": 1, "payee": "Phở Hà Nội",
                                                                "entries": [{"account_id": accts["Cash"], "amount": -70_000}]})
    assert (first.status_code, first.json()["version"]) == (200, 2)
    second = client.put(f"{base}/{tid}", headers=auth(u), json={**edit, "version": 1, "note": "from the other tab"})
    assert (second.status_code, second.json()) == (409, {"detail": "conflict"})
    now = client.get(f"{base}/{tid}", headers=auth(u)).json()
    assert (now["payee"], now["note"], now["entries"][0]["amount"]) == ("Phở Hà Nội", "with Tom", -70_000)
    assert client.delete(f"{base}/{tid}?version=1", headers=auth(u)).json() == {"detail": "conflict"}
    assert client.delete(f"{base}/{tid}?version=2", headers=auth(u)).status_code == 204
    assert client.get(f"{base}/{tid}", headers=auth(u)).status_code == 404

    hist = client.get(f"{base}/{tid}/history", headers=auth(u)).json()
    assert [(h["action"], h["version"]) for h in hist] == [("created", 1), ("edited", 2), ("deleted", 2)]
    assert (hist[0]["payee"], hist[0]["entries"][0]["amount"]) == ("Phở 24", -65_000)
    assert (hist[1]["payee"], hist[1]["entries"][0]["amount"]) == ("Phở Hà Nội", -70_000)
    assert hist[0]["changed_by"] == now["created_by"] and hist[2]["entries"] is None

    stranger = signed_up(client)
    assert client.get(base, headers=auth(stranger)).json() == {"detail": "not_found"}
    assert client.get(f"{base}/{tid}/history", headers=auth(stranger)).json() == {"detail": "not_found"}


def test_edits_to_amounts_or_accounts_alone_are_versions(client, database):
    """Changing only an amount or an account is an edit like any other: a new version (so a
    second browser still gets 409) and its own line in the history. Saving with nothing changed is neither,
    and leaves the entries alone (no rows in the audit log for them)."""
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/transactions"
    tid = str(uuid.uuid4())
    body = {"type": "expense", "occurred_on": "2026-10-03", "payee": "Lẩu", "entries": [{"account_id": accts["Cash"], "amount": -45_000}]}
    assert client.post(base, headers=auth(u), json={**body, "id": tid}).status_code == 201

    def put(version, **changes):
        return client.put(f"{base}/{tid}", headers=auth(u), json={**body, **changes, "version": version})

    amount = put(1, entries=[{"account_id": accts["Cash"], "amount": -65_000}])
    assert (amount.status_code, amount.json()["version"]) == (200, 2)
    stale = put(1, entries=[{"account_id": accts["Cash"], "amount": -50_000}])        # the other browser
    assert (stale.status_code, stale.json()) == (409, {"detail": "conflict"})
    moved = put(2, entries=[{"account_id": accts["Bank"], "amount": -65_000}])
    assert (moved.status_code, moved.json()["version"]) == (200, 3)
    def entry_writes():
        with database.connect() as c:
            return c.execute(text("select count(*) from audit_log where table_name = 'entries'"
                                  " and coalesce(new_row, old_row)->>'transaction_id' = :t"), {"t": tid}).scalar()
    writes = entry_writes()
    same = put(3, entries=[{"account_id": accts["Bank"], "amount": -65_000}])
    assert (same.status_code, same.json()["version"]) == (200, 3)
    assert entry_writes() == writes

    hist = client.get(f"{base}/{tid}/history", headers=auth(u)).json()
    assert [(h["action"], h["version"]) for h in hist] == [("created", 1), ("edited", 2), ("edited", 3)]
    assert [(h["entries"][0]["account_id"], h["entries"][0]["amount"]) for h in hist] == [
        (accts["Cash"], -45_000), (accts["Cash"], -65_000), (accts["Bank"], -65_000)]
    listed = lambda acc: [t["id"] for t in client.get(base, headers=auth(u), params={"account_id": acc}).json()["items"]]
    assert tid not in listed(accts["Cash"]) and tid in listed(accts["Bank"])


def test_amounts_past_a_trillion_are_refused(client):
    """Past 10**15 minor units, sums would overflow the balance and conversion views for the whole book."""
    u = signed_up(client)
    bid = _book(client, u)
    cash = _account(client, u, bid)
    huge = 10**16
    r = client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
        "id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-10-01", "entries": [{"account_id": cash, "amount": -huge}]})
    assert (r.status_code, r.json()) == (422, {"detail": "invalid"})
    r = client.post(f"/v1/books/{bid}/accounts", headers=auth(u), json={
        "id": str(uuid.uuid4()), "name": "Big", "kind": "cash", "opening_balance": huge})
    assert r.status_code == 422
    food = add_category(client, u, bid, "Food")["id"]
    r = client.post(f"/v1/books/{bid}/budgets", headers=auth(u), json={
        "id": str(uuid.uuid4()), "category_id": food, "period": "monthly", "amount": huge})
    assert r.status_code == 422


def test_a_transaction_changes_only_in_its_own_book(client):
    """Like every write, an edit or delete through another book's path changes nothing."""
    u = signed_up(client)
    a, b = _book(client, u), _book(client, u)
    cash_b = _account(client, u, b)
    t = _expense(client, u, b, cash_b, 1000, payee="Lunch")
    r = client.put(f"/v1/books/{a}/transactions/{t['id']}", headers=auth(u), json={
        "version": t["version"], "type": "expense", "occurred_on": t["occurred_on"], "payee": "Moved",
        "entries": [{"account_id": cash_b, "amount": -1000}]})
    assert r.status_code == 404
    assert client.delete(f"/v1/books/{a}/transactions/{t['id']}?version={t['version']}", headers=auth(u)).status_code == 404
    assert client.get(f"/v1/books/{b}/transactions/{t['id']}", headers=auth(u)).json()["payee"] == "Lunch"


def test_an_amount_saved_past_the_bound_can_still_be_read_and_deleted(client, database):
    u = signed_up(client)
    bid = _book(client, u)
    cash = _account(client, u, bid)
    t = _expense(client, u, bid, cash, 1000)
    with database.connect() as c:
        c.execute(text("update entries set amount = -2000000000000000 where transaction_id = :t"), {"t": t["id"]})
    assert client.get(f"/v1/books/{bid}/transactions/{t['id']}", headers=auth(u)).json()["entries"][0]["amount"] == -2 * 10**15
    assert client.get(f"/v1/books/{bid}/transactions", headers=auth(u)).status_code == 200
    version = client.get(f"/v1/books/{bid}/transactions/{t['id']}", headers=auth(u)).json()["version"]
    assert client.delete(f"/v1/books/{bid}/transactions/{t['id']}?version={version}", headers=auth(u)).status_code == 204


def test_a_transaction_deleted_meanwhile_is_still_a_conflict(client):
    u = signed_up(client)
    bid = _book(client, u)
    t = _expense(client, u, bid, _account(client, u, bid), 1000)
    assert client.delete(f"/v1/books/{bid}/transactions/{t['id']}?version={t['version']}", headers=auth(u)).status_code == 204
    r = client.delete(f"/v1/books/{bid}/transactions/{t['id']}?version={t['version']}", headers=auth(u))
    assert (r.status_code, r.json()) == (409, {"detail": "conflict"})
