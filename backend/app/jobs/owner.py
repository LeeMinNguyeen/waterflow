"""The built-in database comes with one login, the superuser postgres. The server doesn't run as it: on every start
it makes sure a role that is no superuser owns the app's schemas and everything in them, and uses that one for the
migrations, the backups and a restore. A backup someone crafted then runs as a role that can't reach beyond the
app's own data, at the restore and whenever its triggers or functions run later.

Not for a server with its own database (ADMIN_DATABASE_URL): its owner is the operator's choice."""
import psycopg
from psycopg import sql

from app.jobs import migrate

OWNER = "waterflow_owner"
SCHEMAS = ("public", "waterflow", "msaving")
ROLES = (*migrate.LOGINS, *migrate.LOGINS.values())

# What the old owner still has in the app's schemas, each with the statement that hands it over. A sequence a column
# owns follows its table, and what belongs to an extension follows the extension.
THEIRS = """
with mine as (select oid from pg_namespace where nspname = any(%(schemas)s)),
     extension as (select objid from pg_depend where deptype = 'e')
select format('alter schema %%I owner to %%I', n.nspname, %(owner)s::text)
  from pg_namespace n where n.oid in (select oid from mine) and n.nspowner <> %(owner)s::regrole
union all
select format('alter %%s %%s owner to %%I', case c.relkind when 'm' then 'materialized view' when 'v' then 'view'
              when 'S' then 'sequence' when 'f' then 'foreign table' else 'table' end, c.oid::regclass, %(owner)s::text)
  from pg_class c
 where c.relnamespace in (select oid from mine) and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
   and c.relowner <> %(owner)s::regrole and c.oid not in (select objid from extension)
   and not (c.relkind = 'S' and exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i')))
union all
select format('alter routine %%s owner to %%I', p.oid::regprocedure, %(owner)s::text)
  from pg_proc p
 where p.pronamespace in (select oid from mine) and p.proowner <> %(owner)s::regrole
   and p.oid not in (select objid from extension)
union all
select format('alter type %%s owner to %%I', t.oid::regtype, %(owner)s::text)
  from pg_type t
 where t.typnamespace in (select oid from mine) and t.typowner <> %(owner)s::regrole
   and t.oid not in (select objid from extension)
   and (t.typtype in ('e', 'd', 'r') or (t.typtype = 'c' and (select relkind from pg_class where oid = t.typrelid) = 'c'))
"""


def hand_over(superuser_url: str, password: str, owner: str = OWNER) -> None:
    """Safe to repeat. All or nothing: a hand-over that fails leaves the database as it was, and raises."""
    name = sql.Identifier(owner)
    with psycopg.connect(superuser_url) as conn:
        if conn.execute("select 1 from pg_roles where rolname = %s", (owner,)).fetchone():
            conn.execute(sql.SQL("alter role {} login createrole nosuperuser nobypassrls nocreatedb password {}")
                         .format(name, sql.Literal(password)))
        else:
            conn.execute(sql.SQL("create role {} login createrole nosuperuser nobypassrls password {}")
                         .format(name, sql.Literal(password)))
        database = conn.execute("select current_database()").fetchone()[0]
        conn.execute(sql.SQL("grant create on database {} to {}").format(sql.Identifier(database), name))
        # Since PostgreSQL 16 a role changes only the roles it has the admin option on; it gets that by itself on the
        # ones it makes, not on those the superuser made before.
        for (role,) in conn.execute("select rolname from pg_roles where rolname = any(%s)", (list(ROLES),)).fetchall():
            conn.execute(sql.SQL("grant {} to {} with admin option, inherit false, set false").format(sql.Identifier(role), name))
        for (statement,) in conn.execute(THEIRS, {"schemas": list(SCHEMAS), "owner": owner}).fetchall():
            conn.execute(statement)
        # pgcrypto has no ALTER OWNER, nothing uses its functions, and dropping schema public (a restore) takes its
        # owner: made again by the new one.
        if conn.execute("select 1 from pg_extension where extname = 'pgcrypto' and extowner <> %s::regrole", (owner,)).fetchone():
            conn.execute("drop extension pgcrypto")
            conn.execute(sql.SQL("set local role {}").format(name))
            conn.execute("create extension pgcrypto schema public")
            conn.execute("reset role")
        conn.execute(sql.SQL("alter default privileges for role {} revoke execute on functions from public").format(name))
