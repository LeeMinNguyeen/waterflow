"""Tests that need a fresh server (setup, the migration runner) build their own database."""
import json
import logging
import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from psycopg.conninfo import make_conninfo
import pyotp
import pytest
from sqlalchemy import create_engine, text

from conftest import ADMIN_URL

PASSWORD = "correct horse battery"


@pytest.fixture(scope="module")
def client(database):
    from fastapi.testclient import TestClient

    from app.api.main import app
    from app.core import sign_in
    saved = sign_in.sign_ups_per_ip, sign_in.per_ip
    sign_in.sign_ups_per_ip = sign_in.per_ip = sign_in.RateLimit(100_000, 60)
    yield TestClient(app)
    sign_in.sign_ups_per_ip, sign_in.per_ip = saved


@pytest.fixture
def invite_only(database):
    with database.connect() as c:
        c.execute(text("update instance_settings set signup = 'invite'"))
    yield
    with database.connect() as c:
        c.execute(text("update instance_settings set signup = 'open'"))


@pytest.fixture
def admin(client, database):
    """An admin account (made directly: setup itself is tested on a fresh server below)."""
    name, token = sign_up(client)
    with database.connect() as c:
        c.execute(text("update users set is_admin = true where username = :n"), {"n": name})
    return name, token


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def sign_up(client, name=None, password=PASSWORD, status=201, headers=None, **extra):
    name = name or f"u{uuid.uuid4().hex[:10]}"
    r = client.post("/v1/auth/sign-up", json={"username": name, "password": password, **extra}, headers=headers)
    assert r.status_code == status, r.text
    return (name, r.json()["token"]) if status == 201 else r.json()


def sign_in(client, name, password=PASSWORD, code=None):
    return client.post("/v1/auth/sign-in", json={"username": name, "password": password, "code": code})


def me(client, token):
    return client.get("/v1/me", headers=bearer(token))


def test_invite_only_server_needs_an_invite(client, admin, invite_only):
    assert client.get("/v1/instance").json()["signup"] == "invite"
    assert sign_up(client, status=403) == {"detail": "invite_required"}
    assert sign_up(client, status=403, invite_code="AAAA-BBBB") == {"detail": "invite_invalid"}

    _, admin_token = admin
    inv = client.post("/v1/admin/invites", headers=bearer(admin_token),
                      json={"note": "Lan", "days": 3, "server": "https://money.example.com"})
    assert inv.status_code == 201
    code = inv.json()["code"]
    assert inv.json()["link"] == f"https://money.example.com/join?code={code}" and inv.json()["qr"].startswith("data:image/svg")
    bad_server = client.post("/v1/admin/invites", headers=bearer(admin_token), json={"server": "https://x/y?z"})
    assert bad_server.status_code == 422
    assert len(code) == 9 and code[4] == "-"
    assert client.post("/v1/auth/invite-check", json={"code": code.lower()}).json() == {"valid": True}

    name, token = sign_up(client, invite_code=code.lower().replace("-", " "))   # typed loosely: still the code
    assert me(client, token).json()["profile"]["is_admin"] is False
    assert client.post("/v1/auth/invite-check", json={"code": code}).json() == {"valid": False}   # one use
    assert sign_up(client, status=403, invite_code=code) == {"detail": "invite_invalid"}
    listed = client.get("/v1/admin/invites", headers=bearer(admin_token)).json()
    mine = next(i for i in listed if i["id"] == inv.json()["id"])
    assert (mine["note"], mine["used_by_username"]) == ("Lan", name)


def test_revoked_and_expired_invites(client, admin, invite_only, database):
    _, admin_token = admin
    revoked = client.post("/v1/admin/invites", headers=bearer(admin_token), json={}).json()
    assert client.delete(f"/v1/admin/invites/{revoked['id']}", headers=bearer(admin_token)).status_code == 204
    assert sign_up(client, status=403, invite_code=revoked["code"]) == {"detail": "invite_invalid"}
    expired = client.post("/v1/admin/invites", headers=bearer(admin_token), json={}).json()
    with database.connect() as c:
        c.execute(text("update invites set expires_at = now() - interval '1 minute' where id = :i"), {"i": expired["id"]})
    assert sign_up(client, status=403, invite_code=expired["code"]) == {"detail": "invite_invalid"}


def test_admin_can_open_sign_up(client, admin, invite_only):
    _, admin_token = admin
    assert client.patch("/v1/admin/instance", headers=bearer(admin_token), json={"signup": "open", "name": "Nhà"}).status_code == 204
    assert client.get("/v1/instance").json() | {"server_version": None} == {
        "name": "Nhà", "signup": "open", "api_version": 1, "setup_needed": False, "server_version": None, "account_purge": "on"}
    sign_up(client)
    client.patch("/v1/admin/instance", headers=bearer(admin_token), json={"name": "Waterflow"})


def test_only_the_admin_has_admin_tools(client, admin):
    _, token = sign_up(client)
    for method, path, body in (("get", "/v1/admin/users", None), ("get", "/v1/admin/invites", None),
                               ("post", "/v1/admin/invites", {}), ("patch", "/v1/admin/instance", {"signup": "open"})):
        r = client.request(method, path, headers=bearer(token), json=body)
        assert (r.status_code, r.json()) == (403, {"detail": "admin_only"}), path


def test_nobody_can_make_themselves_admin(client, database):
    _, token = sign_up(client)
    uid = me(client, token).json()["id"]
    from app.core import db
    with pytest.raises(Exception, match="permission denied"):
        with db.user_session(uuid.UUID(uid)) as s:
            s.execute(text("update users set is_admin = true where id = :u"), {"u": uid})


def test_sign_in_and_wrong_credentials(client):
    name, _ = sign_up(client)
    for bad in (sign_in(client, name, "wrong password!"), sign_in(client, f"nobody_{uuid.uuid4().hex[:6]}")):
        assert (bad.status_code, bad.json()) == (401, {"detail": "invalid_credentials"})   # same answer for both
    ok = sign_in(client, name.upper())
    assert ok.status_code == 200 and me(client, ok.json()["token"]).json()["profile"]["username"] == name


@pytest.mark.parametrize("body", [
    {"username": "shortpass", "password": "123456789"},          # under 10 characters
    {"username": "-bad", "password": PASSWORD},
    {"username": "ab", "password": PASSWORD},
])
def test_sign_up_rejects_bad_input(client, body):
    assert client.post("/v1/auth/sign-up", json=body).status_code == 422


def test_username_taken(client):
    name, _ = sign_up(client)
    assert sign_up(client, name=name.upper(), status=409) == {"detail": "username_taken"}


def test_tokens_are_stored_hashed(client, database):
    _, token = sign_up(client)
    with database.connect() as c:
        stored = c.execute(text("select count(*) from sessions where token_sha256 = sha256(convert_to(:t, 'utf8'))"),
                           {"t": token}).scalar()
        raw = c.execute(text("select count(*) from sessions where position(convert_to(:t, 'utf8') in token_sha256) > 0"),
                        {"t": token}).scalar()
    assert (stored, raw) == (1, 0)


def test_expired_sessions_are_refused(client, database):
    _, token = sign_up(client)
    with database.connect() as c:
        c.execute(text("update sessions set last_used_at = now() - interval '31 days'"
                       " where token_sha256 = sha256(convert_to(:t, 'utf8'))"), {"t": token})
    assert me(client, token).status_code == 401


def test_sign_out_and_sign_out_others(client):
    name, first = sign_up(client)
    second = sign_in(client, name).json()["token"]
    third = sign_in(client, name).json()["token"]
    assert client.post("/v1/auth/sign-out", headers=bearer(first)).status_code == 204
    assert me(client, first).status_code == 401
    assert client.post("/v1/auth/sign-out-others", headers=bearer(second)).status_code == 204
    assert me(client, third).status_code == 401 and me(client, second).status_code == 200


def test_change_password_signs_out_other_devices(client):
    name, token = sign_up(client)
    other = sign_in(client, name).json()["token"]
    wrong = client.post("/v1/auth/password", headers=bearer(token),
                        json={"current_password": "not it at all", "new_password": "a new password"})
    assert (wrong.status_code, wrong.json()) == (401, {"detail": "invalid_credentials"})
    assert client.post("/v1/auth/password", headers=bearer(token),
                       json={"current_password": PASSWORD, "new_password": "a new password"}).status_code == 204
    assert me(client, other).status_code == 401 and me(client, token).status_code == 200
    assert sign_in(client, name).status_code == 401 and sign_in(client, name, "a new password").status_code == 200


CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
SAFARI_IPHONE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)"
                 " Version/18.6 Mobile/15E148 Safari/604.1")


def test_signed_in_devices(client, database):
    """A user sees where they're signed in, this device first, and signs out one other device."""
    name, laptop = sign_up(client, headers={"User-Agent": CHROME_WINDOWS})
    phone = client.post("/v1/auth/sign-in", json={"username": name, "password": PASSWORD},
                        headers={"User-Agent": SAFARI_IPHONE}).json()["token"]
    script = sign_in(client, name).json()["token"]                          # no browser: no label
    _, stranger = sign_up(client)

    listed = client.get("/v1/auth/sessions", headers=bearer(phone)).json()
    assert [(s["device"], s["current"]) for s in listed][:1] == [("Safari · iOS", True)]
    assert sorted((s["device"] or "", s["current"]) for s in listed) == [
        ("", False), ("Chrome · Windows", False), ("Safari · iOS", True)]
    assert set(listed[0]) == {"id", "device", "created_at", "last_used_at", "current"}   # never a token or its hash
    assert [s["current"] for s in client.get("/v1/auth/sessions", headers=bearer(stranger)).json()] == [True]  # only theirs

    chrome = next(s["id"] for s in listed if s["device"] == "Chrome · Windows")
    assert client.delete(f"/v1/auth/sessions/{chrome}", headers=bearer(stranger)).json() == {"detail": "not_found"}
    assert me(client, laptop).status_code == 200
    assert client.delete(f"/v1/auth/sessions/{chrome}", headers=bearer(phone)).status_code == 204
    assert me(client, laptop).status_code == 401 and me(client, script).status_code == 200
    assert client.delete(f"/v1/auth/sessions/{uuid.uuid4()}", headers=bearer(phone)).status_code == 404

    # A session unused for 30 days isn't a device any more, even before the daily purge deletes it.
    with database.connect() as c:
        c.execute(text("update sessions set last_used_at = now() - interval '31 days'"
                       " where token_sha256 = sha256(convert_to(:t, 'utf8'))"), {"t": script})
    assert [s["device"] for s in client.get("/v1/auth/sessions", headers=bearer(phone)).json()] == ["Safari · iOS"]


def test_idle_sign_out(client, database):
    """Each user's sessions end after so many minutes unused, 5 by default, or their own choice,
    never included (30 days); nobody else's setting touches them."""
    name, token = sign_up(client)
    other = sign_in(client, name).json()["token"]
    _, neighbour = sign_up(client)
    assert me(client, token).json()["profile"]["idle_sign_out_minutes"] == 5            # the default
    assert client.patch("/v1/me", headers=bearer(neighbour), json={"idle_sign_out_minutes": 60}).status_code == 200
    for bad in (0, 61, 1440, "five"):                                     # 1 to 60, or never
        assert client.patch("/v1/me", headers=bearer(token), json={"idle_sign_out_minutes": bad}).status_code == 422

    def unused_for(t, minutes):
        with database.connect() as c:
            c.execute(text("update sessions set last_used_at = now() - make_interval(mins => :m)"
                           " where token_sha256 = sha256(convert_to(:t, 'utf8'))"), {"t": t, "m": minutes})

    assert client.patch("/v1/me", headers=bearer(token), json={"language": "en"}).json()["profile"][
        "idle_sign_out_minutes"] == 5                                     # left out: kept
    assert "idle_sign_out_minutes" not in client.get("/v1/instance").json()   # not a server setting
    unused_for(token, 5)                     # kept to the minute, so a minute's grace: still signed in
    assert me(client, token).status_code == 200
    unused_for(token, 7)
    assert me(client, token).status_code == 401
    unused_for(neighbour, 7)                 # someone else's sessions: their own 60 minutes
    assert me(client, neighbour).status_code == 200
    unused_for(other, 7)                     # not listed, then deleted by the daily purge
    third = sign_in(client, name).json()["token"]
    assert [s["current"] for s in client.get("/v1/auth/sessions", headers=bearer(third)).json()] == [True]
    with database.connect() as c:
        c.execute(text("select purge_expired_sign_in()"))
        left = c.execute(text("select count(*) from sessions s join users u on u.id = s.user_id where u.username = :n"),
                         {"n": name}).scalar()
    assert left == 1
    assert client.patch("/v1/me", headers=bearer(third), json={"idle_sign_out_minutes": None}).json()["profile"][
        "idle_sign_out_minutes"] is None
    unused_for(third, 7 * 24 * 60)           # off again: 30 days
    assert me(client, third).status_code == 200


@pytest.mark.parametrize("agent, label", [
    (CHROME_WINDOWS, "Chrome · Windows"),
    (SAFARI_IPHONE, "Safari · iOS"),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
     "Safari · macOS"),
    ("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox · Linux"),
    ("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
     "Chrome · Android"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
     " Edg/141.0.0.0", "Edge · Windows"),
    ("Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0"
     " Chrome/130.0.0.0 Mobile Safari/537.36", "Samsung Internet · Android"),
    ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0"
     " Mobile/15E148 Safari/604.1", "Chrome · iOS"),
    ("Waterflow/1.0 (Android 15)", "Waterflow · Android"),
    ("python-httpx/0.28.1", None),
    (None, None),
])
def test_device_label(agent, label):
    from app.core.sign_in import device_label
    assert device_label(agent) == label


OWNER = None


@pytest.fixture(autouse=True)
def _owner(database):
    global OWNER
    OWNER = database


def totp(secret):
    """The current code, as if no step had been used yet: each code works once, and these tests use several a step."""
    with OWNER.connect() as c:
        c.execute(text("update local_credentials set totp_last_step = null"))
    return pyotp.TOTP(secret).now()


def test_a_two_step_code_works_once(client):
    """RFC 6238 §5.2: a code accepted once is refused after, in its step and any earlier one; a later step's works."""
    import time
    name, token = sign_up(client)
    secret = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()["secret"]
    now = pyotp.TOTP(secret).now()
    assert client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": now}).status_code == 200
    assert sign_in(client, name, code=now).json() == {"detail": "invalid_code"}         # the code that turned it on
    later = pyotp.TOTP(secret).at(time.time() + 30)
    assert sign_in(client, name, code=later).status_code == 200
    assert sign_in(client, name, code=later).json() == {"detail": "invalid_code"}
    assert client.post("/v1/auth/two-factor/disable", headers=bearer(token), json={"code": now}).status_code == 422
    assert sign_in(client, name, code=pyotp.TOTP(secret).at(time.time() - 30)).json() == {"detail": "invalid_code"}
    twice = client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": now})
    assert (twice.status_code, twice.json()) == (409, {"detail": "two_factor_on"})


def test_a_two_step_code_in_wide_digits_works(client):
    """An input method in full-width mode types １２３４５６: read as 123456, as before."""
    name, token = sign_up(client)
    secret = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()["secret"]
    client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": totp(secret)})
    wide = "".join(chr(ord(c) + 0xFEE0) for c in totp(secret))
    assert sign_in(client, name, code=wide).status_code == 200
    assert sign_in(client, name, code="١٢٣٤٥٦").json() == {"detail": "invalid_code"}


def test_two_factor_with_recovery_codes(client):
    name, token = sign_up(client)
    assert client.get("/v1/auth/two-factor", headers=bearer(token)).json() == {"enabled": False, "recovery_codes_left": 0}
    setup = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()
    assert setup["uri"].startswith("otpauth://totp/Waterflow:") and setup["qr"].startswith("data:image/svg+xml;base64,")
    secret = setup["secret"]
    bad = client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": "000000"})
    assert (bad.status_code, bad.json()) == (422, {"detail": "invalid_code"})
    codes = client.post("/v1/auth/two-factor/enable", headers=bearer(token),
                        json={"secret": secret, "code": totp(secret)}).json()["recovery_codes"]
    assert len(codes) == 10 and len(set(codes)) == 10

    assert sign_in(client, name).json() == {"detail": "code_required"}
    assert sign_in(client, name, code="123456").json() == {"detail": "invalid_code"}
    assert sign_in(client, name, "wrong password!", code=totp(secret)).json() == {"detail": "invalid_credentials"}
    assert sign_in(client, name, code=totp(secret)).status_code == 200
    assert sign_in(client, name, code=codes[0]).status_code == 200                      # a recovery code works once
    assert sign_in(client, name, code=codes[0]).json() == {"detail": "invalid_code"}
    assert client.get("/v1/auth/two-factor", headers=bearer(token)).json() == {"enabled": True, "recovery_codes_left": 9}

    fresh = client.post("/v1/auth/two-factor/recovery-codes", headers=bearer(token),
                        json={"code": totp(secret)}).json()["recovery_codes"]
    assert sign_in(client, name, code=codes[1]).json() == {"detail": "invalid_code"}    # the old ones stopped working
    assert sign_in(client, name, code=fresh[0]).status_code == 200

    assert client.post("/v1/auth/two-factor/disable", headers=bearer(token), json={"code": "123456"}).status_code == 422
    assert client.post("/v1/auth/two-factor/disable", headers=bearer(token),
                       json={"code": totp(secret)}).status_code == 204
    assert sign_in(client, name).status_code == 200


def test_two_step_on_again_needs_turning_off_first(client):
    """A session left open somewhere can't swap the secret and the recovery codes."""
    name, token = sign_up(client)
    first = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()["secret"]
    client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": first, "code": totp(first)})
    second = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()["secret"]
    again = client.post("/v1/auth/two-factor/enable", headers=bearer(token),
                        json={"secret": second, "code": totp(second)})
    assert (again.status_code, again.json()) == (409, {"detail": "two_factor_on"})
    assert sign_in(client, name, code=totp(first)).status_code == 200


def test_sign_up_without_a_way_in_never_says_whether_a_username_exists(client, admin, invite_only):
    """With no invite on an invite-only server, a taken username and a free one get the same answer."""
    taken, _ = admin
    plain = client.post("/v1/auth/sign-up", json={"username": taken, "password": PASSWORD})
    assert (plain.status_code, plain.json()) == (403, {"detail": "invite_required"})
    made_up = client.post("/v1/auth/sign-up", json={"username": taken, "password": PASSWORD, "invite_code": "AAAA-BBBB"})
    assert (made_up.status_code, made_up.json()) == (403, {"detail": "invite_invalid"})


def test_database_errors_and_refused_requests_log_no_values(client, caplog):
    """Neither a database error's values (a TOTP secret, a password hash) nor a refused request's input (a password)."""
    from app.core.db import engine
    assert engine.hide_parameters
    with caplog.at_level(logging.INFO):
        r = client.post("/v1/auth/sign-up", json={"username": "shortpass", "password": "sentinel1"})
    assert r.status_code == 422 and "invalid request" in caplog.text and "sentinel1" not in caplog.text


def test_operator_commands_refuse_accounts_they_cannot_help(client, database, monkeypatch):
    """make-admin on a closing account and reset-password on a disabled one refuse, as neither would work."""
    from app import admin as commands
    monkeypatch.setattr(commands, "admin_url", lambda: database.url.set(drivername="postgresql").render_as_string(hide_password=False))
    closing, _ = sign_up(client)
    disabled, _ = sign_up(client)
    with database.connect() as c:
        c.execute(text("update users set deletion_requested_at = now() where username = :n"), {"n": closing})
        c.execute(text("update users set disabled_at = now() where username = :n"), {"n": disabled})
    with pytest.raises(SystemExit, match="closing"):
        commands.make_admin(closing)
    with pytest.raises(SystemExit, match="disabled"):
        commands.reset_password(disabled)
    with database.connect() as c:
        assert not c.execute(text("select is_admin from users where username = :n"), {"n": closing}).scalar()
        assert not c.execute(text("select count(*) from password_resets r join users u on u.id = r.user_id"
                                  " where u.username = :n"), {"n": disabled}).scalar()


def test_remembered_device_skips_the_code_until_cancelled(client, admin, database, monkeypatch):
    """R-AUTH-10: "remember this device" skips the two-factor code there, never the password, for 30 days. A new
    password, two-factor turned off, an admin's reset link and "sign out other devices" (but this one) cancel it."""
    from app.core import sign_in as si
    monkeypatch.setattr(si, "per_username", si.RateLimit(100, 60))
    name, token = sign_up(client)
    uid = me(client, token).json()["id"]
    secret = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()["secret"]
    client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": totp(secret)})
    password = PASSWORD

    def remember():
        body = {"username": name, "password": password, "code": totp(secret), "remember_device": True}
        return client.post("/v1/auth/sign-in", json=body).json()["device_token"]

    def with_device(device_token, password_typed=None):
        body = {"username": name, "password": password_typed or password, "device_token": device_token}
        return client.post("/v1/auth/sign-in", json=body)

    def remembered():
        with database.connect() as c:
            return c.execute(text("select count(*) from remembered_devices where user_id = :u"), {"u": uid}).scalar()

    assert sign_in(client, name, code=totp(secret)).json()["device_token"] is None
    laptop, phone, tablet = remember(), remember(), remember()
    assert with_device(laptop).status_code == 200
    assert with_device(laptop, "wrong password!").json() == {"detail": "invalid_credentials"}
    assert with_device("not-a-token").json() == {"detail": "code_required"}
    other, _ = sign_up(client)
    assert client.post("/v1/auth/sign-in", json={"username": other, "password": PASSWORD, "device_token": laptop}).status_code == 200

    with database.connect() as c:                                  # 30 days later
        c.execute(text("update remembered_devices set expires_at = now() - interval '1 second'"
                       " where token_sha256 = sha256(convert_to(:t, 'utf8'))"), {"t": phone})
    assert with_device(phone).json() == {"detail": "code_required"}

    here = with_device(laptop).json()["token"]
    assert client.post("/v1/auth/sign-out-others", headers=bearer(here), json={"device_token": laptop}).status_code == 204
    assert with_device(laptop).status_code == 200 and with_device(tablet).json() == {"detail": "code_required"}

    new_password = "another long password"
    assert client.post("/v1/auth/password", headers=bearer(here),
                       json={"current_password": password, "new_password": new_password}).status_code == 204
    password = new_password
    assert remembered() == 0 and with_device(laptop).json() == {"detail": "code_required"}

    remember()
    assert client.post("/v1/auth/two-factor/disable", headers=bearer(here), json={"code": totp(secret)}).status_code == 204
    assert remembered() == 0

    client.post("/v1/auth/two-factor/enable", headers=bearer(here), json={"secret": secret, "code": totp(secret)})
    remember()
    _, admin_token = admin
    link = client.post(f"/v1/admin/users/{uid}/reset", headers=bearer(admin_token)).json()
    assert client.post("/v1/auth/reset", json={"token": link["token"], "new_password": "a third long password"}).status_code == 200
    assert remembered() == 0

    with database.connect() as c:                                  # the daily purge: past their 30 days
        c.execute(text("insert into remembered_devices (token_sha256, user_id, expires_at)"
                       " values (sha256('old'::bytea), :u, now() - interval '1 day')"), {"u": uid})
        c.execute(text("select purge_expired_sign_in()"))
    assert remembered() == 0


def test_rate_limits(client):
    from app.core import sign_in as si
    name, _ = sign_up(client)
    saved, si.per_username = si.per_username, si.RateLimit(3, 60)
    try:
        assert [sign_in(client, name, "wrong password!").status_code for _ in range(4)] == [401, 401, 401, 429]
        assert sign_in(client, name).json() == {"detail": "rate_limited"}      # even with the right password
    finally:
        si.per_username = saved
    saved, si.sign_ups_per_ip = si.sign_ups_per_ip, si.RateLimit(1, 60)
    try:
        sign_up(client)
        assert sign_up(client, status=429) == {"detail": "rate_limited"}
    finally:
        si.sign_ups_per_ip = saved


def test_admin_disables_and_resets(client, admin):
    _, admin_token = admin
    name, token = sign_up(client)
    uid = me(client, token).json()["id"]
    users = {u["username"]: u for u in client.get("/v1/admin/users", headers=bearer(admin_token)).json()}
    assert users[name]["disabled_at"] is None and users[name]["two_factor"] is False and users[name]["last_seen_at"]

    assert client.post(f"/v1/admin/users/{uid}/disable", headers=bearer(admin_token), json={"disabled": True}).status_code == 204
    assert me(client, token).status_code == 401                                    # signed out at once
    assert sign_in(client, name).json() == {"detail": "invalid_credentials"}
    assert client.post(f"/v1/admin/users/{uid}/disable", headers=bearer(admin_token), json={"disabled": False}).status_code == 204
    token = sign_in(client, name).json()["token"]

    admin_id = me(client, admin_token).json()["id"]
    selfie = client.post(f"/v1/admin/users/{admin_id}/disable", headers=bearer(admin_token), json={"disabled": True})
    assert (selfie.status_code, selfie.json()) == (409, {"detail": "admin_self"})

    # Forgot the password and lost the phone: the admin's reset link.
    secret = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()["secret"]
    client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": totp(secret)})
    link = client.post(f"/v1/admin/users/{uid}/reset", headers=bearer(admin_token)).json()
    assert datetime.fromisoformat(link["expires_at"]) > datetime.now(timezone.utc)
    weak = client.post("/v1/auth/reset", json={"token": link["token"], "new_password": "short"})
    assert weak.status_code == 422
    new = client.post("/v1/auth/reset", json={"token": link["token"], "new_password": "brand new password"})
    assert new.status_code == 200 and me(client, new.json()["token"]).status_code == 200
    assert me(client, token).status_code == 401                                    # every old session ended
    assert sign_in(client, name, "brand new password").status_code == 200          # and two-factor is off
    again = client.post("/v1/auth/reset", json={"token": link["token"], "new_password": "another password"})
    assert (again.status_code, again.json()) == (403, {"detail": "reset_invalid"})


def test_purge_removes_sign_in(client, database):
    name, token = sign_up(client)
    uid = me(client, token).json()["id"]
    with database.connect() as c:
        c.execute(text("update users set deletion_requested_at = now() - interval '31 days' where id = :u"), {"u": uid})
        assert uuid.UUID(uid) in {r[0] for r in c.execute(text("select * from purge_deleted_accounts()"))}
    assert me(client, token).status_code == 401 and sign_in(client, name).status_code == 401


@pytest.fixture
def fresh_server(monkeypatch):
    """A new, empty database built by the server's own runner, with the API pointed at it."""
    from app.jobs import migrate
    name = f"fresh_{uuid.uuid4().hex[:8]}"
    admin = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'create database "{name}"'))
    url = ADMIN_URL.set(drivername="postgresql", database=name).render_as_string(hide_password=False)
    passwords = {login: "p" + uuid.uuid4().hex for login in migrate.LOGINS}
    try:
        yield url, passwords
    finally:
        from app.core import db
        db.engine.dispose()
        with admin.connect() as c:
            c.execute(text(f'drop database "{name}" with (force)'))
            for login in migrate.LOGINS:
                c.execute(text(f"drop role if exists {login}"))


def test_migrate_builds_a_server_and_is_safe_to_repeat(fresh_server):
    from app.jobs import migrate
    url, passwords = fresh_server
    backups = []
    applied, code = migrate.run(url, passwords, before_migrating=lambda: backups.append(1))
    assert applied == [m.name for m in sorted(migrate.MIGRATIONS.glob("*.sql"))] and backups == []   # nothing to back up yet
    assert code and len(code) == 14                                                 # XXXX-XXXX-XXXX
    applied2, code2 = migrate.run(url, passwords, before_migrating=lambda: backups.append(1))
    assert applied2 == [] and backups == [] and code2 != code                       # a new code each start
    with psycopg.connect(url) as conn:
        roles = dict(conn.execute(
            "select m.rolname, r.rolname from pg_auth_members a join pg_roles r on r.oid = a.roleid"
            " join pg_roles m on m.oid = a.member where m.rolname in ('api_login', 'purge_login', 'fx_login')"))
        assert roles == {"api_login": "app_user", "purge_login": "account_purger", "fx_login": "fx_updater"}
        assert not conn.execute("select bool_or(rolbypassrls or rolsuper) from pg_roles"
                                " where rolname in ('api_login', 'purge_login', 'fx_login')").fetchone()[0]
        # A later update with a new migration backs up first, then applies it.
        last = conn.execute("delete from waterflow.migrations where version = (select max(version) from waterflow.migrations)"
                            " returning name").fetchone()[0]
        conn.commit()
    applied3, _ = migrate.run(url, passwords, before_migrating=lambda: backups.append(1))
    assert backups == [1] and len(applied3) == 1 and last in applied3[0]


def test_a_server_from_before_the_rename_keeps_its_migrations(fresh_server):
    """Servers made while the app was named MSaving keep the applied migrations in the schema msaving: the next
    start renames it, applies nothing again and takes no backup."""
    from app.jobs import migrate
    url, passwords = fresh_server
    migrate.run(url, passwords)
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("alter schema waterflow rename to msaving")
    backups = []
    applied, _ = migrate.run(url, passwords, before_migrating=lambda: backups.append(1))
    assert applied == [] and backups == []
    with psycopg.connect(url) as conn:
        assert conn.execute("select to_regnamespace('msaving') is null, to_regnamespace('waterflow') is not null"
                            ).fetchone() == (True, True)


def test_the_old_default_server_name_becomes_waterflow(fresh_server):
    from app.jobs import migrate
    url, _ = fresh_server
    with psycopg.connect(url, autocommit=True) as conn:
        pending = migrate.pending(conn)
        rename = next(i for i, m in enumerate(pending) if m.name.endswith("_waterflow.sql"))
        for migration in pending[:rename]:
            migrate.apply(conn, migration)
        assert conn.execute("select name from instance_settings").fetchone()[0] == "MSaving"
        migrate.apply(conn, pending[rename])
        assert conn.execute("select name from instance_settings").fetchone()[0] == "Waterflow"


@pytest.fixture
def handed_over(fresh_server):
    """Hands a database to an owner of its own name, and drops that role afterwards."""
    from app.jobs import migrate, owner
    from app.launch import login_url
    url, passwords = fresh_server
    role = f"wf_owner_{uuid.uuid4().hex[:8]}"
    try:
        yield url, passwords, role, lambda: (owner.hand_over(url, "pw", role), login_url(url, role, "pw", "postgresql"))[1]
    finally:
        with psycopg.connect(url, autocommit=True) as conn:
            if conn.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone():
                conn.execute(f"reassign owned by {role} to current_user")
                conn.execute(f"drop owned by {role}")
                for login, group in migrate.LOGINS.items():
                    if conn.execute("select 1 from pg_roles where rolname = %s", (login,)).fetchone():
                        conn.execute(f"revoke {group} from {login} granted by {role}")
                conn.execute(f"drop role {role}")


def _not_the_owners(conn, role):
    return conn.execute("""
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'waterflow') and c.relkind in ('r', 'v', 'S', 'm') and c.relowner <> %(r)s::regrole
        union all
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'waterflow') and p.proowner <> %(r)s::regrole
           and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        union all
        select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
         where n.nspname in ('public', 'waterflow') and t.typtype in ('e', 'd') and t.typowner <> %(r)s::regrole
        union all
        select nspname from pg_namespace where nspname in ('public', 'waterflow') and nspowner <> %(r)s::regrole
        union all
        select extname from pg_extension where extname = 'pgcrypto' and extowner <> %(r)s::regrole""", {"r": role}).fetchall()


def test_an_existing_built_in_database_is_handed_to_an_owner_that_is_no_superuser(handed_over, tmp_path):
    """R-SEC-8: a server built by the superuser (every compose install before this) gives everything to a role that
    isn't one, once; from then on the migrations, the logins, the backup and a restore all work as that role, and
    what it makes later keeps the defaults (no EXECUTE for PUBLIC)."""
    from app.jobs import backup, migrate, restore
    url, passwords, role, hand_over = handed_over
    migrate.run(url, passwords)
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("update instance_settings set signup = 'open'")
        conn.execute("insert into users (id, username) values (gen_random_uuid(), 'before')")
    as_owner = hand_over()
    assert hand_over() == as_owner                                              # every start: nothing left to do
    with psycopg.connect(url) as conn:
        assert _not_the_owners(conn, role) == []
        assert conn.execute("select rolsuper or rolbypassrls or rolcreatedb, rolcreaterole from pg_roles where rolname = %s",
                            (role,)).fetchone() == (False, True)
    assert migrate.run(as_owner, passwords)[0] == []                            # the logins' passwords, as the owner
    with psycopg.connect(as_owner, autocommit=True) as conn:
        assert conn.execute("select current_user").fetchone()[0] == role
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(f"alter role {role} superuser")
        conn.execute("create function made_later() returns int language sql as 'select 1'")
        assert not conn.execute("select has_function_privilege('public', 'made_later()', 'execute')").fetchone()[0]
        conn.execute("drop function made_later()")
        assert conn.execute("select username from users").fetchall() == [("before",)]
    (tmp_path / "backups").mkdir()
    dump, tables, _ = backup.run_backup(as_owner, str(tmp_path / "backups"))
    assert tables["public"] > 10
    with psycopg.connect(as_owner, autocommit=True) as conn:
        conn.execute("insert into users (id, username) values (gen_random_uuid(), 'after')")
    restore._apply(as_owner, dump, None, str(tmp_path / "purged.jsonl"))
    with psycopg.connect(url) as conn:
        assert conn.execute("select username from users").fetchall() == [("before",)]
        assert _not_the_owners(conn, role) == []
    assert migrate.run(as_owner, passwords)[0] == []


def test_a_new_built_in_database_is_built_by_an_owner_that_is_no_superuser(handed_over):
    from app.jobs import migrate
    url, passwords, role, hand_over = handed_over
    as_owner = hand_over()
    applied, setup_code = migrate.run(as_owner, passwords)
    assert len(applied) > 10 and setup_code
    with psycopg.connect(url) as conn:
        assert _not_the_owners(conn, role) == []
        assert not conn.execute("select has_function_privilege('public', 'am_admin()', 'execute')").fetchone()[0]


def test_the_launcher_uses_the_owner_on_the_built_in_database_only(handed_over, tmp_path, monkeypatch, capsys):
    from app import launch
    from app.jobs import owner
    url, _, role, _ = handed_over
    monkeypatch.setattr(launch, "OWNER_PASSWORD", tmp_path / "owner_password")
    monkeypatch.setenv("ADMIN_DATABASE_URL", url)
    assert launch.as_owner(url, role) == url and not (tmp_path / "owner_password").exists()     # the operator's own database
    monkeypatch.delenv("ADMIN_DATABASE_URL")
    as_owner = launch.as_owner(url, role)
    assert (tmp_path / "owner_password").stat().st_mode & 0o777 == 0o600
    with psycopg.connect(as_owner) as conn:
        assert conn.execute("select current_user, (select rolsuper from pg_roles where rolname = current_user)").fetchone() == (role, False)
    assert launch.as_owner(url, role) == as_owner
    # What the owner makes through a role of its own can't put a statement into the superuser's hand-over, even one
    # PostgreSQL can't name (a procedure and its twin with an OUT argument).
    helper = role + "_h"
    with psycopg.connect(as_owner, autocommit=True) as conn:
        conn.execute(f"create role {helper}")
        conn.execute(f"grant {helper} to {role} with set true")
        conn.execute(f"grant create, usage on schema public to {helper}")
        conn.execute(f"set role {helper}")
        conn.execute("create procedure zz(a int) language sql as 'select 1'")
        conn.execute("create procedure zz(out a int) language sql as 'select 1'")
    try:
        assert launch.as_owner(url, role) == as_owner and "WARNING" not in capsys.readouterr().out
        # Once the owner exists, a hand-over that fails never puts the server back on the superuser.
        real = owner.hand_over
        monkeypatch.setattr(owner, "hand_over", lambda *a: (_ for _ in ()).throw(psycopg.errors.InsufficientPrivilege("no")))
        assert launch.as_owner(url, role) == as_owner
        assert "the hand-over to" in capsys.readouterr().out
        monkeypatch.setattr(owner, "hand_over", real)
    finally:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(f"drop owned by {helper}")
            conn.execute(f"drop role {helper}")


def test_a_first_hand_over_that_fails_leaves_the_server_as_it_was(handed_over, tmp_path, monkeypatch, capsys):
    from app import launch
    from app.jobs import owner
    url, _, role, _ = handed_over
    monkeypatch.setattr(launch, "OWNER_PASSWORD", tmp_path / "owner_password")
    monkeypatch.delenv("ADMIN_DATABASE_URL", raising=False)
    monkeypatch.setattr(owner, "hand_over", lambda *a: (_ for _ in ()).throw(psycopg.errors.InsufficientPrivilege("no")))
    assert launch.as_owner(url, role) == url
    assert "still run as its superuser" in capsys.readouterr().out


def test_logins_are_set_again_by_an_owner_that_is_no_superuser(fresh_server):
    """Supabase's owner isn't a superuser, and since PostgreSQL 16 only a superuser may name SUPERUSER or BYPASSRLS
    in ALTER ROLE. Such an owner (CREATEROLE, with admin option on the logins and roles it made) sets the passwords
    again on every start, and a login someone made a superuser is refused loudly."""
    from app.jobs import migrate
    url, passwords = fresh_server
    migrate.run(url, passwords)
    owner = f"owner_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(f"create role {owner} login createrole password 'pw'")
        for role in [*migrate.LOGINS, *migrate.LOGINS.values()]:
            conn.execute(f"grant {role} to {owner} with admin option, inherit false, set false")
    as_owner = make_conninfo(url, user=owner, password="pw")
    new = {login: "n" + uuid.uuid4().hex for login in migrate.LOGINS}

    def hashes():
        with psycopg.connect(url) as conn:
            return dict(conn.execute("select rolname, rolpassword from pg_authid where rolname = any(%s)",
                                     (list(migrate.LOGINS),)).fetchall())
    try:
        before = hashes()
        with psycopg.connect(as_owner, autocommit=True) as conn:
            migrate.set_logins(conn, new)
        after = hashes()
        assert all(after[login] != before[login] for login in migrate.LOGINS)       # each got its new password
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute("alter role fx_login bypassrls")
        with psycopg.connect(as_owner, autocommit=True) as conn, \
                pytest.raises(psycopg.errors.InsufficientPrivilege, match="permission denied to alter role"):
            migrate.set_logins(conn, new)
        migrate.run(url, passwords)                                                 # a superuser owner turns it off
        with psycopg.connect(url) as conn:
            assert not conn.execute("select rolbypassrls from pg_roles where rolname = 'fx_login'").fetchone()[0]
    finally:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(f"drop owned by {owner}")
            for login, role in migrate.LOGINS.items():
                conn.execute(f"revoke {role} from {login} granted by {owner}")
            conn.execute(f"drop role {owner}")


def test_setup_creates_the_admin_once(fresh_server, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker

    from app.core import db
    from app.jobs import migrate
    url, passwords = fresh_server
    _, code = migrate.run(url, passwords)
    from app.launch import login_url
    engine = create_engine(login_url(url, "api_login", passwords["api_login"]), connect_args={"prepare_threshold": None})
    monkeypatch.setattr(db, "engine", engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", sessions)
    from app.api import deps
    monkeypatch.setattr(deps, "SessionLocal", sessions)
    from app.api.main import app
    client = TestClient(app)

    assert client.get("/v1/instance").json()["setup_needed"] is True
    assert client.post("/v1/auth/sign-up", json={"username": "first", "password": PASSWORD}).json() == {"detail": "invite_required"}
    body = {"username": "Boss", "password": PASSWORD, "server_name": "Nhà Lan", "language": "vi"}
    wrong = client.post("/v1/setup", json={**body, "setup_code": "AAAA-BBBB-CCCC"})
    assert (wrong.status_code, wrong.json()) == (403, {"detail": "setup_invalid"})
    ok = client.post("/v1/setup", json={**body, "setup_code": code.lower()})
    assert ok.status_code == 201
    assert client.get("/v1/me", headers=bearer(ok.json()["token"])).json()["profile"]["is_admin"] is True
    assert client.get("/v1/instance").json() | {"server_version": None} == {
        "name": "Nhà Lan", "signup": "invite", "api_version": 1, "setup_needed": False, "server_version": None, "account_purge": "on"}
    again = client.post("/v1/setup", json={**body, "username": "boss2", "setup_code": code})
    assert (again.status_code, again.json()) == (403, {"detail": "setup_invalid"})
    _, code_after = migrate.run(url, passwords)
    assert code_after is None                                                       # no code once there's an admin
    engine.dispose()


def test_a_bad_database_url_never_prints_its_password():
    """A typo in ADMIN_DATABASE_URL (a stray %, an unencoded @) never puts its password in the log."""
    from app import launch
    for url, secret in (("postgresql://u:ab%zzsecret@127.0.0.1:1/x", "zzsecret"), ("postgresql://u:cd@SECRET@127.0.0.1:1/x", "SECRET")):
        with pytest.raises(SystemExit) as stopped:
            launch.wait_for(url, 0)
        assert secret not in str(stopped.value)


@pytest.mark.parametrize("password", ["cd@SECRET/XY", "cd@SE:CRET", "cd@SECRET:54x", "cd@SECRET,XYZW", "cd@SECRET?XY",
                                      "cd@SECR%41ET", "pw-one?two", "SECRET#XY"])
def test_an_ambiguous_database_url_is_refused_before_it_is_read(monkeypatch, password):
    """libpq and urlsplit would read part of such a password as the host, port or query, and quote it."""
    from app import launch
    monkeypatch.setenv("ADMIN_DATABASE_URL", f"postgresql://u:{password}@127.0.0.1:5432/x")
    with pytest.raises(SystemExit) as stopped:
        launch.admin_url()
    assert not any(piece in str(stopped.value) for piece in ("SECRET", "SECR", "CRET", "XY", "pw-one", "two"))


def test_the_access_log_leaves_out_query_strings(client, caplog):
    """Reset links (/reset?token=) and invite links (/join?code=) carry their secret in the query string."""
    import app.api.main  # noqa: F401  (adds the access log's filter)
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        logging.getLogger("uvicorn.access").info('%s - "%s %s HTTP/%s" %d', "1.2.3.4:5", "GET", "/reset?token=sentinel", "1.1", 200)
    assert '"GET /reset HTTP/1.1" 200' in caplog.text and "sentinel" not in caplog.text


def test_an_update_whose_backup_fails_stops_with_a_plain_reason(monkeypatch):
    """A database newer than the image's pg_dump (PostgreSQL 18) can't be backed up: the server says so in one line."""
    from app import launch
    from app.jobs import backup

    def mismatch(*_):
        raise backup.BackupError("pg_dump failed: pg_dump: error: aborting because of server version mismatch")
    monkeypatch.setattr(backup, "run_backup", mismatch)
    with pytest.raises(SystemExit) as stopped:
        launch.backup_before_updating("postgresql://u:secret-pw@db/x", "/tmp")
    assert "nothing was updated" in str(stopped.value) and "Own database" in str(stopped.value)

    def full(*_):
        raise backup.BackupError("no space left on device")
    monkeypatch.setattr(backup, "run_backup", full)
    with pytest.raises(SystemExit) as stopped:
        launch.backup_before_updating("postgresql://u:secret-pw@db/x", "/tmp")
    assert "no space left" in str(stopped.value) and "Own database" not in str(stopped.value)


def test_launcher_builds_login_urls():
    from app.launch import login_url
    assert login_url("postgresql://postgres:x@db:5432/postgres?sslmode=disable", "api_login", "p@ss/w?rd") == \
        "postgresql+psycopg://api_login:p%40ss%2Fw%3Frd@db:5432/postgres?sslmode=disable"
    assert login_url("postgresql://u:x@[::1]/app", "fx_login", "p", driver="postgresql") == "postgresql://fx_login:p@[::1]/app"
    # Supabase's shared pooler: the project ref after the owner's dot goes with every login.
    assert login_url("postgresql://postgres.abcdefgh:x@pooler.example.com:5432/postgres?sslmode=require",
                     "purge_login", "p") == \
        "postgresql+psycopg://purge_login.abcdefgh:p@pooler.example.com:5432/postgres?sslmode=require"


def test_launcher_runs_the_due_jobs_once(fresh_server, tmp_path):
    """`python -m app.launch jobs` (Cloud Run's hourly job): one look at the schedule with the logins' passwords
    from a read-only file, as a mounted secret; exits 1 when a job that was due failed."""
    from app.jobs import migrate
    url, passwords = fresh_server
    migrate.run(url, passwords)
    secrets_dir, backups = tmp_path / "secrets", tmp_path / "backups"
    secrets_dir.mkdir()
    backups.mkdir()
    (secrets_dir / "db_logins.json").write_text(json.dumps(passwords))
    (secrets_dir / "db_logins.json").chmod(0o444)
    secrets_dir.chmod(0o555)
    owner = create_engine(url.replace("postgresql://", "postgresql+psycopg://"))
    with owner.begin() as c:
        c.execute(text("update jobs set enabled = (name <> 'rates')"))           # no network in tests

    def launch(backup_dir):
        env = {**os.environ, "ADMIN_DATABASE_URL": url, "SECRETS_DIR": str(secrets_dir), "BACKUP_DIR": str(backup_dir)}
        return subprocess.run([sys.executable, "-m", "app.launch", "jobs"], env=env, capture_output=True, text=True,
                              cwd=Path(__file__).resolve().parents[1], timeout=120)

    try:
        first = launch(backups)
        assert first.returncode == 0, first.stdout + first.stderr
        assert first.stdout.splitlines()[-1] == "jobs: purge, backup"
        assert len(list(backups.glob("waterflow-*.dump"))) == 1
        again = launch(backups)
        assert (again.returncode, again.stdout.splitlines()[-1]) == (0, "jobs: none due")
        with owner.begin() as c:
            c.execute(text("update jobs set last_started_at = null where name = 'backup'"))
        failed = launch(tmp_path / "missing")
        assert (failed.returncode, failed.stdout.splitlines()[-1]) == (1, "jobs: backup")
        with owner.connect() as c:
            assert c.execute(text("select last_result from jobs where name = 'backup'")).scalar() == "failed"
    finally:
        secrets_dir.chmod(0o755)
        owner.dispose()


def test_job_schedule_times(monkeypatch):
    """Each job at its time of day, the admin's (in their timezone) or JOBS_HOUR (UTC) until then; due
    once its time has come since it last started and since its schedule changed."""
    from zoneinfo import ZoneInfo

    from app.core import jobs
    monkeypatch.setenv("JOBS_HOUR", "19")
    t = lambda *a: datetime(*a, tzinfo=timezone.utc)
    assert (jobs.next_time(t(2026, 10, 21, 18), None, None), jobs.next_time(t(2026, 10, 21, 19), None, None)) == (
        t(2026, 10, 21, 19), t(2026, 10, 22, 19))
    assert jobs.last_time(t(2026, 10, 21, 18), None, None) == t(2026, 10, 20, 19)
    assert jobs.next_time(t(2026, 10, 21, 12), 150, "Asia/Ho_Chi_Minh") == t(2026, 10, 21, 19, 30)   # 02:30 in Vietnam
    # Daylight saving time doesn't move it: 02:00 in Berlin is 00:00 UTC in summer and 01:00 after 25 October.
    assert jobs.next_time(t(2026, 10, 20, 12), 120, "Europe/Berlin") == t(2026, 10, 21, 0)
    assert jobs.next_time(t(2026, 10, 30, 12), 120, "Europe/Berlin") == datetime(2026, 10, 31, 2, tzinfo=ZoneInfo("Europe/Berlin"))
    assert jobs.next_time(t(2026, 10, 30, 12), 120, "Europe/Berlin") == t(2026, 10, 31, 1)

    def due(now, **job):
        return jobs.is_due(now, {"enabled": True, "at_minute": None, "timezone": None, "last_started_at": None,
                                 "changed_at": None} | job)
    assert due(t(2026, 10, 21, 18))                                                     # never ran: a new server
    assert not due(t(2026, 10, 21, 18), last_started_at=t(2026, 10, 20, 19, 0, 5))      # ran at yesterday's time
    assert due(t(2026, 10, 21, 19, 0, 30), last_started_at=t(2026, 10, 20, 19, 0, 5))   # today's has come
    assert due(t(2026, 10, 21, 23), last_started_at=t(2026, 10, 19, 19))                # off at 19:00: catches up
    assert not due(t(2026, 10, 21, 23), last_started_at=t(2026, 10, 19, 19), changed_at=t(2026, 10, 21, 22))
    assert not due(t(2026, 10, 21, 23), enabled=False)
    # A run that failed: again at the next hourly run, until it works. That run may start a little earlier in the
    # hour than the failed job did, which started after the jobs before it (Cloud Scheduler).
    failed_at = {"last_started_at": t(2026, 10, 21, 3, 30), "last_result": "failed"}
    assert not due(t(2026, 10, 21, 4, 10), **failed_at) and due(t(2026, 10, 21, 4, 30), **failed_at)
    assert due(t(2026, 10, 21, 4, 29, 35), **failed_at) and due(t(2026, 10, 21, 4, 23, 50), **failed_at)
    assert not due(t(2026, 10, 21, 4, 30), **failed_at | {"last_result": "done"})
    assert not due(t(2026, 10, 21, 4, 30), **failed_at | {"enabled": False})


def test_daily_jobs_on_server_admin(client, admin, database, monkeypatch):
    """The admin sees each job's time and last run, sets the time in their own timezone, turns any job off, and asks
    for one to run now."""
    _, admin_token = admin
    _, member = sign_up(client)
    url = "/v1/admin/jobs"
    assert client.get(url, headers=bearer(member)).json() == {"detail": "admin_only"}
    assert client.patch(f"{url}/backup", headers=bearer(member), json={"enabled": True}).json() == {"detail": "admin_only"}

    def listed():
        return {j["name"]: j for j in client.get(url, headers=bearer(admin_token)).json()}
    try:
        jobs = client.get(url, headers=bearer(admin_token)).json()
        assert [j["name"] for j in jobs] == ["purge", "backup", "rates"]
        assert all((j["at_minute"], j["timezone"], j["default_minute"], j["enabled"]) == (None, None, 19 * 60, True) for j in jobs)
        assert datetime.fromisoformat(jobs[0]["next_run_at"]).astimezone(timezone.utc).strftime("%H:%M") == "19:00"

        patch = lambda name, **body: client.patch(f"{url}/{name}", headers=bearer(admin_token), json=body)
        assert patch("backup", at_minute=150, timezone="Asia/Saigon").status_code == 204        # an alias, kept as the real name
        backup = listed()["backup"]
        assert (backup["at_minute"], backup["timezone"], backup["enabled"]) == (150, "Asia/Ho_Chi_Minh", True)
        from zoneinfo import ZoneInfo
        assert datetime.fromisoformat(backup["next_run_at"]).astimezone(ZoneInfo("Asia/Ho_Chi_Minh")).strftime("%H:%M") == "02:30"
        assert listed()["purge"]["at_minute"] is None                                        # the others stay

        for body in ({"at_minute": 150}, {"at_minute": 1440, "timezone": "UTC"}, {"at_minute": 60, "timezone": "Mars/Base"}):
            assert patch("purge", **body).status_code == 422, body
        assert client.get("/v1/instance").json()["account_purge"] == "on"
        for name in ("backup", "purge", "rates"):
            assert patch(name, enabled=False).status_code == 204 and listed()[name]["enabled"] is False
        assert client.get("/v1/instance").json()["account_purge"] == "off"
        assert patch("purge", enabled=True).status_code == 204 and patch("backup", enabled=True).status_code == 204
        assert listed()["rates"]["at_minute"] is None                                        # left out: stays
        assert patch("backup", at_minute=None).status_code == 204                            # back to JOBS_HOUR
        assert (listed()["backup"]["at_minute"], listed()["backup"]["timezone"]) == (None, None)
        assert patch("nightly", enabled=True).json() == {"detail": "not_found"}

        run = lambda name, token=admin_token: client.post(f"{url}/{name}/run", headers=bearer(token))  # noqa: E731
        assert listed()["rates"]["run_requested_at"] is None and listed()["rates"]["runs_within"] == "30s"
        assert run("rates", member).json() == {"detail": "admin_only"}
        assert run("rates").status_code == 204 and listed()["rates"]["run_requested_at"] is not None   # though it's off
        assert run("nightly").json() == {"detail": "not_found"}
        with database.connect() as c:
            c.execute(text("update jobs set last_started_at = now(), last_finished_at = null where name = 'backup'"))
        assert (run("backup").status_code, run("backup").json()) == (409, {"detail": "job_running"})
        assert listed()["backup"]["running"] is True
        with database.connect() as c:                       # killed two hours ago, by a restart or a restore
            c.execute(text("update jobs set last_started_at = now() - interval '2 hours' where name = 'backup'"))
        assert listed()["backup"]["running"] is False and run("backup").status_code == 204
        monkeypatch.setenv("RUN_JOBS", "off")
        assert listed()["rates"]["runs_within"] == "1h"                                       # the hourly look elsewhere
    finally:
        with database.connect() as c:
            c.execute(text("update jobs set at_minute = null, timezone = null, enabled = true, changed_at = null,"
                           " run_requested_at = null, last_started_at = null, last_finished_at = null"))


def test_update_info_and_one_click_update(client, admin, tmp_path, monkeypatch):
    from app.core import updates
    _, admin_token = admin
    _, member_token = sign_up(client)
    assert client.get("/v1/admin/update", headers=bearer(member_token)).json() == {"detail": "admin_only"}

    monkeypatch.setattr(updates, "UPDATES", tmp_path)
    monkeypatch.delenv("PROJECT_SITE_URL", raising=False)
    monkeypatch.setattr(updates, "current_version", lambda: "1.2.0")
    monkeypatch.setattr(updates, "_cache", (0.0, None))
    monkeypatch.setattr(updates, "_github", lambda url: {"tag_name": "v1.3.0", "html_url": "https://github.com/x/releases/v1.3.0"})
    info = client.get("/v1/admin/update", headers=bearer(admin_token)).json()
    assert info | {"status": None} == {"current_version": "1.2.0", "latest_version": "1.3.0", "update_available": True,
                                       "release_url": "https://github.com/x/releases/v1.3.0", "changelog_url": None,
                                       "updater": False, "status": None}
    refused = client.post("/v1/admin/update", headers=bearer(admin_token))
    assert (refused.status_code, refused.json()) == (409, {"detail": "updater_off"})

    (tmp_path / "updater_alive").touch()                          # the helper is running
    assert client.get("/v1/admin/update", headers=bearer(admin_token)).json()["updater"] is True
    assert client.post("/v1/admin/update", headers=bearer(member_token)).json() == {"detail": "admin_only"}
    assert not (tmp_path / "requested").exists()
    assert client.post("/v1/admin/update", headers=bearer(admin_token)).status_code == 202
    assert (tmp_path / "requested").exists()

    # The helper's last result, unless it's from before this server started (an update by hand or a restart
    # since); a minute's grace, as it writes "done" just as the new server comes up.
    def status_after(line, started):
        (tmp_path / "status").write_text(line + "\n")
        monkeypatch.setattr(updates, "STARTED", datetime.fromisoformat(started).timestamp())
        return client.get("/v1/admin/update", headers=bearer(admin_token)).json()["status"]
    old = "failed 2026-10-19T16:01:40Z: Error response from daemon: error from registry: denied"
    assert status_after(old, "2026-10-20T16:27:30+00:00") is None
    assert status_after(old, "2026-10-19T16:00:00+00:00") == old                   # failed while this server ran
    assert status_after("done 2026-10-20T16:28:05Z", "2026-10-20T16:28:30+00:00") == "done 2026-10-20T16:28:05Z"
    assert status_after("running 2026-10-20T16:20:00Z", "2026-10-20T16:27:30+00:00") is None

    # The helper doesn't touch its heartbeat while it updates: a recent "running" counts as alive.
    os.utime(tmp_path / "updater_alive", (0, 0))

    def updater_with(line):
        (tmp_path / "status").write_text(line + "\n")
        return client.get("/v1/admin/update", headers=bearer(admin_token)).json()["updater"]
    now = datetime.now(timezone.utc)
    assert updater_with(f"running {now - timedelta(minutes=10):%Y-%m-%dT%H:%M:%SZ}") is True
    assert updater_with(f"running {now - timedelta(hours=1):%Y-%m-%dT%H:%M:%SZ}") is False
    assert updater_with(f"done {now:%Y-%m-%dT%H:%M:%SZ}") is False

    monkeypatch.setenv("PROJECT_SITE_URL", "https://waterflow.example/")
    assert client.get("/v1/admin/update", headers=bearer(admin_token)).json()["changelog_url"] == \
        "https://waterflow.example/docs/changelog/"


def test_versions_compare():
    from app.core.updates import current_version, newer
    assert newer("1.10.0", "1.9.3") and not newer("1.2.0", "1.2.0") and not newer("1.3.0", "dev")
    assert newer("9999.0.0", current_version())                  # the repository's VERSION file is a version


@pytest.fixture
def restore_dir(tmp_path, monkeypatch):
    """Where the API leaves a restore request, and a record of it stopping the server."""
    from app.api.routes.v1 import restore as route
    stops = []
    monkeypatch.setenv("BACKUP_DIR", str(tmp_path))
    monkeypatch.setattr(route, "stop_server", lambda: stops.append(True))
    return tmp_path, stops


@pytest.fixture(scope="module")
def a_backup(tmp_path_factory, database):
    """A real backup of the test database, as the nightly job makes it."""
    from conftest import DB_NAME

    from app.jobs import backup
    path, _, _ = backup.run_backup(ADMIN_URL.set(drivername="postgresql", database=DB_NAME).render_as_string(hide_password=False),
                                   str(tmp_path_factory.mktemp("dump")))
    return Path(path)


def upload(client, path, token=None, content=None, **form):
    return client.post(path, headers=bearer(token) if token else None, data=form,
                       files={"file": ("waterflow.dump", content, "application/octet-stream")})


def test_admin_restores_a_backup_from_the_web(client, admin, restore_dir, a_backup, monkeypatch):
    """R-INST-8 (the API's part): only the admin, with their password, and only a backup this server can read; the API
    leaves it next to the backups and stops, so the launcher restores it as the server starts again."""
    from app.jobs import restore as web_restore
    backups, stops = restore_dir
    _, token = admin
    good = a_backup.read_bytes()

    def send(token=token, content=good, **form):
        return upload(client, "/v1/admin/restore", token, content, **({"password": PASSWORD, "confirm": "true"} | form))

    _, someone = sign_up(client)
    assert send(token=someone).json() == {"detail": "admin_only"}
    assert send(password="not the password").json() == {"detail": "invalid_credentials"}
    assert send(confirm="false").status_code == 422
    assert send(content=b"not a dump").json() == {"detail": "restore_invalid"}
    known = web_restore.server_versions()
    monkeypatch.setattr(web_restore, "server_versions", lambda: known[:-1])       # this server a version behind the backup
    assert send().json() == {"detail": "restore_too_new"}
    monkeypatch.setattr(web_restore, "server_versions", lambda: known)
    assert not stops and not (backups / "restore" / "request.dump").exists()

    assert client.get("/v1/admin/restore", headers=bearer(token)).json() is None
    r = send()
    assert r.status_code == 202, r.text
    assert (backups / "restore" / "request.dump").read_bytes() == good
    assert stops == [True]
    (backups / "restore" / "status").write_text(json.dumps({"status": "done", "at": "2026-10-22T08:00:00+00:00", "detail": None}))
    assert client.get("/v1/admin/restore", headers=bearer(token)).json()["status"] == "done"
    assert client.get("/v1/admin/restore", headers=bearer(someone)).json() == {"detail": "admin_only"}


@pytest.mark.parametrize("path", ["/v1/setup/restore", "/v1/admin/restore"])
def test_an_oversized_restore_is_refused_before_it_is_read(client, monkeypatch, path):
    """Before anything checks who's asking, and before the body is read."""
    from app.api.routes.v1 import restore
    monkeypatch.setattr(restore, "MAX_DUMP", 1000)
    monkeypatch.setattr(restore, "MAX_PURGED", 100)
    r = client.post(path, files={"file": ("big.dump", b"x" * (3 * 2**20))}, data={"setup_code": "WRONG", "password": "x"})
    assert (r.status_code, r.json()) == (413, {"detail": "restore_too_large"})


def test_the_admin_lists_and_downloads_backups_as_one_file(client, admin, restore_dir, a_backup):
    """R-INST-9: the backups folder, newest first; a download asks for the password and gives one .tar holding the
    backup and the list of accounts deleted for good, which restores on its own."""
    import io
    import tarfile
    backups, _ = restore_dir
    _, token = admin
    _, member = sign_up(client)
    for name in ("waterflow-20261101T190000Z.dump", "waterflow-20261102T190000Z.dump"):
        (backups / name).write_bytes(a_backup.read_bytes())
    (backups / "waterflow-20261103T190000Z.dump.partial").write_bytes(b"half")
    (backups / "purged_accounts.jsonl").write_text('{"user_id": "11111111-1111-1111-1111-111111111111"}\n')
    listed = client.get("/v1/admin/backups", headers=bearer(token)).json()
    assert [(b["name"], b["size"]) for b in listed] == [("waterflow-20261102T190000Z.dump", a_backup.stat().st_size),
                                                        ("waterflow-20261101T190000Z.dump", a_backup.stat().st_size)]
    assert listed[0]["taken_at"].startswith("2026-11-02T19:00:00")
    assert client.get("/v1/admin/backups", headers=bearer(member)).json() == {"detail": "admin_only"}

    url = "/v1/admin/backups/waterflow-20261102T190000Z.dump/download"
    assert client.post(url, headers=bearer(token), json={"password": "wrong password!"}).json() == {"detail": "invalid_credentials"}
    assert client.post(url, headers=bearer(member), json={"password": PASSWORD}).json() == {"detail": "admin_only"}
    for bad in ("..%2Fsecrets", "waterflow-20261103T190000Z.dump.partial", "purged_accounts.jsonl", "waterflow-20261104T190000Z.dump"):
        r = client.post(f"/v1/admin/backups/{bad}/download", headers=bearer(token), json={"password": PASSWORD})
        assert r.status_code == 404, (bad, r.text)
    r = client.post(url, headers=bearer(token), json={"password": PASSWORD})
    assert r.status_code == 200 and r.headers["content-type"] == "application/x-tar"
    assert 'filename="waterflow-20261102T190000Z.tar"' in r.headers["content-disposition"]
    with tarfile.open(fileobj=io.BytesIO(r.content), mode="r:") as tar:
        members = {m.name: tar.extractfile(m).read() for m in tar}
    assert members == {"waterflow-20261102T190000Z.dump": a_backup.read_bytes(),
                       "purged_accounts.jsonl": (backups / "purged_accounts.jsonl").read_bytes()}

    for f in backups.glob("waterflow-*"):
        f.unlink()
    restored = upload(client, "/v1/admin/restore", token, r.content, password=PASSWORD, confirm="true")
    assert restored.status_code == 202, restored.text
    assert (backups / "restore" / "request.dump").read_bytes() == a_backup.read_bytes()
    assert (backups / "restore" / "purged_accounts.jsonl").read_bytes() == members["purged_accounts.jsonl"]


def _tar(*members):
    import io
    import tarfile
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:") as tar:
        for name, data, kind in members:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(data) if kind == tarfile.REGTYPE else 0
            if kind == tarfile.SYMTYPE:
                info.linkname = "/etc/passwd"
            tar.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
    return out.getvalue()


def test_a_tar_that_isnt_exactly_a_backup_and_its_list_is_refused(client, admin, restore_dir, a_backup):
    import tarfile
    backups, _ = restore_dir
    _, token = admin
    dump, listed = ("waterflow-20261102T190000Z.dump", a_backup.read_bytes(), tarfile.REGTYPE), ("purged_accounts.jsonl", b"", tarfile.REGTYPE)
    for bad in (_tar(dump, listed, ("extra.txt", b"x", tarfile.REGTYPE)),
                _tar(dump, ("purged_accounts.jsonl", b"", tarfile.SYMTYPE)),
                _tar(("../waterflow-20261102T190000Z.dump", a_backup.read_bytes(), tarfile.REGTYPE), listed),
                _tar(dump, dump),
                _tar(listed)):
        r = upload(client, "/v1/admin/restore", token, bad, password=PASSWORD, confirm="true")
        assert (r.status_code, r.json()) == (422, {"detail": "restore_invalid"})
        assert not (backups / "restore" / "request.dump").exists()
    alone = upload(client, "/v1/admin/restore", token, _tar(dump), password=PASSWORD, confirm="true")   # no list: like a .dump
    assert alone.status_code == 202, alone.text


def test_a_tar_with_extended_headers_is_refused_before_it_is_parsed(client, admin, restore_dir, a_backup, monkeypatch):
    """Pax, long-name and sparse members run parsing code that a crafted file can make slow, huge or crash: no tar
    library reads an upload."""
    import io
    import tarfile
    from app.api.routes.v1 import restore
    backups, _ = restore_dir
    _, token = admin
    name, data = "waterflow-20261102T190000Z.dump", a_backup.read_bytes()

    def packed(fmt, **more):
        out = io.BytesIO()
        with tarfile.open(fileobj=out, mode="w:", format=fmt) as tar:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            for k, v in more.items():
                setattr(info, k, v)
            tar.addfile(info, io.BytesIO(data))
        return out.getvalue()

    crafted = (packed(tarfile.PAX_FORMAT, pax_headers={"GNU.sparse.map": "a,b,c"}),
               packed(tarfile.PAX_FORMAT, pax_headers={"comment": "x" * 200}),
               packed(tarfile.GNU_FORMAT, linkname="l" * 200, type=tarfile.SYMTYPE, size=0))
    plain = packed(tarfile.USTAR_FORMAT)
    crafted += (plain[:124] + b"00000000009\0" + plain[136:],)             # a size that isn't octal
    hidden = packed(tarfile.PAX_FORMAT, pax_headers={"comment": "x" * 200})
    size = b"\0" + b"%010o" % len(hidden) + b"\0"                          # read as 0 by tarfile, as the length by a strip
    crafted += (plain[:124] + size + plain[136:512] + hidden + b"\0" * 1024,)
    opened = []
    real = tarfile.open
    monkeypatch.setattr(restore.tarfile, "open", lambda *a, **k: (opened.append(1), real(*a, **k))[1])
    for bad in crafted:
        r = upload(client, "/v1/admin/restore", token, bad, password=PASSWORD, confirm="true")
        assert (r.status_code, r.json()) == (422, {"detail": "restore_invalid"})
    assert not opened and list((backups / "restore").iterdir()) == []
    assert upload(client, "/v1/admin/restore", token, plain, password=PASSWORD, confirm="true").status_code == 202


def test_a_refused_tar_leaves_nothing_and_its_parts_have_their_own_limits(client, admin, restore_dir, a_backup, monkeypatch):
    import tarfile
    from app.api.routes.v1 import restore
    backups, _ = restore_dir
    _, token = admin
    listed = ("purged_accounts.jsonl", b'{"user_id": "11111111-1111-1111-1111-111111111111"}\n', tarfile.REGTYPE)
    no_backup = _tar(("waterflow-20261102T190000Z.dump", b"PGDMP not really", tarfile.REGTYPE), listed)
    r = upload(client, "/v1/admin/restore", token, no_backup, password=PASSWORD, confirm="true")
    assert (r.status_code, r.json()) == (422, {"detail": "restore_invalid"})
    assert list((backups / "restore").iterdir()) == []

    # A backup right at the limit still restores from its download, which is a little bigger; its list has its own limit.
    dump = ("waterflow-20261102T190000Z.dump", a_backup.read_bytes(), tarfile.REGTYPE)
    monkeypatch.setattr(restore, "MAX_DUMP", a_backup.stat().st_size)
    monkeypatch.setattr(restore, "MAX_PURGED", len(listed[1]))
    too_long = _tar(dump, (listed[0], listed[1] + b"\n", tarfile.REGTYPE))
    r = upload(client, "/v1/admin/restore", token, too_long, password=PASSWORD, confirm="true")
    assert (r.status_code, r.json()) == (422, {"detail": "restore_invalid"})
    assert list((backups / "restore").iterdir()) == []
    r = upload(client, "/v1/admin/restore", token, a_backup.read_bytes() + b"x", password=PASSWORD, confirm="true")
    assert (r.status_code, r.json()) == (413, {"detail": "restore_too_large"})
    assert upload(client, "/v1/admin/restore", token, _tar(dump, listed), password=PASSWORD, confirm="true").status_code == 202


def test_a_refused_upload_leaves_an_accepted_request_whole(client, admin, restore_dir, a_backup, monkeypatch):
    import tarfile
    from app.api.routes.v1 import restore
    backups, _ = restore_dir
    _, token = admin
    listed = ("purged_accounts.jsonl", b'{"user_id": "11111111-1111-1111-1111-111111111111"}\n', tarfile.REGTYPE)
    dump = ("waterflow-20261102T190000Z.dump", a_backup.read_bytes(), tarfile.REGTYPE)
    (backups / "restore").mkdir(exist_ok=True)
    (backups / "restore" / "upload.purged.partial").write_text("left by an upload the server stopped in the middle of")
    assert upload(client, "/v1/admin/restore", token, a_backup.read_bytes(), password=PASSWORD, confirm="true").status_code == 202
    assert sorted(f.name for f in (backups / "restore").iterdir()) == ["request.dump", "status"]
    assert upload(client, "/v1/admin/restore", token, _tar(dump, listed), password=PASSWORD, confirm="true").status_code == 202
    waiting = {f.name: f.read_bytes() for f in (backups / "restore").iterdir() if f.name != "status"}
    assert waiting.keys() == {"request.dump", "purged_accounts.jsonl"}
    refused = upload(client, "/v1/admin/restore", token, _tar(listed), password=PASSWORD, confirm="true")
    assert refused.status_code == 422
    monkeypatch.setattr(restore, "MAX_PURGED", 10)
    too_long = client.post("/v1/admin/restore", headers=bearer(token), data={"password": PASSWORD, "confirm": "true"},
                           files={"file": ("waterflow.dump", a_backup.read_bytes()), "purged": ("purged_accounts.jsonl", b"x" * 11)})
    assert (too_long.status_code, too_long.json()) == (413, {"detail": "restore_too_large"})
    assert {f.name: f.read_bytes() for f in (backups / "restore").iterdir() if f.name != "status"} == waiting


def test_a_download_leaves_no_copy_of_the_backup_behind(client, admin, restore_dir, a_backup, tmp_path, monkeypatch):
    """Whatever the request asks for: a Range the server can't answer used to skip the clean-up."""
    import tempfile
    backups, _ = restore_dir
    _, token = admin
    (backups / "waterflow-20261102T190000Z.dump").write_bytes(a_backup.read_bytes())
    (backups / "waterflow-20261101T190000Z.dump").write_bytes(a_backup.read_bytes())
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(work))
    url = "/v1/admin/backups/waterflow-20261102T190000Z.dump/download"
    sizes = set()
    for headers in ({}, {"Range": "bytes=abc"}, {"Range": "bytes=999999999-"}, {"Range": "bytes=0-9"}):
        r = client.post(url, headers=bearer(token) | headers, json={"password": PASSWORD})
        assert r.status_code == 200 and int(r.headers["content-length"]) == len(r.content), (headers, r.status_code)
        sizes.add(len(r.content))
        assert list(work.iterdir()) == []
    assert len(sizes) == 1
    (backups / "waterflow-20261101T190000Z.dump").unlink()
    assert [b["name"] for b in client.get("/v1/admin/backups", headers=bearer(token)).json()] == ["waterflow-20261102T190000Z.dump"]


def test_downloading_a_backup_asks_for_the_two_factor_code(client, admin, restore_dir, a_backup):
    backups, _ = restore_dir
    _, token = admin
    (backups / "waterflow-20261102T190000Z.dump").write_bytes(a_backup.read_bytes())
    secret = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()["secret"]
    client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": totp(secret)})
    url = "/v1/admin/backups/waterflow-20261102T190000Z.dump/download"
    assert client.post(url, headers=bearer(token), json={"password": PASSWORD}).json() == {"detail": "code_required"}
    assert client.post(url, headers=bearer(token), json={"password": PASSWORD, "code": "000000"}).json() == {"detail": "invalid_code"}
    code = totp(secret)
    assert client.post(url, headers=bearer(token), json={"password": PASSWORD, "code": code}).status_code == 200
    assert client.post(url, headers=bearer(token), json={"password": PASSWORD, "code": code}).json() == {"detail": "invalid_code"}


def test_restoring_asks_for_the_two_factor_code(client, admin, restore_dir, a_backup):
    _, token = admin
    secret = client.post("/v1/auth/two-factor/setup", headers=bearer(token)).json()["secret"]
    client.post("/v1/auth/two-factor/enable", headers=bearer(token), json={"secret": secret, "code": totp(secret)})
    form = {"password": PASSWORD, "confirm": "true"}
    assert upload(client, "/v1/admin/restore", token, a_backup.read_bytes(), **form).json() == {"detail": "code_required"}
    assert upload(client, "/v1/admin/restore", token, a_backup.read_bytes(), code="000000", **form).json() == {"detail": "invalid_code"}
    code = totp(secret)
    r = upload(client, "/v1/admin/restore", token, a_backup.read_bytes(), code=code, **form)
    assert r.status_code == 202, r.text
    again = upload(client, "/v1/admin/restore", token, a_backup.read_bytes(), code=code, **form)
    assert again.json() == {"detail": "invalid_code"}                                   # the code was used


def test_restore_at_setup_with_the_setup_code(fresh_server, restore_dir, a_backup, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker

    from app.api import deps
    from app.core import db
    from app.jobs import migrate
    from app.launch import login_url
    url, passwords = fresh_server
    _, code = migrate.run(url, passwords)
    engine = create_engine(login_url(url, "api_login", passwords["api_login"]), connect_args={"prepare_threshold": None})
    sessions = sessionmaker(engine, expire_on_commit=False)
    for module, attr, value in ((db, "engine", engine), (db, "SessionLocal", sessions), (deps, "SessionLocal", sessions)):
        monkeypatch.setattr(module, attr, value)
    from app.api.main import app
    client = TestClient(app)
    backups, stops = restore_dir

    wrong = upload(client, "/v1/setup/restore", content=a_backup.read_bytes(), setup_code="AAAA-BBBB-CCCC")
    assert (wrong.status_code, wrong.json()) == (403, {"detail": "setup_invalid"})
    ok = upload(client, "/v1/setup/restore", content=a_backup.read_bytes(), setup_code=code.lower())
    assert ok.status_code == 202, ok.text
    assert (backups / "restore" / "request.dump").exists() and stops == [True]
    setup = client.post("/v1/setup", json={"username": "boss", "password": PASSWORD, "setup_code": code})     # not used up
    assert setup.status_code == 201
    again = upload(client, "/v1/setup/restore", content=a_backup.read_bytes(), setup_code=code)
    assert again.json() == {"detail": "setup_invalid"}
