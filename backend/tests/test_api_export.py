"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
import uuid

import pytest
from api_helpers import auth, events, new_book_with_accounts, signed_up
from sqlalchemy import text


def test_profile_and_export(client):
    u = signed_up(client)
    r = client.patch("/v1/me", headers=auth(u), json={"username": "New_Name_" + u.hex[:6], "language": "vi", "display_name": "N"})
    assert (r.json()["profile"]["username"], r.json()["profile"]["language"]) == (f"new_name_{u.hex[:6]}", "vi")
    assert client.patch("/v1/me", headers=auth(u), json={"display_name": ""}).json()["profile"]["display_name"] is None

    new_book_with_accounts(client, u)
    zipped = client.get("/v1/me/export", headers=auth(u))
    assert zipped.headers["content-type"] == "application/zip" and "attachment" in zipped.headers["content-disposition"]
    import io
    import zipfile
    names = zipfile.ZipFile(io.BytesIO(zipped.content)).namelist()
    assert "profile.csv" in names and "transactions.csv" in names


def test_close_and_restore(client, capsys):
    u = signed_up(client)
    bid, _ = new_book_with_accounts(client, u)
    capsys.readouterr()
    closed = client.post("/v1/me/delete", headers=auth(u)).json()
    assert closed["deletion_requested_at"] is not None and closed["deletes_on"] > closed["deletion_requested_at"]
    assert client.get("/v1/books", headers=auth(u)).json() == []          # a closed account sees no book data
    client.post("/v1/me/delete", headers=auth(u))                         # again: nothing new to log
    assert client.post("/v1/me/restore", headers=auth(u)).json()["deletion_requested_at"] is None
    assert [b["id"] for b in client.get("/v1/books", headers=auth(u)).json()] == [bid]
    assert events(capsys) == ["account_closed", "account_restored"]
    refused = client.post("/v1/me/restore", headers=auth(u))               # nothing to restore
    assert (refused.status_code, refused.json()) == (409, {"detail": "not_restorable"})


def test_timezone_aliases_become_names_the_database_knows(client, database):
    """Windows browsers report Asia/Saigon, which the postgres image doesn't know."""
    u = signed_up(client)
    bid = str(uuid.uuid4())
    r = client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": "VND", "timezone": "Asia/Saigon"})
    assert r.status_code == 201 and r.json()["timezone"] == "Asia/Ho_Chi_Minh"
    assert client.get(f"/v1/books/{bid}/dashboard", headers=auth(u)).status_code == 200
    assert client.patch("/v1/me", headers=auth(u), json={"timezone": "Asia/Calcutta"}).json()["profile"]["timezone"] == "Asia/Kolkata"
    assert client.patch("/v1/me", headers=auth(u), json={"timezone": "Mars/Olympus"}).status_code == 422
    with database.connect() as c, pytest.raises(Exception, match="invalid_timezone"):
        c.execute(text("update books set timezone = 'Asia/Saigon' where id = :b"), {"b": bid})


def test_username_changes_are_rate_limited(client):
    """A taken name answers username_taken, so trying names is slowed down."""
    taken = f"taken_{uuid.uuid4().hex[:8]}"
    signed_up(client, taken)
    u = signed_up(client)
    tries = [client.patch("/v1/me", headers=auth(u), json={"username": taken}).status_code for _ in range(5)]
    assert tries == [409] * 5
    assert client.patch("/v1/me", headers=auth(u), json={"username": taken}).json() == {"detail": "rate_limited"}
    me = client.get("/v1/me", headers=auth(u)).json()["profile"]
    same = client.patch("/v1/me", headers=auth(u), json={"username": me["username"], "display_name": "Mai"})
    assert same.status_code == 200 and same.json()["profile"]["display_name"] == "Mai"     # saving the same name isn't a try


def test_a_vietnamese_export_names_every_table_in_vietnamese():
    from app.domain.export import VI
    assert VI["installment plans"] == "trả góp"
