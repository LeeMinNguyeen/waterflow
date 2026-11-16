"""On the built-in database (compose) the container starts as root only to set up its folders, then runs as two
users: the launcher and the jobs as `waterflow`, the API as `waterflow-api`, which can't read the secrets folder or
the launcher's and the jobs' environments. Both share the group `waterflow-files` for the backups (the API restores
and downloads them) and the updates folder. The users and groups are made in the Dockerfile with these ids.

On Cloud Run the mounts decide who owns what (the bucket is mounted for uid 10001), and the service account can read
the secrets anyway: everything runs as `waterflow`. Not started as root (development, the tests), nothing changes."""
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Ids:
    launcher: int
    launcher_group: int
    api: int
    api_group: int
    files: int
    database_group: int            # the postgres image's: the database container reads its password file with it


IDS = Ids(launcher=10001, launcher_group=10001, api=10002, api_group=10002, files=10003, database_group=999)


def plan(euid: int, env: Mapping[str, str]) -> str:
    """"as_is", "one_user" or "split"."""
    if euid != 0:
        return "as_is"
    if env.get("K_SERVICE") or env.get("CLOUD_RUN_JOB"):
        return "one_user"
    return "split"


def _own(path: Path, uid: int, gid: int, mode: int) -> None:
    try:
        os.chown(path, uid, gid)
        os.chmod(path, mode)
    except OSError as e:           # a read-only mount, a file another container owns: carry on, said once
        print(f"WARNING: couldn't set {path} to {mode:o}: {e.strerror}", flush=True)


def prepare(secrets: Path, backups: Path | None = None, updates: Path | None = None, ids: Ids = IDS) -> None:
    """Every start, so a server from before (one user, files 0600 or 0644) is put right."""
    if secrets.is_dir():
        _own(secrets, ids.launcher, ids.launcher_group, 0o711)
        for f in secrets.iterdir():
            if f.name == "postgres_password":
                _own(f, ids.launcher, ids.database_group, 0o640)
            elif f.is_file():
                _own(f, ids.launcher, ids.launcher_group, 0o600)
    for top in (backups, updates):
        if top is None or not top.is_dir():
            continue
        for d, dirs, files in os.walk(top):
            _own(Path(d), ids.launcher if Path(d) == top else os.stat(d).st_uid, ids.files, 0o2770)
            for name in files:
                f = Path(d, name)
                _own(f, f.stat().st_uid, ids.files, (f.stat().st_mode & 0o7777) | 0o040)


def become(uid: int, gid: int, files: int | None = None) -> Callable[[], None]:
    """For a child's preexec_fn, or to call in this process: the user, its group and the shared files group, for good."""
    def switch() -> None:
        os.setresuid(0, 0, 0)      # the launcher keeps root only as its saved id, until its last child is started
        os.setgroups([g for g in (gid, files) if g is not None])
        os.setresgid(gid, gid, gid)
        os.setresuid(uid, uid, uid)
        os.umask(0o007)
    return switch


def drop_keeping_root(ids: Ids = IDS) -> None:
    """The launcher runs as `waterflow` from here on, keeping root only as its saved id so it can still start the API
    as `waterflow-api`; `drop()` lets that go too once it has."""
    os.setgroups([ids.launcher_group, ids.files])
    os.setresgid(ids.launcher_group, ids.launcher_group, ids.launcher_group)
    os.setresuid(ids.launcher, ids.launcher, 0)
    os.umask(0o007)


def drop(ids: Ids = IDS) -> None:
    os.setresuid(ids.launcher, ids.launcher, ids.launcher)
