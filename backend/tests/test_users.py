"""On the built-in database the container starts as root only to set up its folders, then runs as two users: the
launcher and the jobs as one, the API as another that can't read the secrets folder."""
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest


def test_how_the_container_runs_depends_on_where():
    from app.core.users import plan
    assert plan(euid=1000, env={}) == "as_is"                                   # development, the tests
    assert plan(euid=0, env={}) == "split"                                      # compose
    assert plan(euid=0, env={"ADMIN_DATABASE_URL": "postgresql://o@db/x"}) == "split"
    assert plan(euid=0, env={"K_SERVICE": "waterflow"}) == "one_user"           # Cloud Run: its mounts set the owner
    assert plan(euid=0, env={"CLOUD_RUN_JOB": "waterflow-jobs"}) == "one_user"


def _folders(tmp_path):
    secrets, backups, updates = tmp_path / "secrets", tmp_path / "backups", tmp_path / "updates"
    for d in (secrets, backups / "restore", updates):
        d.mkdir(parents=True)
    for f in ("db_logins.json", "owner_password", "postgres_password"):
        (secrets / f).write_text("secret")
        os.chmod(secrets / f, 0o644)
    return secrets, backups, updates


def _own_ids():
    from app.core import users
    uid, gid = os.getuid(), os.getgid()
    return users.Ids(launcher=uid, launcher_group=gid, api=uid, api_group=gid, files=gid, database_group=gid)


def mode(p):
    return stat.S_IMODE(os.lstat(p).st_mode)


def test_the_folders_are_set_up_for_the_two_users(tmp_path):
    """Run as a normal user with its own ids standing in for the server's: the modes are what's checked."""
    from app.core import users
    secrets, backups, updates = _folders(tmp_path)
    old = backups / "waterflow-20261101T000000Z.dump"
    old.write_bytes(b"x")
    os.chmod(old, 0o600)
    users.prepare_as_root(secrets, backups, updates, _own_ids())
    users.prepare_as_launcher(backups, backups / "purged_accounts.jsonl", _own_ids())

    assert mode(secrets) == 0o711
    assert (mode(secrets / "db_logins.json"), mode(secrets / "owner_password")) == (0o600, 0o600)
    assert mode(secrets / "postgres_password") == 0o640                         # the database container's group reads it
    assert mode(backups) == mode(backups / "restore") == 0o3770                 # shared, and no one removes another's files
    assert mode(backups / "restore-state") == 0o2750                            # the launcher's alone; the API reads it
    assert mode(updates) == 0o2770
    assert mode(old) == 0o640
    assert (backups / "purged_accounts.jsonl").is_file()                        # made by the launcher, before the API could


def test_nothing_the_api_plants_in_the_shared_folders_is_followed(tmp_path):
    """The API can write the backups and updates folders: a link or a hard link it leaves there must not make root or
    the launcher change the file it points at."""
    from app.core import users
    secrets, backups, updates = _folders(tmp_path)
    os.chmod(secrets / "owner_password", 0o600)
    (backups / "a").symlink_to(secrets / "owner_password")
    (backups / "restore" / "b").symlink_to(secrets / "db_logins.json")
    (updates / "c").symlink_to(secrets / "postgres_password")
    (backups / "d").mkdir()
    (backups / "d" / "e").symlink_to(secrets)
    os.chmod(secrets / "db_logins.json", 0o600)
    os.chmod(secrets / "postgres_password", 0o600)
    before = {f: mode(secrets / f) for f in ("owner_password", "db_logins.json", "postgres_password")}
    users.prepare_as_launcher(backups, backups / "purged_accounts.jsonl", _own_ids())
    users.prepare_as_root(tmp_path / "nowhere", backups, updates, _own_ids())
    assert {f: mode(secrets / f) for f in before} == before


def test_the_launcher_appends_only_to_its_own_file(tmp_path):
    from app.core import users
    target = tmp_path / "target"
    target.write_text("")
    (tmp_path / "log").symlink_to(target)
    with pytest.raises(OSError):
        users.append_own(tmp_path / "log", "line\n")
    assert target.read_text() == ""
    users.append_own(tmp_path / "new", "line\n")
    users.append_own(tmp_path / "new", "more\n")
    assert (tmp_path / "new").read_text() == "line\nmore\n"


def test_a_backup_and_an_upload_are_readable_by_the_other_user(tmp_path, monkeypatch):
    from app.jobs import backup
    final, fd = backup._reserve(str(tmp_path), __import__("datetime").datetime(2026, 11, 1))
    os.close(fd)
    assert stat.S_IMODE(os.stat(final + ".partial").st_mode) & 0o040


def test_the_api_asks_the_launcher_to_stop_through_a_pipe(client, monkeypatch):
    """The API can't signal the launcher when it runs as another user: it writes to a pipe the launcher reads."""
    from app.api.routes.v1 import restore
    read, write = os.pipe()
    os.set_inheritable(write, True)
    monkeypatch.setenv("STOP_FD", str(write))
    monkeypatch.setattr(restore.os, "kill", lambda *a: pytest.fail("signalled instead"))
    restore.stop_server()
    assert os.read(read, 1) == b"x"


def test_the_launcher_stops_its_children_when_asked_through_the_pipe():
    from app import launch
    read, write = os.pipe()
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    os.write(write, b"x")
    assert launch.supervise([child], read) == 0 or child.returncode is not None
    assert child.poll() is not None


def test_the_api_stops_itself_when_the_launcher_lets_go(monkeypatch):
    """The launcher can't signal the API either: it closes a pipe the API watches, and the API stops itself."""
    import signal
    import threading
    from app.core import users
    read, write = os.pipe()
    stopped = threading.Event()
    monkeypatch.setattr(users.os, "kill", lambda pid, sig: stopped.set() if (pid, sig) == (os.getpid(), signal.SIGTERM) else None)
    users.watch_launcher(read)
    assert not stopped.wait(0.2)
    os.close(write)
    assert stopped.wait(5)


def test_the_launcher_lets_go_of_a_child_it_cant_signal(monkeypatch):
    from app import launch
    read, write = os.pipe()
    alive_read, alive_write = os.pipe()
    child = subprocess.Popen([sys.executable, "-c", "import os, sys; os.read(int(sys.argv[1]), 1)", str(alive_read)],
                             pass_fds=(alive_read,))
    os.close(alive_read)
    monkeypatch.setattr(child, "terminate", lambda: (_ for _ in ()).throw(PermissionError(1, "Operation not permitted")))
    os.write(write, b"x")
    assert launch.supervise([child], read, alive_write) == 0
    assert child.poll() == 0


@pytest.mark.skipif(os.geteuid() != 0, reason="switching users needs root")
def test_as_root_the_api_runs_as_its_own_user():
    from app.core import users
    out = subprocess.run([sys.executable, "-c", "import os; print(os.getuid(), os.getgroups())"],
                         preexec_fn=users.become(users.IDS.api, users.IDS.api_group), capture_output=True, text=True)
    assert out.stdout.split()[0] == str(users.IDS.api)
