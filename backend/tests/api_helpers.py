"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
import uuid
from datetime import date

TOKENS: dict[uuid.UUID, str] = {}
PASSWORD = "correct horse battery"


def auth(uid):
    return {"Authorization": f"Bearer {TOKENS[uid]}"}


def signed_up(client, name=None, language=None):
    name = name or f"u{uuid.uuid4().hex[:10]}"
    body = {"username": name, "password": PASSWORD, "timezone": "Asia/Ho_Chi_Minh"}
    r = client.post("/v1/auth/sign-up", json=body | ({"language": language} if language else {}))
    assert r.status_code == 201, r.text
    token = r.json()["token"]
    uid = uuid.UUID(client.get("/v1/me", headers={"Authorization": f"Bearer {token}"}).json()["id"])
    TOKENS[uid] = token
    return uid


def new_book_with_accounts(client, u, currency="VND"):
    bid = str(uuid.uuid4())
    client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": currency, "timezone": "UTC",
                                                    "starter_categories": False})
    accts = {}
    for name, kind, opening in (("Cash", "cash", 1_000_000), ("Bank", "checking", 5_000_000)):
        aid = str(uuid.uuid4())
        client.post(f"/v1/books/{bid}/accounts", headers=auth(u),
                    json={"id": aid, "name": name, "kind": kind, "opening_balance": opening, "opened_on": "2026-10-01"})
        accts[name] = aid
    return bid, accts


def add_category(client, u, bid, name, kind="expense", parent=None):
    cid = str(uuid.uuid4())
    r = client.post(f"/v1/books/{bid}/categories", headers=auth(u),
                    json={"id": cid, "name": name, "kind": kind, "parent_id": parent, "color": "#2563EB"})
    assert r.status_code == 201, r.text
    return r.json()


def events(capsys):
    import json
    return [json.loads(line)["account_event"] for line in capsys.readouterr().out.splitlines() if "account_event" in line]


def _book(client, u, currency="VND", timezone="UTC"):
    bid = str(uuid.uuid4())
    r = client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": currency, "timezone": timezone,
                                                        "starter_categories": False})
    assert r.status_code == 201, r.text
    return bid


def _account(client, u, bid, kind="cash", currency=None, **extra):
    aid = str(uuid.uuid4())
    r = client.post(f"/v1/books/{bid}/accounts", headers=auth(u), json={
        "id": aid, "name": f"{kind} {aid[:6]}", "kind": kind, **({"currency": currency} if currency else {}), **extra})
    assert r.status_code == 201, r.text
    return aid


def _expense(client, u, bid, account, amount, day=None, **extra):
    r = client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
        "id": str(uuid.uuid4()), "type": "expense", "occurred_on": day or date.today().isoformat(),
        "entries": [{"account_id": account, "amount": -amount}], **extra})
    assert r.status_code == 201, r.text
    return r.json()
