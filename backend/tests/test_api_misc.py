"""Users sign up through the API: the test database has open sign-up. Invite-only and setup are in test_sign_in.py."""
import uuid
from datetime import date

import pytest
from api_helpers import _account, _book, _expense, add_category, auth, signed_up
from sqlalchemy import text


def test_health_needs_no_token(client):
    r = client.get("/v1/health")
    assert r.json() == {"ok": True}
    assert r.headers["cache-control"] == "no-store"


def test_instance_needs_no_token(client):
    r = client.get("/v1/instance").json()
    assert r["api_version"] == 1 and r["signup"] == "open" and r["name"] == "Waterflow"
    assert set(r) == {"name", "server_version", "api_version", "signup", "setup_needed", "account_purge"}
    assert r["account_purge"] == "on"


def test_me_returns_only_my_profile(client):
    mine, other = signed_up(client, f"me_{uuid.uuid4().hex[:8]}"), signed_up(client)
    r = client.get("/v1/me", headers=auth(mine))
    assert r.status_code == 200 and r.json()["id"] == str(mine)
    profile = r.json()["profile"]
    assert profile["username"].startswith("me_") and profile["language"] == "en" and profile["is_admin"] is False
    assert set(profile) == {"username", "display_name", "timezone", "language", "created_at", "deletion_requested_at",
                            "is_admin", "idle_sign_out_minutes"}
    assert client.get("/v1/me", headers=auth(other)).json()["id"] == str(other)


@pytest.mark.parametrize("bad", ["no-token", "", "not-a-token", "Basic abc", "a-jwt"])
def test_bad_tokens_are_refused(client, bad):
    headers = {
        "no-token": {},
        "Basic abc": {"Authorization": "Basic abc"},
        "a-jwt": {"Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"},
    }.get(bad, {"Authorization": f"Bearer {bad}"})
    r = client.get("/v1/me", headers=headers)
    assert (r.status_code, r.json()) == (401, {"detail": "not_signed_in"})


def test_only_this_servers_web_app_and_any_phone(client):
    u = signed_up(client)
    other = client.get("/v1/me", headers={**auth(u), "Origin": "https://copy-of-waterflow.example"})
    assert (other.status_code, other.json()) == (403, {"detail": "origin_not_allowed"})
    assert client.post("/v1/auth/sign-in", headers={"Origin": "null"}, json={"username": "x", "password": "y"}).status_code == 403
    assert client.get("/v1/me", headers={**auth(u), "Origin": "http://testserver"}).status_code == 200        # its own web app
    behind_proxy = {**auth(u), "Origin": "https://money.example.com", "X-Forwarded-Host": "money.example.com"}
    assert client.get("/v1/me", headers=behind_proxy).status_code == 200
    assert client.get("/v1/me", headers=auth(u)).status_code == 200                                         # a phone
    assert client.get("/", headers={"Origin": "https://elsewhere.example"}).status_code in (200, 404)       # pages aren't API calls


def test_no_cors_by_default(client):
    preflight = {"Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"}
    r = client.options("/v1/me", headers={"Origin": "http://evil.test", **preflight})
    assert "access-control-allow-origin" not in r.headers       # the web app is served from the API's own origin


def test_unknown_api_paths_are_404_not_the_web_app(client):
    r = client.get("/v1/nothing-here")
    assert (r.status_code, r.json()) == (404, {"detail": "not_found"})


def test_web_app_files_and_routes(client, tmp_path, monkeypatch):
    from app.core import settings
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "assets" / "a.js").write_text("js")
    monkeypatch.setattr(settings, "settings", settings.Settings(web_dir=tmp_path))
    import app.api.main as main
    monkeypatch.setattr(main, "settings", settings.settings)
    page = client.get("/join?code=X")
    assert page.text == "<html>app</html>" and "default-src 'self'" in page.headers["content-security-policy"]
    assert page.headers["referrer-policy"] == "no-referrer"
    asset = client.get("/assets/a.js")
    assert asset.text == "js" and "immutable" in asset.headers["cache-control"]
    assert client.get("/../../etc/passwd").text == "<html>app</html>"        # never outside the web app's folder


def test_home_screen_manifest(client, tmp_path, monkeypatch):
    """The web app's manifest is served as application/manifest+json, which phones need to offer adding it."""
    from pathlib import Path

    from app.core import settings
    manifest = Path(__file__).resolve().parents[2] / "web" / "public" / "manifest.webmanifest"
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "manifest.webmanifest").write_bytes(manifest.read_bytes())
    monkeypatch.setattr(settings, "settings", settings.Settings(web_dir=tmp_path))
    import app.api.main as main
    monkeypatch.setattr(main, "settings", settings.settings)
    r = client.get("/manifest.webmanifest")
    assert r.headers["content-type"].startswith("application/manifest+json")
    assert r.json()["name"] == "Waterflow"


def test_currencies(client):
    ccy = {c["code"]: c for c in client.get("/v1/currencies", headers=auth(signed_up(client))).json()}
    assert ccy["VND"]["minor_unit"] == 0 and ccy["KWD"]["minor_unit"] == 3 and len(ccy) == 155


def test_assets_and_debts_add_up_to_net_worth(client, database):
    """By balance, not by kind: an overdrawn account is a debt; a debt is a positive number; no rate, in neither."""
    from datetime import date as d
    today = d.today()
    with database.connect() as c:
        c.execute(text("insert into fx_rates (quote, as_of, rate, source) values ('VND', :t, 26000, 't')"
                       " on conflict (quote, as_of) do update set rate = excluded.rate"), {"t": today})
    u = signed_up(client)
    bid = str(uuid.uuid4())
    client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": "VND", "timezone": "UTC",
                                                    "starter_categories": False})

    def acct(name, kind, ccy, amount, **kw):
        r = client.post(f"/v1/books/{bid}/accounts", headers=auth(u), json={
            "id": str(uuid.uuid4()), "name": name, "kind": kind, "currency": ccy, "opening_balance": amount,
            "opened_on": today.isoformat(), **kw})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    cash = acct("Ví", "cash", "VND", 1_000_000)
    acct("US bank", "checking", "USD", 10_000)                       # $100.00 = 2.600.000 ₫
    acct("Visa", "credit_card", "VND", -2_000_000)
    acct("Home loan", "loan", "VND", -5_000_000)
    acct("Overdrawn", "checking", "VND", -300_000)
    acct("Held for Mom", "cash", "VND", 3_000_000, in_net_worth=False)
    acct("Kuwait", "checking", "KWD", 5_000)                         # no rate
    acct("Kuwait loan", "loan", "KWD", -5_000)
    minh = client.post(f"/v1/books/{bid}/contacts", headers=auth(u), json={"id": str(uuid.uuid4()), "name": "Minh"}).json()
    client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
        "id": str(uuid.uuid4()), "type": "transfer", "occurred_on": today.isoformat(),
        "entries": [{"account_id": cash, "amount": -400_000}, {"account_id": minh["id"], "amount": 400_000}]})

    dash = client.get(f"/v1/books/{bid}/dashboard", headers=auth(u)).json()
    assert (dash["assets"], dash["debts"]) == (600_000 + 2_600_000 + 400_000, 2_000_000 + 5_000_000 + 300_000)
    assert dash["assets"] - dash["debts"] == dash["net_worth"]
    assert dash["net_worth_missing_rates"] == 2

    other = signed_up(client)
    assert client.get(f"/v1/books/{bid}/dashboard", headers=auth(other)).json() == {"detail": "not_found"}


def test_dashboard_converts_at_todays_rate(client, database):
    from datetime import date as d
    today = d.today()
    with database.connect() as c:                       # what the daily rates job writes (as fx_updater)
        c.execute(text("insert into fx_rates (quote, as_of, rate, source) values ('VND', :t, 26000, 't'),"
                       " ('VND', :y, 25000, 't') on conflict (quote, as_of) do update set rate = excluded.rate"),
                  {"t": today, "y": d(today.year - 1, 1, 1)})
    u = signed_up(client)
    bid = str(uuid.uuid4())
    client.post("/v1/books", headers=auth(u), json={"id": bid, "name": "B", "base_currency": "VND", "timezone": "UTC",
                                                    "starter_categories": False})
    acct = lambda name, ccy, amount, **kw: client.post(f"/v1/books/{bid}/accounts", headers=auth(u), json={  # noqa: E731
        "id": str(uuid.uuid4()), "name": name, "kind": "checking", "currency": ccy, "opening_balance": amount,
        "opened_on": today.isoformat(), **kw}).json()["id"]
    vnd = acct("Ví", "VND", 1_000_000)
    usd = acct("US bank", "USD", 10_000)                # $100.00
    acct("Kuwait", "KWD", 5_000)                         # no KWD rate anywhere: left out and counted
    acct("Held for Mom", "VND", 3_000_000, in_net_worth=False)
    food = add_category(client, u, bid, "Food")
    for account, amount in ((vnd, -50_000), (usd, -500)):    # 50.000 ₫ and $5.00 at 26.000 ₫/$
        client.post(f"/v1/books/{bid}/transactions", headers=auth(u), json={
            "id": str(uuid.uuid4()), "type": "expense", "occurred_on": today.isoformat(), "category_id": food["id"],
            "entries": [{"account_id": account, "amount": amount}]})

    r = client.get(f"/v1/books/{bid}/dashboard", headers=auth(u))
    assert r.status_code == 200, r.text
    dash = r.json()
    rows = {a["name"]: a for a in dash["accounts"]}
    assert (rows["US bank"]["balance"], rows["US bank"]["converted_balance"]) == (9_500, 2_470_000)   # $95.00 today
    assert rows["Kuwait"]["converted_balance"] is None
    assert (dash["currency"], dash["net_worth"], dash["net_worth_missing_rates"]) == ("VND", 950_000 + 2_470_000, 1)
    assert dash["spent_this_month"] == 50_000 + 130_000
    assert dash["top_categories_this_month"][0] | {"category_id": None} == {
        "category_id": None, "category": "Food", "category_parent_id": None, "spent": 180_000, "not_converted": 0}
    assert dash["recent_transactions"][0]["type"] in ("expense", "opening_balance")
    assert client.get(f"/v1/books/{bid}/dashboard", headers=auth(signed_up(client))).json() == {"detail": "not_found"}

    listed = {a["name"]: a for a in client.get(f"/v1/books/{bid}/accounts", headers=auth(u)).json()}
    assert [listed[n]["converted_balance"] for n in ("Ví", "US bank", "Kuwait")] == [950_000, 2_470_000, None]


def test_the_overview_keeps_spending_without_a_rate_and_leaves_out_future_months(client):
    """A category whose spending this month all lacks a rate keeps its count; future months stay out of the chart."""
    from datetime import timedelta
    u = signed_up(client)
    bid = _book(client, u)
    cash, odd = _account(client, u, bid), _account(client, u, bid, currency="XAF")
    trips = add_category(client, u, bid, "Trips")["id"]
    _expense(client, u, bid, odd, 5000, category_id=trips)
    _expense(client, u, bid, cash, 7000, day=(date.today().replace(day=1) + timedelta(days=40)).isoformat())
    d = client.get(f"/v1/books/{bid}/dashboard", headers=auth(u)).json()
    assert [(c["category_id"], c["spent"], c["not_converted"]) for c in d["top_categories_this_month"]] == [(trips, 0, 1)]
    assert all(m["month"] <= date.today().isoformat() for m in d["cashflow_6_months"])
