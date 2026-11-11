"""Restoring a backup from the web app: the admin on Server admin, or whoever installed the server at setup (with
the setup code). The API never has the database owner's login, so it only checks the file, leaves it in
BACKUP_DIR/restore/ and stops the server; the launcher restores it as the server starts again
(app/jobs/restore.py). Everyone is signed out: the restored database has the sessions of the backup's day."""
import io
import json
import os
import shutil
import signal
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import get_db, get_public_db
from app.api.routes.v1.sign_in import _client_ip, _limit
from app.core import sign_in as si
from app.core.auth import Caller, current_caller
from app.jobs import backup, restore

router = APIRouter()

MAX_DUMP = 100 * 2**20
MAX_PURGED = 10 * 2**20


def stop_server() -> None:
    """The launcher stops its children and exits; Docker, or Cloud Run, starts the server again."""
    os.kill(int(os.environ.get("LAUNCHER_PID") or os.getpid()), signal.SIGTERM)


def _backup_dir() -> str:
    return os.environ.get("BACKUP_DIR", "/backups")


def _copy(upload: UploadFile, to: Path, limit: int) -> None:
    """Owner-only, like the nightly backups: a backup holds password hashes."""
    size = 0
    fd = os.open(to, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as out:
        while chunk := upload.file.read(2**20):
            size += len(chunk)
            if size > limit:
                break
            out.write(chunk)
    if size > limit:
        to.unlink()
        raise HTTPException(413, "restore_too_large")


def _write(source, to: Path, size: int) -> None:
    fd = os.open(to, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as out:
        shutil.copyfileobj(source, out)
    if to.stat().st_size != size:
        raise HTTPException(422, "restore_invalid")


def _plain_tar(path: Path) -> bool | None:
    """False: not a tar. True: a tar of at most two plain files. None: any other tar. Read by hand, because tarfile
    runs its extended-header parsing (pax records, long names, sparse maps) on whatever a file claims, before any
    check here: a crafted upload could make that slow, take gigabytes of memory, or fail in ways it doesn't name."""
    with open(path, "rb") as f:
        for member in range(3):
            header = f.read(512)
            if member == 0 and header[257:262] != b"ustar":
                return False
            if not header.strip(b"\0"):
                return member > 0
            size = header[124:136].strip(b" \0")
            if len(header) < 512 or header[156:157] not in (b"0", b"\0") or not size or size.strip(b"01234567"):
                return None
            f.seek((int(size, 8) + 511) // 512 * 512, os.SEEK_CUR)
    return None


def _unpack(partial: Path, where: Path) -> bool:
    """A downloaded backup (.tar): exactly a backup and, if there, the list of accounts deleted for good, plain files
    under their own names; nothing is extracted by its own path. The backup replaces the upload. True when the list
    came with it."""
    plain = _plain_tar(partial)
    if plain is False:
        return False
    if plain is None:
        raise HTTPException(422, "restore_invalid")
    dump, listed = where / "upload.dump.partial", where / "upload.purged.partial"
    seen = {}
    try:
        with tarfile.open(partial, mode="r:") as tar:              # uncompressed only: no decompression bomb
            for i, m in enumerate(tar):
                is_dump = bool(backup.DUMP_NAME.fullmatch(m.name)) and not m.name.endswith(".partial")
                kind = "dump" if is_dump else "purged" if m.name == restore.PURGED else None
                if i >= 2 or kind is None or kind in seen or not m.isreg() or \
                        m.size > (MAX_DUMP if kind == "dump" else MAX_PURGED):
                    raise HTTPException(422, "restore_invalid")
                seen[kind] = True
                _write(tar.extractfile(m), dump if kind == "dump" else listed, m.size)
    except (tarfile.TarError, ValueError):
        raise HTTPException(422, "restore_invalid") from None
    if "dump" not in seen:
        raise HTTPException(422, "restore_invalid")
    os.replace(dump, partial)
    if "purged" in seen:
        os.replace(listed, where / restore.PURGED)
    return "purged" in seen


def _leave_request(dump: UploadFile, purged: UploadFile | None, background: BackgroundTasks) -> Response:
    where = restore.folder(_backup_dir())
    where.mkdir(parents=True, exist_ok=True)
    partial = where / "upload.partial"
    leftovers = (partial, where / "upload.dump.partial", where / "upload.purged.partial", where / restore.PURGED)
    _copy(dump, partial, MAX_DUMP + MAX_PURGED + 2**20)            # a download is a little bigger than its backup
    (where / restore.PURGED).unlink(missing_ok=True)
    try:
        listed = _unpack(partial, where)
        if partial.stat().st_size > MAX_DUMP:
            raise HTTPException(413, "restore_too_large")
        restore.check(partial)
    except (HTTPException, restore.RestoreError) as e:
        for f in leftovers:
            f.unlink(missing_ok=True)
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(409, "restore_too_new") if isinstance(e, restore.TooNew) else HTTPException(422, "restore_invalid") from None
    if purged is not None and not listed:
        _copy(purged, where / restore.PURGED, MAX_PURGED)
    os.replace(partial, where / restore.REQUEST)
    (where / restore.STATUS).write_text(json.dumps({"status": "requested", "at": datetime.now(timezone.utc).isoformat(),
                                                    "detail": None}))
    background.add_task(stop_server)
    return Response(status_code=202)


class Proof(BaseModel):
    password: Annotated[str, Field(max_length=256)]
    code: Annotated[str | None, Field(max_length=20)] = None


def _proves_it(db: Session, caller: Caller, proof: Proof) -> None:
    """The password again, and the two-step code when it's on: a stolen session isn't enough to take every user's
    data or replace the server."""
    if not db.execute(text("select am_admin()")).scalar():
        raise HTTPException(403, "admin_only")
    _limit((si.per_user_action, str(caller.id)))
    row = db.execute(text("select password_hash, totp_secret from local_credentials where user_id = :u"),
                     {"u": caller.id}).mappings().one()
    if not si.password_matches(row["password_hash"], proof.password):
        raise HTTPException(401, "invalid_credentials")
    if row["totp_secret"]:
        if not proof.code:
            raise HTTPException(401, "code_required")
        if not si.totp_accepted(db, caller.id, row["totp_secret"], proof.code):
            raise HTTPException(401, "invalid_code")
        db.commit()


@router.post("/admin/restore", status_code=202)
def admin_restore(background: BackgroundTasks, file: UploadFile, password: Annotated[str, Form(max_length=256)],
                  confirm: Annotated[bool, Form()], code: Annotated[str | None, Form(max_length=20)] = None,
                  purged: UploadFile | None = None, caller: Caller = Depends(current_caller),
                  db: Session = Depends(get_db)) -> Response:
    if not db.execute(text("select am_admin()")).scalar():
        raise HTTPException(403, "admin_only")
    if not confirm:
        raise HTTPException(422, "invalid")
    _proves_it(db, caller, Proof(password=password, code=code))
    return _leave_request(file, purged, background)


@router.post("/setup/restore", status_code=202)
def setup_restore(request: Request, background: BackgroundTasks, file: UploadFile,
                  setup_code: Annotated[str, Form(max_length=40)], purged: UploadFile | None = None,
                  db: Session = Depends(get_public_db)) -> Response:
    """Instead of creating the admin: the setup code from the log proves whoever asks installed the server."""
    _limit((si.per_ip, f"setup:{_client_ip(request)}"))
    if not db.execute(text("select setup_code_matches(:c)"), {"c": si.code_hash(setup_code)}).scalar():
        raise HTTPException(403, "setup_invalid")
    return _leave_request(file, purged, background)


class Backup(BaseModel):
    name: str
    size: int
    taken_at: datetime


def _backups() -> list[Path]:
    """The finished backups in the folder, newest first."""
    folder = Path(_backup_dir())
    names = [n for n in os.listdir(folder) if (m := backup.DUMP_NAME.fullmatch(n)) and not m[2]] if folder.is_dir() else []
    return [folder / n for n in sorted(names, key=lambda n: backup.DUMP_NAME.fullmatch(n)[1], reverse=True)]


@router.get("/admin/backups")
def list_backups(db: Session = Depends(get_db)) -> list[Backup]:
    if not db.execute(text("select am_admin()")).scalar():
        raise HTTPException(403, "admin_only")
    return [Backup(name=p.name, size=p.stat().st_size,
                   taken_at=datetime.strptime(backup.DUMP_NAME.fullmatch(p.name)[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc))
            for p in _backups()]


@router.post("/admin/backups/{name}/download")
def download_backup(name: str, proof: Proof, background: BackgroundTasks, caller: Caller = Depends(current_caller),
                    db: Session = Depends(get_db)) -> FileResponse:
    """One file that restores on its own: the backup and this server's list of accounts deleted for good, as it is
    now (it must cover every account deleted after the backup was taken)."""
    _proves_it(db, caller, proof)
    path = next((p for p in _backups() if p.name == name), None)
    if path is None:
        raise HTTPException(404, "not_found")
    purged = Path(os.environ.get("PURGE_LOG") or Path(_backup_dir()) / restore.PURGED)
    fd, out = tempfile.mkstemp(suffix=".tar")
    os.close(fd)
    try:
        with tarfile.open(out, mode="w:", format=tarfile.USTAR_FORMAT) as tar:         # no extended headers: see _plain_tar
            tar.add(path, arcname=path.name)
            info = tarfile.TarInfo(restore.PURGED)
            data = purged.read_bytes() if purged.is_file() else b""
            info.size, info.mtime = len(data), int(datetime.now(timezone.utc).timestamp())
            tar.addfile(info, io.BytesIO(data))
    except BaseException:
        os.unlink(out)
        raise
    background.add_task(os.unlink, out)
    print(f"backup downloaded: {name} by {caller.id}", flush=True)
    return FileResponse(out, media_type="application/x-tar", filename=name.removesuffix(".dump") + ".tar")


class RestoreStatus(BaseModel):
    status: str                 # requested, running, done or failed
    at: datetime
    detail: str | None          # why it failed


@router.get("/admin/restore")
def restore_status(db: Session = Depends(get_db)) -> RestoreStatus | None:
    """The last restore from the web app, or null."""
    if not db.execute(text("select am_admin()")).scalar():
        raise HTTPException(403, "admin_only")
    status = restore.folder(_backup_dir()) / restore.STATUS
    return RestoreStatus(**json.loads(status.read_text())) if status.exists() else None
