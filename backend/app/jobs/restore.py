"""Restoring a backup uploaded in the web app (Server admin, or at setup). The API, which never has the database
owner's login, only checks the file, leaves it in BACKUP_DIR/restore/ and stops the server. As the server starts
again, the launcher calls restore_if_requested() before the migrations:

    1. a backup of the database as it is, like the nightly one;
    2. the schemas public and waterflow emptied and the upload loaded: the own-database steps on the public Backups
       and restore page, which work on the built-in database too;
    3. the upload's purged accounts added to PURGE_LOG, and every account in it purged again;
    4. if 2 or 3 fails, the backup from 1 loaded back.

restore/status records the outcome for Server admin. The migrations and the logins then run as on every start.
"""
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg import sql

from app.jobs import account_deletion, backup, migrate

REQUEST = "request.dump"
PURGED = "purged_accounts.jsonl"
STATUS = "status"
ROLES = ("app_user", "account_purger", "fx_updater")


class RestoreError(Exception):
    pass


class TooNew(RestoreError):
    pass


def folder(backup_dir: str) -> Path:
    return Path(backup_dir) / "restore"


def server_versions() -> list[str]:
    return sorted(f.name.split("_", 1)[0] for f in migrate.MIGRATIONS.glob("*.sql"))


def dump_versions(path: Path) -> list[str]:
    """The migrations a backup had applied. RestoreError when it isn't a Waterflow backup (or an MSaving one, the
    app's former name, whose migrations are in schema msaving)."""
    _, pg_restore = backup._tools()
    toc = subprocess.run([pg_restore, "--list", str(path)], capture_output=True, text=True)
    schema = next((s for s in ("waterflow", "msaving") if f" TABLE DATA {s} migrations " in toc.stdout), None)
    if toc.returncode != 0 or schema is None or " TABLE DATA public users " not in toc.stdout:
        raise RestoreError("not a Waterflow backup")
    data = subprocess.run([pg_restore, "--data-only", f"--schema={schema}", "--table=migrations", "--file=-", str(path)],
                          capture_output=True, text=True)
    lines = data.stdout.splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith(f"COPY {schema}.migrations")), None)
    if data.returncode != 0 or start is None:
        raise RestoreError("the backup's list of migrations can't be read")
    versions = [line.split("\t", 1)[0] for line in lines[start + 1:lines.index("\\.", start)]]
    if not versions:
        raise RestoreError("the backup lists no migrations")
    return sorted(versions)


def check(path: Path) -> None:
    """Refuses a file that isn't a Waterflow backup, or one from a newer version than this server."""
    if set(dump_versions(path)) - set(server_versions()):
        raise TooNew("the backup is from a newer version of Waterflow than this server")


def _empty(url: str) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("drop schema if exists waterflow cascade")
        conn.execute("drop schema if exists msaving cascade")
        conn.execute("drop schema if exists public cascade")
        conn.execute("create schema public")
        conn.execute("alter default privileges revoke execute on functions from public")
        for role in ROLES:
            if not conn.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone():
                conn.execute(f'create role "{role}" nologin')


# Default privileges only shape objects a role makes later, and the migrations grant each object anyway; Supabase's
# name supabase_admin, whose defaults only a superuser or its members may change. So they're left out of a restore.
LEFT_OUT = [f" {kind} - {schema}public " for kind in ("SCHEMA", "COMMENT") for schema in ("", "SCHEMA ")] + [" DEFAULT ACL "]
GRANTEE = re.compile(r'\b(?:TO|FROM)\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)')


def _grantees(pg_restore: str, path: str, toc: str, env: dict) -> set[str]:
    """The roles the dump's privileges name, PUBLIC aside."""
    acl = [line for line in toc.splitlines() if " ACL " in line and " DEFAULT ACL " not in line]
    if not acl:
        return set()
    with tempfile.NamedTemporaryFile("w", suffix=".list") as listing:
        listing.write("\n".join(acl))
        listing.flush()
        statements = backup._run([pg_restore, f"--use-list={listing.name}", "--file=-", path], env)
    names = {m[1:-1].replace('""', '"') if m.startswith('"') else m.lower() for m in GRANTEE.findall(statements)}
    return names - {"public"}


def _make_missing_roles(url: str, names: set[str], made: list[str]) -> None:
    """A backup from Supabase names its own roles (anon, authenticated, service_role...): made here, unable to sign
    in, so their grants load instead of stopping the restore. Each one made is added to `made`."""
    with psycopg.connect(url, autocommit=True) as conn:
        for name in sorted(names):
            if not conn.execute("select 1 from pg_roles where rolname = %s", (name,)).fetchone():
                conn.execute(sql.SQL("create role {} nologin").format(sql.Identifier(name)))
                made.append(name)
                # An owner that isn't a superuser may drop what a role owns only as a member of it.
                conn.execute(sql.SQL("grant {} to current_user").format(sql.Identifier(name)))


def _drop_roles(url: str, names: list[str]) -> None:
    """The roles made for a load, with what the dump granted them: the app never uses them. One that can't be dropped
    is left, and said, rather than failing a restore that worked."""
    with psycopg.connect(url, autocommit=True) as conn:
        for name in names:
            try:
                conn.execute(sql.SQL("drop owned by {}").format(sql.Identifier(name)))
                conn.execute(sql.SQL("drop role {}").format(sql.Identifier(name)))
            except psycopg.Error as e:
                print(f"restore: the role {name} made for it stays: {str(e).splitlines()[0]}", flush=True)


def _load(url: str, path: str) -> None:
    _, pg_restore = backup._tools()
    dsn, password = backup._split(url)
    env = dict(os.environ, **({"PGPASSWORD": password} if password else {}))
    try:
        toc = backup._run([pg_restore, "--list", path], env)
        made: list[str] = []
        try:
            _make_missing_roles(url, _grantees(pg_restore, path, toc, env), made)
            with tempfile.NamedTemporaryFile("w", suffix=".list") as listing:
                listing.write("\n".join(line for line in toc.splitlines() if not any(part in line for part in LEFT_OUT)))
                listing.flush()
                backup._run([pg_restore, "--no-owner", "--single-transaction", "--exit-on-error",
                             f"--use-list={listing.name}", f"--dbname={dsn}", path], env)
        finally:
            _drop_roles(url, made)
    except backup.BackupError as e:
        raise RestoreError(str(e)) from None


def _repurge(url: str, purge_log: str) -> None:
    ids = list(dict.fromkeys(r["user_id"] for r in account_deletion._read(purge_log) if "purged_at" in r))
    if ids:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute("select repurge_accounts(%s::uuid[])", (ids,))


SIGN_IN_STATE = ("sessions", "remembered_devices", "password_resets")


def _sign_everyone_out(url: str) -> None:
    """The backup's sessions, remembered devices and reset links would work again, even ones ended after it, and so
    would an invite used or revoked after it. A backup from before a table existed lacks it: the migrations add it
    after the restore."""
    with psycopg.connect(url, autocommit=True) as conn:
        for table in SIGN_IN_STATE:
            if conn.execute("select to_regclass(%s)", (f"public.{table}",)).fetchone()[0]:
                conn.execute(f"delete from public.{table}")
        if conn.execute("select to_regclass('public.invites')").fetchone()[0]:
            conn.execute("update public.invites set revoked_at = now() where used_at is null and revoked_at is null and expires_at > now()")


def _apply(url: str, path: str, purged: Path | None, purge_log: str, sign_out: bool = True) -> None:
    _empty(url)
    _load(url, path)
    if sign_out:
        _sign_everyone_out(url)
    if purged and purged.exists():
        have = set(Path(purge_log).read_text().split("\n")) if os.path.exists(purge_log) else set()
        lines = [x for x in dict.fromkeys(purged.read_text().replace("\r", "").split("\n")) if x.strip() and x not in have]
        if lines:
            with open(purge_log, "a") as log:
                log.write("\n".join(lines) + "\n")
    _repurge(url, purge_log)


def _record(where: Path, status: str, detail: str | None = None) -> None:
    (where / STATUS).write_text(json.dumps({"status": status, "at": datetime.now(timezone.utc).isoformat(), "detail": detail}))


def restore_if_requested(url: str, backup_dir: str, purge_log: str | None = None) -> str | None:
    """'done' or 'failed' when a restore was waiting, None otherwise. Never raises: the server starts either way."""
    where = folder(backup_dir)
    request = where / REQUEST
    if not request.exists():
        return None
    purge_log = purge_log or os.environ.get("PURGE_LOG") or os.path.join(backup_dir, "purged_accounts.jsonl")
    _record(where, "running")
    before = None
    try:
        check(request)
        before, _, _ = backup.run_backup(url, backup_dir)
        _apply(url, str(request), where / PURGED, purge_log)
        _record(where, "done")
        print(f"restored the uploaded backup; the database before it is in {os.path.basename(before)}", flush=True)
        return "done"
    except Exception as e:
        reason = backup._scrub(str(e), url).splitlines()[0] if str(e) else type(e).__name__
        if before:
            try:
                _apply(url, before, None, purge_log, sign_out=False)     # taken seconds ago: its sessions are the live ones
            except Exception as again:
                reason += f"; putting the database back failed too ({backup._scrub(str(again), url).splitlines()[0]}):" \
                          f" restore {os.path.basename(before)} by hand"
        _record(where, "failed", reason)
        print(f"restoring the uploaded backup failed: {reason}", flush=True)
        return "failed"
    finally:
        for name in (REQUEST, PURGED):
            (where / name).unlink(missing_ok=True)
