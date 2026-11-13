"""Usage numbers for the server's admin: off by default; counts of people and features, never anyone's data."""
import uuid

import pytest
from api_helpers import auth, new_book_with_accounts, signed_up
from sqlalchemy import text


@pytest.fixture
def admin(client, database):
    u = signed_up(client)
    with database.connect() as c:
        c.execute(text("update users set is_admin = true where id = :u"), {"u": u})
    yield u
    with database.connect() as c:
        c.execute(text("update instance_settings set usage_stats = false, usage_keep_days = 90, usage_key = null"))
        c.execute(text("delete from usage_days"))


def expense(client, u, bid, account, amount=-10_000, **more):
    r = client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
        "id": str(uuid.uuid4()), "type": "expense", "occurred_on": "2026-11-10", "entries": [{"account_id": account, "amount": amount}], **more})
    assert r.status_code == 201, r.text
    return r.json()


def rows(database):
    with database.connect() as c:
        return c.execute(text("select feature, count(distinct user_ref), sum(count) from usage_days group by 1 order by 1")).all()


def test_nothing_is_counted_until_the_admin_turns_it_on(client, database, admin):
    """R-INST-10: off on every server until its admin turns it on; anyone can see whether it's on."""
    assert client.get("/v1/instance").json()["usage_stats"] == "off"
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    expense(client, u, bid, accts["Cash"])
    assert client.post("/v1/usage", headers=auth(u), json={"feature": "hide_amounts"}).status_code == 204
    assert rows(database) == []
    assert client.get("/v1/admin/usage", headers=auth(admin)).json()["collecting"] is False

    assert client.patch("/v1/admin/instance", headers=auth(u), json={"usage_stats": "on"}).json() == {"detail": "admin_only"}
    assert client.patch("/v1/admin/instance", headers=auth(admin), json={"usage_stats": "on"}).status_code == 204
    assert client.get("/v1/instance").json()["usage_stats"] == "on"
    assert client.patch("/v1/admin/instance", headers=auth(admin), json={"usage_keep_days": 45}).status_code == 422
    assert client.patch("/v1/admin/instance", headers=auth(admin), json={"usage_keep_days": 180}).status_code == 204
    assert client.get("/v1/admin/usage", headers=auth(admin)).json()["keep_days"] == 180


def test_features_and_people_are_counted_and_nothing_else(client, database, admin):
    """R-INST-10: per day, per feature, per person, a count; the person as a keyed hash, not their id; no amount, text
    or id of anything; only the admin reads the numbers."""
    client.patch("/v1/admin/instance", headers=auth(admin), json={"usage_stats": "on"})
    one, two = signed_up(client), signed_up(client)
    bid, accts = new_book_with_accounts(client, one)
    first = expense(client, one, bid, accts["Cash"], payee="Secret payee", note="Secret note")
    expense(client, one, bid, accts["Cash"])
    client.get(f"/v1/books/{bid}/transactions?q=secret", headers=auth(one))
    client.put(f"/v1/books/{bid}/transactions/{first['id']}", headers=auth(one), json={
        "type": "expense", "occurred_on": "2026-11-10", "entries": first["entries"], "version": first["version"], "note": "x"})
    bid2, accts2 = new_book_with_accounts(client, two)
    expense(client, two, bid2, accts2["Cash"])
    assert client.post("/v1/usage", headers=auth(two), json={"feature": "hide_amounts"}).status_code == 204
    assert client.post("/v1/usage", headers=auth(two), json={"feature": "transaction_expense"}).status_code == 422   # the server's own
    assert client.post("/v1/usage", headers=auth(two), json={"feature": "Secret payee"}).status_code == 422

    counted = {f: (people, times) for f, people, times in rows(database)}
    assert counted["transaction_expense"] == (2, 3) and counted["transaction_edit"] == (1, 1)
    assert counted["filters"] == (1, 1) and counted["hide_amounts"] == (1, 1)
    assert counted["active"][0] >= 2 and counted["active"][1] == counted["active"][0]         # once a person a day
    with database.connect() as c:
        columns = {r[0]: r[1] for r in c.execute(text(
            "select column_name, data_type from information_schema.columns where table_name = 'usage_days'"))}
        assert columns == {"day": "date", "feature": "text", "user_ref": "bytea", "count": "integer"}
        refs = [bytes(r[0]) for r in c.execute(text("select distinct user_ref from usage_days"))]
        assert all(len(r) == 32 for r in refs) and not {one.bytes, two.bytes} & {r[:16] for r in refs}
        assert c.execute(text("select count(*) from usage_days where feature ilike '%secret%'")).scalar() == 0

    assert client.get("/v1/admin/usage", headers=auth(one)).json() == {"detail": "admin_only"}
    assert client.delete("/v1/admin/usage", headers=auth(one)).json() == {"detail": "admin_only"}
    usage = client.get("/v1/admin/usage", headers=auth(admin)).json()
    assert usage["collecting"] is True and usage["keep_days"] == 90
    assert usage["people"]["accounts"] >= 3 and usage["people"]["today"] >= 2 and usage["people"]["days_30"] >= 2
    assert len(usage["days"]) == 30 and usage["days"][-1]["people"] == usage["people"]["today"]
    by_name = {f["feature"]: (f["people"], f["times"]) for f in usage["features"]}
    assert by_name["transaction_expense"] == (2, 3) and "active" not in by_name
    assert usage["features"] == sorted(usage["features"], key=lambda f: (-f["people"], -f["times"], f["feature"]))
    assert usage["server"]["books"] >= 2 and usage["server"]["shared_books"] >= 0
    assert "Secret" not in str(usage) and str(one) not in str(usage)


def test_old_numbers_are_purged_and_the_admin_can_delete_them_all(client, database, admin):
    from app.jobs import account_deletion
    client.patch("/v1/admin/instance", headers=auth(admin), json={"usage_stats": "on", "usage_keep_days": 30})
    u = signed_up(client)
    bid, accts = new_book_with_accounts(client, u)
    expense(client, u, bid, accts["Cash"])
    with database.connect() as c:
        key = bytes(c.execute(text("select usage_key from instance_settings")).scalar())
        c.execute(text("insert into usage_days (day, feature, user_ref, count) values"
                       " (current_date - 31, 'export', sha256('old'), 4), (current_date - 29, 'export', sha256('kept'), 1)"))
        assert c.execute(text("select purge_usage()")).scalar() == 1
        assert c.execute(text("select count(*) from usage_days where feature = 'export'")).scalar() == 1
    assert hasattr(account_deletion, "purge_usage")
    assert client.delete("/v1/admin/usage", headers=auth(admin)).status_code == 204
    assert rows(database) == []
    with database.connect() as c:
        assert bytes(c.execute(text("select usage_key from instance_settings")).scalar()) != key      # old rows can't be matched
    expense(client, u, bid, accts["Cash"])
    assert dict((f, times) for f, _, times in rows(database))["transaction_expense"] == 1             # still collecting
    client.patch("/v1/admin/instance", headers=auth(admin), json={"usage_stats": "off"})
    expense(client, u, bid, accts["Cash"])
    assert dict((f, times) for f, _, times in rows(database))["transaction_expense"] == 1
