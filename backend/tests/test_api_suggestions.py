"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
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


def test_transactions_have_a_time_of_day(client):
    """R-TXN-6: every transaction has a date and a time of day; lists sort by both; one saved without a time has
    00:00, and an edit that leaves the time out keeps it."""
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/transactions"

    def add(payee, time=None):
        body = {"id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-10-05", "payee": payee,
                "entries": [{"account_id": accts["Cash"], "amount": -10_000}]} | ({"occurred_time": time} if time else {})
        return client.post(base, headers=auth(u), json=body).json()

    evening, morning, unset = add("Dinner", "18:45"), add("Coffee", "08:05"), add("Old app")
    assert (evening["occurred_time"], morning["occurred_time"], unset["occurred_time"]) == ("18:45:00", "08:05:00", "00:00:00")
    listed = client.get(base, headers=auth(u), params={"from": "2026-10-05", "to": "2026-10-05"}).json()["items"]
    assert [x["payee"] for x in listed] == ["Dinner", "Coffee", "Old app"]

    pages, after = [], None
    while True:
        page = client.get(base, headers=auth(u), params={"from": "2026-10-05", "limit": 1} | ({"after": after} if after else {})).json()
        pages += [x["payee"] for x in page["items"]]
        if not (after := page["next"]):
            break
    assert pages == ["Dinner", "Coffee", "Old app"]

    running = client.get(base, headers=auth(u), params={"account_id": accts["Cash"], "from": "2026-10-05"}).json()["items"]
    assert [x["running_balance"] for x in running] == [970_000, 980_000, 990_000]

    edit = {k: v for k, v in morning.items() if k in ("type", "occurred_on", "entries", "payee")} | {"version": morning["version"]}
    kept = client.put(f"{base}/{morning['id']}", headers=auth(u), json=edit).json()
    assert (kept["occurred_time"], kept["version"]) == ("08:05:00", 1)
    moved = client.put(f"{base}/{morning['id']}", headers=auth(u), json=edit | {"occurred_time": "21:00"}).json()
    assert (moved["occurred_time"], moved["version"]) == ("21:00:00", 2)
    history = client.get(f"{base}/{morning['id']}/history", headers=auth(u)).json()
    assert [h["occurred_time"] for h in history] == ["08:05:00", "21:00:00"]

    import csv
    import io
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(u)).content))
    times = {r["Payee"]: r["Time"] for r in csv.DictReader(io.StringIO(z.read("transactions.csv").decode("utf-8-sig")))}
    assert (times["Dinner"], times["Coffee"], times["Old app"]) == ("18:45", "21:00", "00:00")


def test_suggestions_from_my_own_history(client):
    """R-TXN-7: a new transaction is filled in from the user's own recent ones of the same type and a close amount
    (within 10 %, the last 90 days): the account, category and payee that make up at least 2 of the last 3."""
    from datetime import date, timedelta
    names = {k: f"{k}_{uuid.uuid4().hex[:8]}" for k in ("owner", "editor")}
    owner, editor = (signed_up(client, names[k]) for k in ("owner", "editor"))
    bid, accts = new_book_with_accounts(client, owner)
    client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": names["editor"], "role": "editor"})
    client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(editor))
    parking = add_category(client, owner, bid, "Gửi xe")["id"]
    food = add_category(client, owner, bid, "Ăn uống")["id"]
    today = date.today()

    def add(u, amount, account, category, payee, days_ago=0, type_="expense"):
        r = client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
            "id": str(uuid.uuid4()), "type": type_, "occurred_on": (today - timedelta(days=days_ago)).isoformat(),
            "category_id": category, "payee": payee,
            "entries": [{"account_id": accts[account], "amount": -amount if type_ == "expense" else amount}]})
        assert r.status_code == 201, r.text

    def suggest(u, amount, type_="expense"):
        r = client.get(f"/v1/books/{bid}/transactions/suggest", headers=auth(u), params={"type": type_, "amount": amount})
        assert r.status_code == 200, r.text
        return r.json()

    add(owner, 5_000, "Cash", parking, "Gửi xe", days_ago=3)
    add(owner, 5_200, "Bank", food, "Bánh mì", days_ago=2)
    add(owner, 4_800, "Cash", parking, "Gửi xe", days_ago=1)
    assert suggest(owner, 5_000) == {"account_id": accts["Cash"], "category_id": parking, "payee": "Gửi xe"}
    assert suggest(owner, 4_600) == suggest(owner, 5_000)                  # close amounts count
    assert suggest(owner, 9_000) is None                                    # nothing close
    assert suggest(owner, 5_000, "income") is None                          # another type

    for _ in range(3):                                                      # someone else's habits aren't mine
        add(editor, 20_000, "Bank", food, "Cơm")
    assert suggest(owner, 20_000) is None
    assert suggest(editor, 20_000) == {"account_id": accts["Bank"], "category_id": food, "payee": "Cơm"}

    for _ in range(3):                                                      # older than 90 days
        add(owner, 77_000, "Bank", food, "Old habit", days_ago=120)
    assert suggest(owner, 77_000) is None
    assert client.get(f"/v1/books/{bid}/transactions/suggest", headers=auth(signed_up(client)),
                      params={"type": "expense", "amount": 5_000}).status_code == 404


def test_payee_suggestions(client):
    """R-TXN-8: typing a payee offers the book's payees, every member's: those starting with the text first, then those
    containing it, the most used first, each with the account and category of its latest transaction of the type."""
    names = {k: f"{k}_{uuid.uuid4().hex[:8]}" for k in ("owner", "editor", "viewer")}
    users = {k: signed_up(client, names[k]) for k in names}
    owner = users["owner"]
    bid, accts = new_book_with_accounts(client, owner)
    for k in ("editor", "viewer"):
        client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": names[k], "role": k})
        client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(users[k]))
    food = add_category(client, owner, bid, "Ăn uống")["id"]
    coffee = add_category(client, owner, bid, "Cà phê")["id"]
    pay = add_category(client, owner, bid, "Lương", kind="income")["id"]
    move = add_category(client, owner, bid, "Chuyển", kind="transfer")["id"]

    def add(u, payee, account, category, day, type_="expense", amount=50_000):
        entries = ([{"account_id": accts["Cash"], "amount": -amount}, {"account_id": accts["Bank"], "amount": amount}]
                   if type_ == "transfer" else [{"account_id": accts[account], "amount": -amount if type_ == "expense" else amount}])
        r = client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
            "id": str(uuid.uuid4()), "type": type_, "occurred_on": f"2026-10-{day:02d}", "category_id": category,
            "payee": payee, "entries": entries})
        assert r.status_code == 201, r.text

    def payees(u, q, type_=None):
        r = client.get(f"/v1/books/{bid}/payees", headers=auth(u), params={"q": q} | ({"type": type_} if type_ else {}))
        assert r.status_code == 200, r.text
        return r.json()

    add(owner, "Highlands", "Cash", coffee, 1)
    add(owner, "highlands ", "Bank", food, 3)
    add(users["editor"], "Highlands", "Bank", coffee, 5)
    add(owner, "Phở Highlands", "Cash", food, 4)
    add(owner, "Phở Highlands", "Cash", food, 6)
    add(owner, "Phở Highlands", "Cash", food, 7)
    add(owner, "Công ty", "Bank", pay, 2, type_="income")
    add(owner, "Highlands ATM", "Cash", move, 8, type_="transfer")

    got = payees(owner, "HIGH")
    assert [p["payee"] for p in got] == ["Highlands", "Phở Highlands"]        # starts with it first, then contains it
    assert got[0] == {"payee": "Highlands", "count": 3, "account_id": accts["Bank"], "category_id": coffee}
    assert got[1]["count"] == 3
    assert [p["payee"] for p in payees(owner, "")] == ["Phở Highlands", "Highlands", "Công ty"]    # equal counts: latest first
    assert [p["payee"] for p in payees(owner, "", "income")] == ["Công ty"]
    assert payees(owner, "atm") == []                                         # transfers aren't offered
    assert payees(users["viewer"], "high") == got                             # a viewer reads them too
    assert payees(owner, "%") == [] and payees(owner, "_") == []

    for i in range(10):
        add(owner, f"Shop {i}", "Cash", food, 10)
    assert len(payees(owner, "shop")) == 8

    other = signed_up(client)
    assert client.get(f"/v1/books/{bid}/payees", headers=auth(other), params={"q": "high"}).status_code == 404
    other_bid, other_accts = new_book_with_accounts(client, other)
    assert client.get(f"/v1/books/{other_bid}/payees", headers=auth(other), params={"q": "high"}).json() == []


def test_usual_transactions(client):
    """R-TXN-9: the add dialog offers the user's own usual transactions: the same account, category, payee and amount
    at least 3 times in the last 60 days, the most frequent 5, ties to the latest; other members' never count."""
    from datetime import date, timedelta
    names = {k: f"{k}_{uuid.uuid4().hex[:8]}" for k in ("owner", "editor")}
    owner, editor = (signed_up(client, names[k]) for k in ("owner", "editor"))
    bid, accts = new_book_with_accounts(client, owner)
    client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": names["editor"], "role": "editor"})
    client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(editor))
    coffee = add_category(client, owner, bid, "Cà phê")["id"]
    move = add_category(client, owner, bid, "Di chuyển")["id"]
    pay = add_category(client, owner, bid, "Lương", kind="income")["id"]
    today = date.today()

    def add(u, payee, amount, account="Cash", category=coffee, days_ago=0, type_="expense", times=1):
        for _ in range(times):
            r = client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
                "id": str(uuid.uuid4()), "type": type_, "occurred_on": (today - timedelta(days=days_ago)).isoformat(),
                "category_id": category, "payee": payee,
                "entries": [{"account_id": accts[account], "amount": -amount if type_ == "expense" else amount}]})
            assert r.status_code == 201, r.text

    def usual(u, type_="expense"):
        r = client.get(f"/v1/books/{bid}/transactions/usual", headers=auth(u), params={"type": type_})
        assert r.status_code == 200, r.text
        return [(t["payee"], t["amount"], t["count"]) for t in r.json()]

    add(owner, "Highlands", 55_000, times=4, days_ago=2)
    add(owner, "Grab", 45_000, account="Bank", category=move, times=3, days_ago=1)
    add(owner, "Phở", 65_000, times=2)                                         # twice isn't usual
    add(owner, "Highlands", 60_000, times=2)                                   # another amount is another group
    add(owner, "Old habit", 20_000, times=5, days_ago=70)                      # older than 60 days
    add(editor, "Cơm", 35_000, times=5)                                        # someone else's habits
    add(owner, "Công ty", 30_000_000, category=pay, type_="income", times=3)
    assert usual(owner) == [("Highlands", 55_000, 4), ("Grab", 45_000, 3)]
    first = client.get(f"/v1/books/{bid}/transactions/usual", headers=auth(owner), params={"type": "expense"}).json()[0]
    assert (first["account_id"], first["category_id"], first["last_on"]) == (accts["Cash"], coffee, (today - timedelta(days=2)).isoformat())
    assert usual(owner, "income") == [("Công ty", 30_000_000, 3)]
    assert usual(editor) == [("Cơm", 35_000, 5)]

    for i in range(6):                                                          # the top 5; equal counts, the latest first
        add(owner, f"Shop {i}", 10_000 + i, times=3, days_ago=10 - i)
    assert [p for p, _, _ in usual(owner)] == ["Highlands", "Grab", "Shop 5", "Shop 4", "Shop 3"]

    bank = next(a for a in client.get(f"/v1/books/{bid}/accounts", headers=auth(owner)).json() if a["id"] == accts["Bank"])
    assert client.patch(f"/v1/books/{bid}/accounts/{bank['id']}", headers=auth(owner),
                        json={"version": bank["version"], "archived": True}).status_code == 200
    assert "Grab" not in [p for p, _, _ in usual(owner)]                        # an archived account is left out
    cat = next(c for c in client.get(f"/v1/books/{bid}/categories", headers=auth(owner)).json() if c["id"] == coffee)
    client.delete(f"/v1/books/{bid}/categories/{coffee}", headers=auth(owner), params={"version": cat["version"]})
    assert "Highlands" not in [p for p, _, _ in usual(owner)]                   # so is an archived category

    assert client.get(f"/v1/books/{bid}/transactions/usual", headers=auth(signed_up(client)),
                      params={"type": "expense"}).status_code == 404


def test_a_suggestion_stays_in_the_currency_typed(client):
    """5000 minor units are ₫5,000 or $50.00: with a currency, only amounts in it match."""
    u = signed_up(client)
    bid = _book(client, u)
    usd = _account(client, u, bid, "credit_card", currency="USD")
    for _ in range(2):
        _expense(client, u, bid, usd, 5000, payee="Amazon")
    url = f"/v1/books/{bid}/transactions/suggest?type=expense&amount=5000"
    assert client.get(url + "&currency=VND", headers=auth(u)).json() is None
    assert client.get(url + "&currency=USD", headers=auth(u)).json()["account_id"] == usd
    assert client.get(url, headers=auth(u)).json()["account_id"] == usd      # older apps send no currency
