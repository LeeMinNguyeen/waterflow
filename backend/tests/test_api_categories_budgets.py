"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
import threading
import time
import uuid

from api_helpers import add_category, auth, new_book_with_accounts, signed_up
from sqlalchemy import text


def test_a_category_with_a_siblings_name_is_name_taken(client):
    u = signed_up(client)
    bid, _ = new_book_with_accounts(client, u)
    food = add_category(client, u, bid, "Food")
    add_category(client, u, bid, "Lunch", parent=food["id"])
    for parent in (None, food["id"]):
        r = client.post(f"/v1/books/{bid}/categories", headers=auth(u), json={
            "id": str(uuid.uuid4()), "name": "Food" if parent is None else "Lunch", "kind": "expense", "parent_id": parent})
        assert (r.status_code, r.json()) == (409, {"detail": "name_taken"})


def test_categories(client):
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/categories"
    food = add_category(client, u, bid, "Ăn uống")
    out = add_category(client, u, bid, "Ăn ngoài", parent=food["id"])
    unused = add_category(client, u, bid, "Unused")
    savings = add_category(client, u, bid, "Tiết kiệm", kind="transfer")
    assert food["color"] == "#2563eb"
    assert {c["name"] for c in client.get(base, headers=auth(u)).json()} == {"Ăn uống", "Ăn ngoài", "Unused", "Tiết kiệm"}

    loop = client.patch(f"{base}/{food['id']}", headers=auth(u), json={"version": 1, "parent_id": out["id"]})
    assert (loop.status_code, loop.json()) == (422, {"detail": "invalid"})
    moved = client.patch(f"{base}/{out['id']}", headers=auth(u), json={"version": 1, "top_level": True, "color": ""}).json()
    assert (moved["parent_id"], moved["color"], moved["version"]) == (None, None, 2)
    client.patch(f"{base}/{out['id']}", headers=auth(u), json={"version": 2, "parent_id": food["id"]})

    client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
        "id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-10-02", "category_id": out["id"],
        "entries": [{"account_id": accts["Cash"], "amount": -50_000}]})
    assert client.delete(f"{base}/{unused['id']}?version=1", headers=auth(u)).json() == {"deleted": True, "archived": False}
    assert client.delete(f"{base}/{food['id']}?version=1", headers=auth(u)).json() == {"detail": "has_subcategories"}
    assert client.delete(f"{base}/{out['id']}?version=3", headers=auth(u)).json() == {"deleted": False, "archived": True}
    assert "Ăn ngoài" not in {c["name"] for c in client.get(base, headers=auth(u)).json()}
    assert "Ăn ngoài" in {c["name"] for c in client.get(f"{base}?include_archived=true", headers=auth(u)).json()}
    kind = client.patch(f"{base}/{out['id']}", headers=auth(u), json={"version": 4, "kind": "transfer"})
    assert (kind.status_code, kind.json()) == (422, {"detail": "category_kind"})
    assert client.patch(f"{base}/{savings['id']}", headers=auth(u), json={"version": 9, "name": "x"}).json() == {"detail": "conflict"}


def test_two_moves_at_the_same_moment_make_no_cycle(client, database):
    """A under B while B goes under A: the second move waits for the first, then sees it and is refused."""
    u = signed_up(client)
    bid, _ = new_book_with_accounts(client, u)
    a, b = add_category(client, u, bid, "A"), add_category(client, u, bid, "B")
    result = {}

    def move_a_under_b():
        result["r"] = client.patch(f"/v1/books/{bid}/categories/{a['id']}", headers=auth(u),
                                   json={"version": 1, "parent_id": b["id"]})

    with database.connect() as other:                 # the other move, between its check and its commit
        other.exec_driver_sql("begin")
        other.execute(text("select pg_advisory_xact_lock(hashtextextended('categories ' || cast(:b as text), 0))"),
                      {"b": bid})
        other.execute(text("update categories set parent_id = :a where id = :b"), {"a": a["id"], "b": b["id"]})
        mover = threading.Thread(target=move_a_under_b)
        mover.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and "r" not in result and not other.execute(text(
                "select count(*) from pg_locks where locktype = 'advisory' and not granted")).scalar():
            time.sleep(0.05)
        other.exec_driver_sql("commit")
        mover.join(10)
    assert (result["r"].status_code, result["r"].json()) == (422, {"detail": "invalid"})
    with database.connect() as owner:
        assert owner.execute(text("select parent_id from categories where id = :a"), {"a": a["id"]}).scalar() is None


def test_budgets(client):
    from datetime import date as d
    today = d.today()
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/budgets"
    food = add_category(client, u, bid, "Food")
    lunch = add_category(client, u, bid, "Lunch", parent=food["id"])
    salary = add_category(client, u, bid, "Salary", kind="income")
    monthly = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": food["id"], "period": "monthly",
                                                       "amount": 3_000_000, "starts_on": today.replace(day=1).isoformat()})
    assert monthly.status_code == 201, monthly.text
    b = monthly.json()
    assert (b["amount"], b["progress"]["spent"], b["progress"]["period_start"]) == (3_000_000, 0, today.replace(day=1).isoformat())
    daily = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": food["id"], "period": "daily",
                                                     "amount": 200_000})
    assert daily.status_code == 201
    dup = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": food["id"], "period": "monthly", "amount": 1})
    assert (dup.status_code, dup.json()) == (409, {"detail": "budget_exists"})
    income = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": salary["id"], "period": "monthly", "amount": 1})
    assert income.json() == {"detail": "budget_expense_only"}
    assert client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": food["id"], "period": "yearly",
                                                    "amount": 0}).json() == {"detail": "invalid"}

    for amount in (120_000, 30_000):                      # spent on Lunch counts toward Food
        client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
            "id": str(uuid.uuid4()), "type": "expense", "occurred_on": today.isoformat(), "category_id": lunch["id"],
            "entries": [{"account_id": accts["Cash"], "amount": -amount}]})
    got = {x["period"]: x for x in client.get(base, headers=auth(u)).json()}
    assert (got["monthly"]["progress"]["spent"], got["monthly"]["progress"]["remaining"], got["monthly"]["progress"]["percent_used"]) == \
        (150_000, 2_850_000, 5.0)
    assert got["daily"]["progress"]["percent_used"] == 75.0

    raised = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 1, "amount": 5_000_000}).json()
    assert (raised["amount"], raised["version"]) == (5_000_000, 2)
    assert client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 1, "amount": 1}).json() == {"detail": "conflict"}
    ended = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 2, "ends_on": "2000-01-01"})
    assert ended.json() == {"detail": "invalid"}          # ends before it starts

    dash = client.get(f"/v1/books/{bid}/dashboard", headers=auth(u)).json()
    assert [(x["category"], x["period"], x["spent"]) for x in dash["budgets"]] == [("Food", "daily", 150_000), ("Food", "monthly", 150_000)]
    assert client.delete(f"{base}/{daily.json()['id']}?version=1", headers=auth(u)).status_code == 204
    assert len(client.get(base, headers=auth(u)).json()) == 1


def test_a_budget_for_all_spending(client):
    """R-BUD-3: a budget with no category counts every expense and refund in the book, with or without a category,
    except the categories left out (with their sub-categories); one per period; archiving a category doesn't hide it."""
    import io
    import zipfile
    from datetime import date as d
    today = d.today()
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    base = f"/v1/books/{bid}/budgets"
    food = add_category(client, u, bid, "Food")
    lunch = add_category(client, u, bid, "Lunch", parent=food["id"])
    rent = add_category(client, u, bid, "Rent")
    salary = add_category(client, u, bid, "Salary", kind="income")
    r = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": None, "period": "monthly",
                                                 "amount": 15_000_000, "starts_on": today.replace(day=1).isoformat()})
    assert r.status_code == 201, r.text
    b = r.json()
    assert (b["category_id"], b["excluded_category_ids"], b["progress"]["spent"]) == (None, [], 0)
    dup = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "period": "monthly", "amount": 1})
    assert (dup.status_code, dup.json()) == (409, {"detail": "budget_exists"})
    assert client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "period": "weekly", "amount": 1}).status_code == 201

    def spend(type_, amount, category=None):
        client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
            "id": str(uuid.uuid4()), "type": type_, "occurred_on": today.isoformat(), "category_id": category,
            "entries": [{"account_id": accts["Cash"], "amount": amount}]})

    spend("expense", -120_000, lunch["id"])
    spend("expense", -5_000_000, rent["id"])
    spend("expense", -30_000)
    spend("refund", 20_000, lunch["id"])
    spend("income", 9_000_000, salary["id"])
    client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
        "id": str(uuid.uuid4()), "type": "transfer", "occurred_on": today.isoformat(),
        "entries": [{"account_id": accts["Bank"], "amount": -500_000}, {"account_id": accts["Cash"], "amount": 500_000}]})

    def progress():
        return next(x for x in client.get(base, headers=auth(u)).json() if x["id"] == b["id"])

    dash = client.get(f"/v1/books/{bid}/dashboard", headers=auth(u)).json()
    assert progress()["progress"]["spent"] == 5_130_000 == dash["spent_this_month"]
    assert (dash["budgets"][0]["category_id"], dash["budgets"][0]["category"], dash["budgets"][0]["excluded_category_ids"]) == (None, None, [])

    left_out = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 1, "excluded_category_ids": [rent["id"]]}).json()
    assert (left_out["excluded_category_ids"], left_out["progress"]["spent"], left_out["version"]) == ([rent["id"]], 130_000, 2)
    parent = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 2, "excluded_category_ids": [food["id"]]}).json()
    assert parent["progress"]["spent"] == 5_030_000               # Lunch goes with Food

    for wrong in ([salary["id"]], [str(uuid.uuid4())]):          # an income category; one that isn't in this book
        r = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 3, "excluded_category_ids": wrong})
        assert (r.status_code, r.json()) == (422, {"detail": "invalid"}), wrong
    on_food = client.post(base, headers=auth(u), json={"id": str(uuid.uuid4()), "category_id": food["id"], "period": "monthly",
                                                       "amount": 1, "excluded_category_ids": [rent["id"]]})
    assert (on_food.status_code, on_food.json()) == (422, {"detail": "invalid"})

    spare = add_category(client, u, bid, "Spare")
    twice = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 3, "excluded_category_ids": [food["id"], spare["id"], spare["id"]]}).json()
    assert twice["excluded_category_ids"] == [food["id"], spare["id"]]
    client.delete(f"/v1/books/{bid}/categories/{spare['id']}?version=1", headers=auth(u))   # unused: deleted, not archived
    after = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 5, "amount": 16_000_000})
    assert after.status_code == 200, after.text
    assert after.json()["excluded_category_ids"] == [food["id"]]
    too_many = client.patch(f"{base}/{b['id']}", headers=auth(u), json={"version": 6, "excluded_category_ids": [str(uuid.uuid4())] * 201})
    assert too_many.status_code == 422

    cat = next(c for c in client.get(f"/v1/books/{bid}/categories", headers=auth(u)).json() if c["id"] == food["id"])
    client.patch(f"/v1/books/{bid}/categories/{food['id']}", headers=auth(u), json={"version": cat["version"], "archived": True})
    assert progress()["progress"]["spent"] == 5_030_000

    rows = zipfile.ZipFile(io.BytesIO(client.get("/v1/me/export", headers=auth(u)).content)).read("budgets.csv")
    rows = rows.decode("utf-8-sig").splitlines()
    assert rows[0] == "Book,Category,Left out,Period,Amount,Currency,Starts,Ends"
    assert any(row.startswith("B,All spending,Food,monthly,16000000,VND,") for row in rows), rows

    viewer_name = f"v_{uuid.uuid4().hex[:8]}"
    viewer = signed_up(client, viewer_name)
    client.post(f"/v1/books/{bid}/members", headers=auth(u), json={"username": viewer_name, "role": "viewer"})
    client.post(f"/v1/me/book-invites/{bid}/accept", headers=auth(viewer))
    assert client.post(base, headers=auth(viewer), json={"id": str(uuid.uuid4()), "period": "daily", "amount": 1}).status_code == 403
    assert client.get(base, headers=auth(signed_up(client))).json() == {"detail": "not_found"}
