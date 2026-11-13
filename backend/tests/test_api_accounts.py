"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
import csv
import uuid

from api_helpers import _account, _book, auth, new_book_with_accounts, signed_up
from sqlalchemy import text


def test_accounts_with_opening_balances(client):
    u = signed_up(client)
    bid = str(uuid.uuid4())
    client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": "VND", "timezone": "UTC"})
    base = f"/v1/books/{bid}/accounts"
    cash = {"id": str(uuid.uuid4()), "name": "Tiền mặt", "kind": "cash", "opening_balance": 5_000_000, "opened_on": "2026-10-01"}
    r = client.post(base, headers=auth(u), json=cash)
    assert r.status_code == 201
    assert (r.json()["currency"], r.json()["balance"]) == ("VND", 5_000_000)
    assert client.post(base, headers=auth(u), json=cash).json()["balance"] == 5_000_000      # retry: not twice
    card = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Visa", "kind": "credit_card",
                                                     "currency": "USD", "last4": "4242", "opening_balance": -45000}).json()
    assert (card["currency"], card["balance"], card["last4"]) == ("USD", -45000, "4242")
    dup = client.post(base, headers=auth(u), json={**cash, "id": str(uuid.uuid4())})
    assert (dup.status_code, dup.json()) == (409, {"detail": "name_taken"})
    assert client.post(base, headers=auth(u), json={**cash, "id": str(uuid.uuid4()), "name": "x", "last4": "123456"}).status_code == 422

    locked = client.patch(f"{base}/{cash['id']}", headers=auth(u), json={"version": 1, "currency": "USD"})
    assert (locked.status_code, locked.json()) == (409, {"detail": "currency_locked"})
    out = client.patch(f"{base}/{card['id']}", headers=auth(u), json={"version": 1, "in_net_worth": False, "last4": ""}).json()
    assert (out["in_net_worth"], out["last4"], out["version"]) == (False, None, 2)
    archived = client.patch(f"{base}/{card['id']}", headers=auth(u), json={"version": 2, "archived": True}).json()
    assert archived["archived_at"] is not None
    assert [a["name"] for a in client.get(base, headers=auth(u)).json()] == ["Tiền mặt"]
    assert len(client.get(f"{base}?include_archived=true", headers=auth(u)).json()) == 2
    back = client.patch(f"{base}/{card['id']}", headers=auth(u), json={"version": 3, "archived": False}).json()
    assert back["archived_at"] is None


def test_account_details_by_kind(client):
    """A detail for the wrong kind is refused; changing the kind clears the ones that stop applying."""
    u = signed_up(client)
    bid, _ = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/accounts"

    def create(kind, **details):
        return client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": f"{kind} {uuid.uuid4().hex[:6]}",
                                                        "kind": kind, **details})

    card = create("credit_card", last4="3317", note="  Thẻ chính  ", credit_limit=50_000_000, annual_fee=499_000,
                  statement_day=25, payment_due_day=10, interest_rate_bp=2_800)
    assert card.status_code == 201
    assert {k: card.json()[k] for k in ("note", "credit_limit", "annual_fee", "statement_day", "payment_due_day",
                                        "interest_rate_bp")} == {"note": "Thẻ chính", "credit_limit": 50_000_000,
        "annual_fee": 499_000, "statement_day": 25, "payment_due_day": 10, "interest_rate_bp": 2_800}
    assert create("savings", interest_rate_bp=475).json()["interest_rate_bp"] == 475
    assert create("cash", note="Ví").json()["note"] == "Ví"
    for kind, details in (("cash", {"credit_limit": 1}), ("checking", {"interest_rate_bp": 100}), ("lent", {"statement_day": 3}),
                          ("credit_card", {"statement_day": 32}), ("credit_card", {"credit_limit": -1}),
                          ("savings", {"interest_rate_bp": 100_001}), ("cash", {"note": "x" * 501})):
        assert create(kind, **details).status_code == 422, (kind, details)

    acc = card.json()
    url = f"{base}/{acc['id']}"
    same = client.patch(url, headers=auth(u), json={"version": acc["version"], "name": "Visa"}).json()       # left out: kept
    assert (same["credit_limit"], same["note"]) == (50_000_000, "Thẻ chính")
    cleared = client.patch(url, headers=auth(u), json={"version": same["version"], "note": None, "annual_fee": None}).json()
    assert (cleared["note"], cleared["annual_fee"], cleared["credit_limit"]) == (None, None, 50_000_000)
    assert client.patch(url, headers=auth(u), json={"version": cleared["version"], "kind": "loan", "credit_limit": 1}).status_code == 422
    loan = client.patch(url, headers=auth(u), json={"version": cleared["version"], "kind": "loan"}).json()
    assert {k: loan[k] for k in ("kind", "credit_limit", "statement_day", "payment_due_day", "interest_rate_bp")} == {
        "kind": "loan", "credit_limit": None, "statement_day": None, "payment_due_day": 10, "interest_rate_bp": 2_800}
    assert loan["installment"] is None                                  # a loan's payment day stays
    cash = client.patch(url, headers=auth(u), json={"version": loan["version"], "kind": "cash"}).json()
    assert (cash["kind"], cash["interest_rate_bp"], cash["payment_due_day"]) == ("cash", None, None)

    # The export has them, readable: amounts in the currency, the rate as a percentage.
    import csv
    import io
    import zipfile
    create("credit_card", note="Thẻ phụ", credit_limit=20_000_000, statement_day=5, payment_due_day=20, interest_rate_bp=2_550)
    create("loan", note="Điện thoại", installment=1_000_000, installment_fee=240_000, payment_due_day=15)
    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(u)).content))
    rows = {r["Note"]: r for r in csv.DictReader(io.StringIO(z.read("accounts.csv").decode("utf-8-sig")))}
    assert {k: rows["Thẻ phụ"][k] for k in ("Credit limit", "Annual fee", "Statement day", "Payment due day",
                                            "Interest rate (% a year)")} == {"Credit limit": "20000000", "Annual fee": "",
        "Statement day": "5", "Payment due day": "20", "Interest rate (% a year)": "25.50"}
    assert {k: rows["Điện thoại"][k] for k in ("Monthly installment", "Installment fee", "Payment due day")} == {
        "Monthly installment": "1000000", "Installment fee": "240000", "Payment due day": "15"}


def test_pinned_accounts(client, database):
    """R-DASH-2: each member pins the accounts their Overview shows; pins are their own, a viewer pins too, and
    leaving the book drops them."""
    names = {k: f"{k}_{uuid.uuid4().hex[:8]}" for k in ("owner", "viewer")}
    owner, viewer = (signed_up(client, names[k]) for k in ("owner", "viewer"))
    bid, accts = new_book_with_accounts(client, owner)
    client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": names["viewer"], "role": "viewer"})
    client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(viewer))
    base = f"/v1/books/{bid}/accounts"

    def pinned(u):
        return {a["name"] for a in client.get(base, headers=auth(u)).json() if a["pinned"]}

    assert client.put(f"{base}/{accts['Cash']}/pin", headers=auth(owner)).status_code == 204
    assert client.put(f"{base}/{accts['Cash']}/pin", headers=auth(owner)).status_code == 204      # twice is fine
    assert (pinned(owner), pinned(viewer)) == ({"Cash"}, set())
    assert client.put(f"{base}/{accts['Bank']}/pin", headers=auth(viewer)).status_code == 204
    assert (pinned(owner), pinned(viewer)) == ({"Cash"}, {"Bank"})
    dash = client.get(f"/v1/books/{bid}/dashboard", headers=auth(owner)).json()
    assert {a["name"]: a["pinned"] for a in dash["accounts"]} == {"Cash": True, "Bank": False}

    import io
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(owner)).content))
    rows = list(csv.DictReader(io.StringIO(z.read("accounts.csv").decode("utf-8-sig"))))
    assert {r["Account"]: r["Pinned"] for r in rows} == {"Cash": "Yes", "Bank": "No"}

    assert client.delete(f"{base}/{accts['Cash']}/pin", headers=auth(owner)).status_code == 204
    assert pinned(owner) == set()
    assert client.put(f"{base}/{accts['Cash']}/pin", headers=auth(signed_up(client))).status_code == 404
    assert client.delete(f"/v1/books/{bid}/members/{viewer}", headers=auth(viewer)).status_code == 204
    with database.connect() as c:
        assert c.execute(text("select count(*) from account_pins where user_id = :u"), {"u": viewer}).scalar() == 0


def test_people_and_lending(client):
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/contacts"
    tom = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Tom", "note": "đồng nghiệp"}).json()
    mom = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Mẹ"}).json()
    assert client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Tom"}).json() == {"detail": "name_taken"}
    acc = lambda name, kind, contact: client.post(f"/v1/books/{bid}/accounts", headers=auth(u), json={  # noqa: E731
        "id": str(uuid.uuid4()), "name": name, "kind": kind, "contact_id": contact})
    lent = acc("Cho Tom vay", "lent", tom["id"]).json()
    loan = acc("Vay mẹ", "loan", mom["id"]).json()
    assert lent["contact_id"] == tom["id"]
    assert acc("Wrong", "checking", tom["id"]).json() == {"detail": "invalid"}     # only lent and loan take a person
    move = lambda frm, to, amount, day: client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={  # noqa: E731
        "id": str(uuid.uuid4()), "type": "transfer", "occurred_on": day,
        "entries": [{"account_id": frm, "amount": -amount}, {"account_id": to, "amount": amount}]})
    move(accts["Bank"], lent["id"], 2_000_000, "2026-10-02")      # lend Tom 2.000.000
    move(lent["id"], accts["Cash"], 500_000, "2026-10-03")        # he pays back 500.000
    move(loan["id"], accts["Bank"], 10_000_000, "2026-10-04")     # borrow 10.000.000 from Mom
    people = {c["name"]: c["balances"] for c in client.get(base, headers=auth(u)).json()}
    assert people["Tom"] == [{"currency": "VND", "owed_to_you": 1_500_000, "you_owe": 0}]
    assert people["Mẹ"] == [{"currency": "VND", "owed_to_you": 0, "you_owe": 10_000_000}]

    nobody = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Nobody"}).json()
    assert client.delete(f"{base}/{nobody['id']}?version=1", headers=auth(u)).json() == {"deleted": True, "archived": False}
    assert client.delete(f"{base}/{tom['id']}?version=1", headers=auth(u)).json() == {"deleted": False, "archived": True}
    unlinked = client.patch(f"/v1/books/{bid}/accounts/{loan['id']}", headers=auth(u), json={"version": loan["version"], "no_contact": True})
    assert unlinked.json()["contact_id"] is None
    edited = client.patch(f"{base}/{mom['id']}", headers=auth(u), json={"version": 1, "name": "Mẹ yêu", "note": "x"}).json()
    assert (edited["name"], edited["note"], edited["version"]) == ("Mẹ yêu", "x", 2)

    dash = client.get(f"/v1/books/{bid}/dashboard", headers=auth(u)).json()
    assert [(p["name"], p["owed_to_you"], p["you_owe"]) for p in dash["people"]] == [("Tom", 1_500_000, 0)]


def test_people_as_accounts(client):
    """R-LEND-2: adding a person adds their account, in the currency picked (the book's by default); it's changed
    through the person, not as an account; deleting a person with nothing recorded deletes it, otherwise both are
    archived."""
    import csv
    import io
    import zipfile
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}"
    minh = client.post(f"{base}/contacts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Minh"}).json()
    bob = client.post(f"{base}/contacts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Bob", "currency": "USD"}).json()
    assert (minh["currency"], bob["currency"]) == ("VND", "USD")
    own = {a["id"]: a for a in client.get(f"{base}/accounts", headers=auth(u)).json()}
    assert (own[minh["id"]]["kind"], own[minh["id"]]["name"], own[minh["id"]]["contact_id"]) == ("person", "Minh", minh["id"])
    assert own[bob["id"]]["currency"] == "USD"

    r = client.post(f"{base}/accounts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Sneaky", "kind": "person"})
    assert r.status_code == 422
    person = own[minh["id"]]
    for body in ({"name": "Other"}, {"archived": True}, {"kind": "cash"}):
        r = client.patch(f"{base}/accounts/{minh['id']}", headers=auth(u), json={"version": person["version"], **body})
        assert (r.status_code, r.json()) == (409, {"detail": "person_account"}), body

    r = client.post(f"{base}/transactions", headers=auth(u), json={"id": str(uuid.uuid4()), "type": "transfer",
                    "occurred_on": "2026-10-02", "entries": [{"account_id": accts["Cash"], "amount": -200_000},
                                                             {"account_id": minh["id"], "amount": 200_000}]})
    assert r.status_code == 201, r.text
    people = {c["name"]: c for c in client.get(f"{base}/contacts", headers=auth(u)).json()}
    assert people["Minh"]["balances"] == [{"currency": "VND", "owed_to_you": 200_000, "you_owe": 0}]

    assert client.delete(f"{base}/contacts/{bob['id']}?version=1", headers=auth(u)).json() == {"deleted": True, "archived": False}
    assert bob["id"] not in {a["id"] for a in client.get(f"{base}/accounts?include_archived=true", headers=auth(u)).json()}
    assert client.delete(f"{base}/contacts/{minh['id']}?version=1", headers=auth(u)).json() == {"deleted": False, "archived": True}
    archived = {a["id"]: a for a in client.get(f"{base}/accounts?include_archived=true", headers=auth(u)).json()}
    assert archived[minh["id"]]["archived_at"] is not None

    z = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(u)).content))
    rows = {r["Account"]: r for r in csv.DictReader(io.StringIO(z.read("accounts.csv").decode("utf-8-sig")))}
    assert (rows["Minh"]["Type"], rows["Minh"]["Person"]) == ("person", "Minh")


def test_an_opening_balance_without_a_date_is_today_in_the_books_timezone(client, database):
    u = signed_up(client)
    bid = _book(client, u, timezone="Pacific/Kiritimati")
    aid = _account(client, u, bid, "cash", opening_balance=100)
    with database.connect() as c:
        day, today = c.execute(text("select t.occurred_on, (now() at time zone 'Pacific/Kiritimati')::date from transactions t"
                                    " join entries e on e.transaction_id = t.id where e.account_id = :a"), {"a": aid}).one()
    assert day == today
