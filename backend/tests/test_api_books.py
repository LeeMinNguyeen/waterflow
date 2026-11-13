"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
import re
import uuid

from api_helpers import auth, new_book_with_accounts, signed_up
from sqlalchemy import text


def test_books(client):
    owner, stranger = signed_up(client, language="vi"), signed_up(client)
    bid = str(uuid.uuid4())
    new = {"id": bid, "name": "Gia đình", "base_currency": "VND", "timezone": "Asia/Ho_Chi_Minh"}
    r = client.post("/v1/books", headers=auth(owner), json=new)
    assert r.status_code == 201
    assert r.json() | {"version": 1} == {**new, "role": "owner", "archived_at": None, "version": 1}
    assert client.post("/v1/books", headers=auth(owner), json={**new, "name": "retry"}).json()["name"] == "Gia đình"
    assert [b["id"] for b in client.get("/v1/books", headers=auth(owner)).json()] == [bid]
    from app.core import db
    with db.user_session(owner) as s:                  # starter categories, in the owner's language
        assert s.execute(text("select count(*) from categories where book_id = :b and name = 'Thiết yếu'"), {"b": bid}).scalar() == 1

    for method, path in (("get", f"/v1/books/{bid}"), ("get", f"/v1/books/{bid}/accounts"),
                         ("patch", f"/v1/books/{bid}"), ("delete", f"/v1/books/{bid}?version=1")):
        r = client.request(method, path, headers=auth(stranger), json={"version": 1, "name": "x"} if method == "patch" else None)
        assert (r.status_code, r.json()) == (404, {"detail": "not_found"})
    assert client.post("/v1/books", headers=auth(stranger), json=new).json() == {"detail": "conflict"}    # someone else's id

    v = client.get(f"/v1/books/{bid}", headers=auth(owner)).json()["version"]
    ok = client.patch(f"/v1/books/{bid}", headers=auth(owner), json={"version": v, "name": "Nhà", "timezone": "UTC"})
    assert (ok.json()["name"], ok.json()["timezone"], ok.json()["version"]) == ("Nhà", "UTC", v + 1)
    stale = client.patch(f"/v1/books/{bid}", headers=auth(owner), json={"version": v, "name": "old tab"})
    assert (stale.status_code, stale.json()) == (409, {"detail": "conflict"})
    plain = client.post("/v1/books", headers=auth(owner), json={**new, "id": str(uuid.uuid4()), "starter_categories": False})
    with db.user_session(owner) as s:
        assert s.execute(text("select count(*) from categories where book_id = :b"), {"b": plain.json()["id"]}).scalar() == 0
    assert client.delete(f"/v1/books/{bid}?version={v}", headers=auth(owner)).status_code == 409
    assert client.delete(f"/v1/books/{bid}?version={v + 1}", headers=auth(owner)).status_code == 204
    assert client.get(f"/v1/books/{bid}", headers=auth(owner)).status_code == 404


def test_shared_books(client):
    """Two users keep one book together, and a viewer can't change it."""
    names = {k: f"{k}_{uuid.uuid4().hex[:8]}" for k in ("owner", "editor", "viewer", "other")}
    owner, editor, viewer, other = (signed_up(client, names[k]) for k in ("owner", "editor", "viewer", "other"))
    bid, accts = new_book_with_accounts(client, owner)
    members = f"/v1/books/{bid}/members"

    # Invites: by username, any case; unknown and already-in-the-book look alike.
    r = client.post(members, headers=auth(owner), json={"username": names["editor"].upper()})
    assert r.status_code == 201 and [(m["name"], m["role"], m["pending"]) for m in r.json()] == [
        (names["owner"], "owner", False), (names["editor"], "editor", True)]
    client.post(members, headers=auth(owner), json={"username": names["viewer"], "role": "viewer"})
    for name in ("nobody_here", names["editor"], names["owner"]):
        r = client.post(members, headers=auth(owner), json={"username": name})
        assert (r.status_code, r.json()) == (409, {"detail": "cannot_invite"})

    # Pending: the invitee sees the invite and nothing of the book.
    invites = client.get("/v1/me/book-invites", headers=auth(editor)).json()
    assert [(i["book_id"], i["role"], i["invited_by"]) for i in invites] == [(bid, "editor", names["owner"])]
    assert client.get(f"/v1/books/{bid}", headers=auth(editor)).status_code == 404
    assert client.get(members, headers=auth(editor)).status_code == 404
    assert client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(other)).status_code == 404
    assert client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(editor)).status_code == 204
    assert client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(viewer)).status_code == 204
    assert client.get("/v1/me/book-invites", headers=auth(editor)).json() == []
    assert client.get(f"/v1/books/{bid}", headers=auth(editor)).json()["role"] == "editor"

    # Together: the editor adds a transaction the owner sees; the viewer reads but can't write.
    txn = {"id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-10-03", "payee": "Chợ",
           "entries": [{"account_id": accts["Cash"], "amount": -50_000}]}
    assert client.post(f"/v1/books/{bid}/transactions", headers=auth(editor), json=txn).status_code == 201
    def payees(who):
        return [t["payee"] for t in client.get(f"/v1/books/{bid}/transactions", headers=auth(who)).json()["items"] if t["payee"]]
    assert payees(owner) == payees(viewer) == ["Chợ"]
    for method, path, body in (
            ("post", f"/v1/books/{bid}/transactions", {**txn, "id": str(uuid.uuid4())}),
            ("post", f"/v1/books/{bid}/accounts", {"id": str(uuid.uuid4()), "name": "X", "kind": "cash", "opened_on": "2026-10-01"}),
            ("post", f"/v1/books/{bid}/categories", {"id": str(uuid.uuid4()), "name": "X", "kind": "expense", "color": "#2563EB"}),
            ("patch", f"/v1/books/{bid}", {"version": 1, "name": "mine now"}),
            ("post", members, {"username": names["other"]}),
            ("patch", f"{members}/{editor}", {"role": "viewer"}),
            ("delete", f"{members}/{editor}", None)):
        r = client.request(method, path, headers=auth(viewer), json=body)
        assert r.status_code in (403, 404), (path, r.status_code, r.text)
    assert payees(owner) == ["Chợ"]
    assert client.post(members, headers=auth(editor), json={"username": names["other"]}).json() == {"detail": "forbidden"}

    # Roles: owners only; the last owner can't step down or leave.
    r = client.patch(f"{members}/{owner}", headers=auth(owner), json={"role": "editor"})
    assert (r.status_code, r.json()) == (409, {"detail": "owner_required"})
    assert client.delete(f"{members}/{owner}", headers=auth(owner)).json() == {"detail": "owner_required"}
    r = client.patch(f"{members}/{editor}", headers=auth(owner), json={"role": "owner"})
    assert {m["name"]: m["role"] for m in r.json()}[names["editor"]] == "owner"
    assert client.delete(f"{members}/{owner}", headers=auth(owner)).status_code == 204          # now they can leave
    assert client.get(f"/v1/books/{bid}", headers=auth(owner)).status_code == 404

    # The new owner removes the viewer, invites someone who declines.
    assert client.delete(f"{members}/{viewer}", headers=auth(editor)).status_code == 204
    assert client.get(f"/v1/books/{bid}", headers=auth(viewer)).status_code == 404
    client.post(members, headers=auth(editor), json={"username": names["other"], "role": "viewer"})
    assert client.delete(f"/v1/me/book-invites/{bid}", headers=auth(other)).status_code == 204
    assert client.get("/v1/me/book-invites", headers=auth(other)).json() == []
    assert [(m["name"], m["me"]) for m in client.get(members, headers=auth(editor)).json()] == [(names["editor"], True)]


def test_book_changes_marker(client):
    """A member polls one cheap marker that changes when anyone changes the book."""
    owner, editor, stranger = signed_up(client), signed_up(client), signed_up(client)
    bid, accts = new_book_with_accounts(client, owner)
    editor_name = client.get("/v1/me", headers=auth(editor)).json()["profile"]["username"]
    client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": editor_name})
    assert client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(editor)).status_code == 204
    url = f"/v1/books/{bid}/changes"

    first = client.get(url, headers=auth(owner)).json()["marker"]
    assert client.get(url, headers=auth(owner)).json()["marker"] == first == client.get(url, headers=auth(editor)).json()["marker"]
    assert re.fullmatch(r"[0-9a-f]{32}", first)        # opaque: no audit ids, which count changes across the server
    client.post(f"/v1/books/{bid}/transactions", headers=auth(editor), json={
        "id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-10-05",
        "entries": [{"account_id": accts["Cash"], "amount": -30_000}]})
    second = client.get(url, headers=auth(owner)).json()["marker"]
    assert second != first
    client.patch(f"/v1/books/{bid}", headers=auth(owner), json={"version": 1, "name": "Renamed"})
    assert client.get(url, headers=auth(editor)).json()["marker"] not in (first, second)
    assert client.get(url, headers=auth(stranger)).json() == {"detail": "not_found"}


def test_book_invites_are_rate_limited(client):
    """A found username becomes an invite, so guessing names is slowed down."""
    owner = signed_up(client)
    bid, _ = new_book_with_accounts(client, owner)
    codes = [client.post(f"/v1/books/{bid}/members", headers=auth(owner), json={"username": f"guess{i}"}).status_code
             for i in range(11)]
    assert codes == [409] * 10 + [429]
