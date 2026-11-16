# The `waterflow` image: the API, the built web app and the daily jobs, in one.
# Built on the operator's machine (no published images): docker-compose.yml
# builds it and runs it twice, `secrets` (first start only) and `waterflow`.
#   docker build -t waterflow .

# The web app, built once into static files the API serves.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM python:3.14-slim-trixie
# pg_dump for the backups, the same major version as the database (17).
# Debian 13 (this image's base) ships PostgreSQL 17.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/lib/postgresql/17/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WEB_DIR=/srv/web

WORKDIR /srv
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY backend/migrations ./migrations
COPY VERSION ./VERSION
COPY --from=web /web/dist ./web

# Starts as root only to set up these folders on every start, then runs as two
# users (app/core/users.py): waterflow (the launcher and the jobs) and
# waterflow-api (the API), which share the group waterflow-files for the
# backups and updates folders. The volumes start from these folders.
RUN groupadd --system --gid 10001 waterflow \
 && groupadd --system --gid 10002 waterflow-api \
 && groupadd --system --gid 10003 waterflow-files \
 && useradd --system --uid 10001 --gid waterflow --groups waterflow-files waterflow \
 && useradd --system --uid 10002 --gid waterflow-api --groups waterflow-files waterflow-api \
 && mkdir /secrets /backups /updates \
 && chown waterflow:waterflow /secrets && chmod 711 /secrets \
 && chown waterflow:waterflow-files /backups /updates && chmod 2770 /backups /updates

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/v1/health', timeout=4)"
CMD ["python", "-m", "app.launch"]
