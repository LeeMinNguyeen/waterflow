"""The server: the API under /v1, and the web app's files for everything else.
Run for development: uvicorn app.api.main:app --reload
"""
import logging
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api import errors
from app.api.deps import get_public_db
from app.api.routes.v1 import (accounts, admin, books, budgets, categories, contacts, dashboard, installments, me, members,
                               reference, restore, sign_in, transactions)
from app.core import updates
from app.core.settings import settings

# Additive changes only within /v1: a client that needs something newer checks api_version.
API_VERSION = 1
SERVER_VERSION = updates.current_version()



class _WithoutQuery(logging.Filter):
    """uvicorn's access log, minus query strings: reset and invite links carry their secret there."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            record.args = (*args[:2], args[2].split("?", 1)[0], *args[3:])
        return True


logging.getLogger("uvicorn.access").addFilter(_WithoutQuery())

app = FastAPI(title="Waterflow API", docs_url=None, redoc_url=None, openapi_url="/v1/openapi.json")
errors.install(app)

# A restore's upload is refused by its size before FastAPI reads the whole body to disk, which it does before any
# check of who's asking.
RESTORES = {"/v1/admin/restore", "/v1/setup/restore"}


@app.middleware("http")
async def refuse_oversized_restores(request: Request, call_next):
    if request.method == "POST" and request.url.path in RESTORES:
        length = request.headers.get("content-length", "")
        if ("transfer-encoding" in request.headers or not length.isdigit()
                or int(length) > restore.MAX_DUMP + restore.MAX_PURGED + 2**20):
            return JSONResponse({"detail": "restore_too_large"}, status_code=413)
    return await call_next(request)

# Only this server's own web app may call the API from a browser: browsers send Origin, so a copy of the web app
# hosted anywhere else is refused before anything runs. Phones send no Origin. Behind a reverse proxy the browser's
# address is in Host (Caddy, Tailscale and Cloudflare Tunnel keep it) or X-Forwarded-Host, which Vite's proxy also
# sends in development.
def own_origin(origin: str, request: Request) -> bool:
    host = urlsplit(origin).netloc.lower()
    allowed = {request.headers.get("host", ""), *request.headers.get("x-forwarded-host", "").split(",")}
    return bool(host) and host in {h.strip().lower() for h in allowed if h.strip()}


@app.middleware("http")
async def own_web_app_only(request: Request, call_next):
    origin = request.headers.get("origin")
    if request.url.path.startswith("/v1/") and origin is not None and not own_origin(origin, request):
        return JSONResponse({"detail": "origin_not_allowed"}, status_code=403, headers={"Cache-Control": "no-store"})
    return await call_next(request)


# MUI's styling (Emotion) adds <style> tags at runtime; QR codes are data: images.
CSP = "; ".join([
    "default-src 'self'", "connect-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
])


@app.middleware("http")
async def headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/v1/"):
        # Personal finance data: no cache anywhere may keep a response.
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers["Content-Security-Policy"] = CSP
        immutable = request.url.path.startswith("/assets/")
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"     # reset and invite links carry secrets
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response


v1 = APIRouter(prefix="/v1")


@v1.get("/health")
def health() -> dict:
    return {"ok": True}


class Instance(BaseModel):
    name: str
    server_version: str
    api_version: int
    signup: str             # invite | open
    setup_needed: bool      # no admin yet


@v1.get("/instance")
def instance(db: Session = Depends(get_public_db)) -> Instance:
    row = db.execute(text("select * from instance_info()")).mappings().one()
    return Instance(server_version=SERVER_VERSION, api_version=API_VERSION, **row)


for module in (sign_in, admin, restore, me, reference, books, members, accounts, contacts, categories, budgets,
               transactions, installments, dashboard):
    v1.include_router(module.router)
app.include_router(v1)


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"], include_in_schema=False)
def unknown_api(path: str):
    return JSONResponse({"detail": "not_found"}, status_code=404)


@app.get("/{path:path}", include_in_schema=False)
def web(path: str):
    root = settings.web_dir.resolve()
    if not root.is_dir():
        return JSONResponse({"detail": "not_found"}, status_code=404)
    file = (root / path).resolve()
    if path and file.is_file() and file.is_relative_to(root):
        return FileResponse(file)
    return FileResponse(root / "index.html")
