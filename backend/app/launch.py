"""How the `waterflow` container starts:

    python -m app.launch secrets   first start only: the built-in database's password, before Postgres starts
    python -m app.launch           the server: a backup when an update brings migrations, the migrations and logins,
                                   the setup code, then the API and the scheduler side by side (if either stops,
                                   the container stops and Docker restarts it)
    python -m app.launch jobs      the due jobs, once, for a server with RUN_JOBS=off (Cloud Run); non-zero if one
                                   failed. Needs the server to have started once.

The API gets only its own login, never the owner's password, so even a flaw in the API can't get around row-level
security. The logins' passwords file can be mounted read-only (Cloud Run's Secret Manager): the server then sets
those passwords instead of making new ones.
"""
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import psycopg

from app.core.hardening import hide_environment
from app.jobs import backup, migrate, owner, restore

SECRETS = Path(os.environ.get("SECRETS_DIR", "/secrets"))
POSTGRES_PASSWORD = SECRETS / "postgres_password"
LOGIN_PASSWORDS = SECRETS / "db_logins.json"
OWNER_PASSWORD = SECRETS / "owner_password"


def _write_secret(path: Path, value: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w") as f:
        f.write(value)


def make_postgres_password() -> None:
    if not POSTGRES_PASSWORD.exists():
        # Readable by the database container's own user too. The secrets volume
        # is mounted only into the database and this server.
        _write_secret(POSTGRES_PASSWORD, secrets.token_hex(24), 0o644)
        print("made the built-in database's password", flush=True)


def login_passwords() -> dict[str, str]:
    if not LOGIN_PASSWORDS.exists():
        _write_secret(LOGIN_PASSWORDS, json.dumps({login: secrets.token_hex(24) for login in migrate.LOGINS}))
    return json.loads(LOGIN_PASSWORDS.read_text())


def admin_url() -> str:
    own = os.environ.get("ADMIN_DATABASE_URL", "").strip()
    if own:
        # An unencoded @ / ? # in the password makes libpq and urlsplit read part of it as the host, port or query,
        # and quote it in their errors: refused before anything reads the URL, with nothing of it in the message.
        if any(c in own.partition("://")[2].rpartition("@")[0] for c in "@/?#"):
            raise SystemExit("ADMIN_DATABASE_URL: percent-encode @ / ? # in the password (%40 %2F %3F %23)")
        return own.replace("postgresql+psycopg://", "postgresql://")
    password = POSTGRES_PASSWORD.read_text().strip()
    return f"postgresql://postgres:{password}@db:5432/postgres?sslmode=disable"


def as_owner(admin: str, role: str = owner.OWNER) -> str:
    """On the built-in database, the URL of the owner that is no superuser, after handing it everything (app/jobs/owner.py).
    A server with its own database keeps the owner it was given. Once that owner exists the server never goes back to
    the superuser, whatever fails: what the owner holds may come from a restored backup. Only a first hand-over that
    fails leaves the server as it was before."""
    if os.environ.get("ADMIN_DATABASE_URL", "").strip():
        return admin
    handed_over_before = owner.exists(admin, role)
    if not OWNER_PASSWORD.exists():
        _write_secret(OWNER_PASSWORD, secrets.token_hex(24))
    password = OWNER_PASSWORD.read_text().strip()
    try:
        owner.hand_over(admin, password, role)
    except psycopg.Error as e:
        why = backup._scrub(str(e).splitlines()[0], admin)
        if not handed_over_before:
            OWNER_PASSWORD.unlink()
            print(f"WARNING: the database is still run as its superuser: handing it to {role} failed ({why})", flush=True)
            return admin
        print(f"WARNING: the hand-over to {role} failed this time ({why}); carrying on as {role}", flush=True)
    return login_url(admin, role, password, "postgresql")


def owner_url(admin: str) -> str:
    """For the operator's commands: the owner's URL once the built-in database has been handed over, without doing it
    again. What they change belongs to the owner, and its triggers mustn't run as the superuser."""
    if os.environ.get("ADMIN_DATABASE_URL", "").strip() or not OWNER_PASSWORD.exists():
        return admin
    return login_url(admin, owner.OWNER, OWNER_PASSWORD.read_text().strip(), "postgresql")


def login_url(admin: str, login: str, password: str, driver: str = "postgresql+psycopg") -> str:
    """The owner's URL with another login: same server, database and options.
    An owner name with a dot is a pooler's (Supabase's shared pooler, Supavisor: postgres.<project ref>), which
    reads the part after the dot as the project: the login gets the same suffix."""
    parts = urlsplit(admin)
    host = parts.hostname or ""
    host = f"[{host}]" if ":" in host else host
    port = f":{parts.port}" if parts.port else ""
    _, dot, project = unquote(parts.username or "").partition(".")
    netloc = f"{quote(login + dot + project, safe='')}:{quote(password, safe='')}@{host}{port}"
    return urlunsplit((driver, netloc, parts.path, parts.query, ""))


def wait_for(url: str, seconds: int = 120) -> None:
    deadline = time.monotonic() + seconds
    while True:
        try:
            psycopg.connect(url, connect_timeout=5).close()
            return
        except psycopg.OperationalError as e:
            if time.monotonic() > deadline:
                raise SystemExit(f"the database isn't reachable: {backup._scrub(str(e).splitlines()[0], url)}") from None
            time.sleep(2)
        except psycopg.Error as e:       # a URL psycopg can't read: its message may quote the password
            raise SystemExit(f"ADMIN_DATABASE_URL can't be read: {backup._scrub(str(e).splitlines()[0], url)}") from None


def print_setup_code(code: str) -> None:
    line = "=" * 64
    print(f"\n{line}\n  This server has no admin yet. Open it in a browser and enter\n"
          f"  this setup code to create the admin account:\n\n      {code}\n\n"
          f"  A new code is printed every time the server starts, until then.\n{line}\n", flush=True)


def _without_owner() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k != "ADMIN_DATABASE_URL"}


def jobs_env(admin: str, passwords: dict[str, str], backup_dir: str) -> dict[str, str]:
    """What the scheduler and its jobs need: their own logins, and the owner's for the backup."""
    return {"PURGE_DATABASE_URL": login_url(admin, "purge_login", passwords["purge_login"]),
            "FX_DATABASE_URL": login_url(admin, "fx_login", passwords["fx_login"]),
            "BACKUP_DATABASE_URL": admin, "BACKUP_DIR": backup_dir,
            "PURGE_LOG": os.environ.get("PURGE_LOG", str(Path(backup_dir) / "purged_accounts.jsonl"))}


def jobs_here() -> bool:
    return os.environ.get("RUN_JOBS", "on").lower() not in ("off", "false", "0")


def run_jobs_once() -> None:
    admin = admin_url()
    passwords = login_passwords()
    wait_for(admin)
    with psycopg.connect(admin, autocommit=True, options=owner.PINNED) as conn:
        migrate.rename_old_schema(conn)
    admin = as_owner(admin)
    env = {**_without_owner(), **jobs_env(admin, passwords, os.environ.get("BACKUP_DIR", "/backups"))}
    sys.exit(subprocess.run([sys.executable, "-m", "app.jobs.scheduler", "--once"], env=env).returncode)


def backup_before_updating(admin: str, backup_dir: str) -> None:
    """Stops the server with a plain reason, not a traceback, when the backup an update needs can't be made."""
    try:
        path, _, _ = backup.run_backup(admin, backup_dir)
    except backup.BackupError as e:
        hint = (" The image's pg_dump can't back up a newer PostgreSQL than its own: see Own database in the docs."
                if "version mismatch" in str(e) else "")
        raise SystemExit(f"the backup before updating failed, so nothing was updated: {backup._scrub(str(e), admin)}.{hint}") from None
    print(f"before updating: backed up to {path}", flush=True)


def serve() -> None:
    started = time.time()              # before the backup and migrations: see app/core/updates.py status()
    admin = admin_url()
    passwords = login_passwords()
    wait_for(admin)
    backup_dir = os.environ.get("BACKUP_DIR", "/backups")
    with psycopg.connect(admin, autocommit=True, options=owner.PINNED) as conn:
        migrate.rename_old_schema(conn)          # before any backup, which dumps schema waterflow
    admin = as_owner(admin)

    def backup_first():
        backup_before_updating(admin, backup_dir)

    # A stop asked for during a restore or the migrations waits for them to end, so a short one isn't cut midway
    # (a long one still is, by the kill after the grace period: the restore then picks up on the next start).
    stop_asked = []
    signal.signal(signal.SIGTERM, lambda *_: stop_asked.append(True))
    signal.signal(signal.SIGINT, lambda *_: stop_asked.append(True))
    restored = restore.restore_if_requested(admin, backup_dir)
    if restored:
        print(f"restore from the web app: {restored}", flush=True)
    applied, setup_code = migrate.run(admin, passwords, before_migrating=backup_first)
    print(f"database ready ({len(applied)} migration(s) applied{': ' + ', '.join(applied) if applied else ''})",
          flush=True)
    if setup_code:
        print_setup_code(setup_code)
    if stop_asked:
        print("stopping, as asked while starting", flush=True)
        sys.exit(0)

    base = {**_without_owner(), "SERVER_STARTED_AT": str(started), "LAUNCHER_PID": str(os.getpid())}
    api_env = {**base, "DATABASE_URL": login_url(admin, "api_login", passwords["api_login"])}
    port = os.environ.get("PORT", "8080")
    reload = ["--reload"] if os.environ.get("DEV_RELOAD") else []        # development only (scripts/dev.sh)
    children = [
        subprocess.Popen([sys.executable, "-m", "uvicorn", "app.api.main:app", "--host", "0.0.0.0", "--port", port,
                          "--proxy-headers", "--forwarded-allow-ips", "*", *reload], env=api_env),
    ]
    if jobs_here():
        children.append(subprocess.Popen([sys.executable, "-m", "app.jobs.scheduler"],
                                         env={**base, **jobs_env(admin, passwords, backup_dir)}))
    else:
        print("RUN_JOBS=off: the daily jobs run elsewhere (python -m app.launch jobs)", flush=True)

    def stop(*_):
        for c in children:
            c.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if stop_asked:                       # asked between the check above and these
        stop()
    while all(c.poll() is None for c in children):
        time.sleep(1)
    stop()
    for c in children:
        c.wait(timeout=20)
    sys.exit(next((c.returncode for c in children if c.returncode), 0))


if __name__ == "__main__":
    hide_environment()
    if sys.argv[1:] == ["secrets"]:
        make_postgres_password()
    elif sys.argv[1:] == ["jobs"]:
        run_jobs_once()
    else:
        serve()
