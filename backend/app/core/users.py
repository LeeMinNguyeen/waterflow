"""On the built-in database (compose) the container starts as root only to set up its folders, then runs as two
users: the launcher and the jobs as `waterflow`, the API as `waterflow-api`, which can't read the secrets folder or
the launcher's and the jobs' environments. Both share the group `waterflow-files` for the backups (the API restores
and downloads them) and the updates folder. The users and groups are made in the Dockerfile with these ids.

On Cloud Run the mounts decide who owns what (the bucket is mounted for uid 10001), and the service account can read
the secrets anyway: everything runs as `waterflow`. Not started as root (development, the tests), nothing changes."""
import contextlib
import os
import signal
import stat
import threading
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


def _fix(dir_fd: int | None, name: str | Path, uid: int, gid: int, mode: int, directory: bool) -> None:
    """Never through a link, and never a file with another name somewhere (a hard link): the API can write the
    shared folders, and this runs as root or as the launcher."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if directory else 0)
    try:
        fd = os.open(name, flags, dir_fd=dir_fd)
    except OSError:
        return
    try:
        st = os.fstat(fd)
        if (stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode) and st.st_nlink == 1):
            os.fchown(fd, uid, gid)
            os.fchmod(fd, mode)
    except OSError as e:
        print(f"WARNING: couldn't set {name} to {mode:o}: {e.strerror}", flush=True)
    finally:
        os.close(fd)


def prepare_as_root(secrets: Path, backups: Path | None = None, updates: Path | None = None, ids: Ids = IDS) -> None:
    """Every start, so a server from before (one user, files 0600 or 0644) is put right: the secrets and the top of the
    shared folders. What's inside the shared folders is the launcher's to fix, as itself (prepare_as_launcher)."""
    if secrets.is_dir() and not secrets.is_symlink():
        _fix(None, secrets, ids.launcher, ids.launcher_group, 0o711, directory=True)
        for name in os.listdir(secrets):
            if name == "postgres_password":
                _fix(None, secrets / name, ids.launcher, ids.database_group, 0o640, directory=False)
            else:
                _fix(None, secrets / name, ids.launcher, ids.launcher_group, 0o600, directory=False)
    for top, top_mode in ((backups, 0o3770), (updates, 0o2770)):
        if top is not None:
            _fix(None, top, ids.launcher, ids.files, top_mode, directory=True)


def prepare_as_launcher(backups: Path, purge_log: Path, ids: Ids = IDS) -> None:
    """As the launcher: its own files in the backups folder readable by the API's group (backups from before were
    0600), the restore folders, and the purged-accounts list made before the API could make one of its own."""
    if not backups.is_dir():
        return
    for name, dir_mode in (("restore", 0o3770), ("restore-state", 0o2750)):
        with contextlib.suppress(FileExistsError):
            os.mkdir(backups / name)
        _fix(None, backups / name, ids.launcher, ids.files, dir_mode, directory=True)
    try:
        os.close(os.open(purge_log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640))
    except OSError:
        pass
    me = os.geteuid()
    for _, _, files, dir_fd in os.fwalk(backups, follow_symlinks=False):
        for name in files:
            try:
                st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode) and st.st_uid == me:
                _fix(dir_fd, name, me, ids.files, (st.st_mode & 0o7777) | 0o040, directory=False)


def append_own(path: Path, text: str) -> None:
    """Appends to a file in a folder the API can write: never through a link, and only to a file this user owns."""
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o640)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid():
            raise PermissionError(f"{path} isn't this server's own file")
        os.write(fd, text.encode())
        os.fsync(fd)
    finally:
        os.close(fd)


def become(uid: int, gid: int, files: int | None = None) -> Callable[[], None]:
    """For a child's preexec_fn, or to call in this process: the user, its group and the shared files group, for good."""
    def switch() -> None:
        os.setresuid(0, 0, 0)      # the launcher keeps root only as its saved id, until its last child is started
        os.setgroups([g for g in (gid, files) if g is not None])
        os.setresgid(gid, gid, gid)
        os.setresuid(uid, uid, uid)
        os.umask(0o027)
    return switch


def drop_keeping_root(ids: Ids = IDS) -> None:
    """The launcher runs as `waterflow` from here on, keeping root only as its saved id so it can still start the API
    as `waterflow-api`; `drop()` lets that go too once it has."""
    os.setgroups([ids.launcher_group, ids.files])
    os.setresgid(ids.launcher_group, ids.launcher_group, ids.launcher_group)
    os.setresuid(ids.launcher, ids.launcher, 0)
    os.umask(0o027)


def drop(ids: Ids = IDS) -> None:
    os.setresuid(ids.launcher, ids.launcher, ids.launcher)


def watch_launcher(fd: int) -> None:
    """In the API: the launcher, running as another user, can't signal it. It closes this pipe instead (to stop the
    server, or because it stopped), and the API stops itself the way the signal would."""
    def wait() -> None:
        while os.read(fd, 1):
            pass
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=wait, daemon=True).start()
