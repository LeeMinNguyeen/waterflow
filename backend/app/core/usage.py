"""Usage numbers for the server's admin (off unless they turn it on): a route says which feature was used, and the
database counts it for today and the signed-in user. Call it before the route's commit."""
from sqlalchemy import text
from sqlalchemy.orm import Session


def count(db: Session, feature: str) -> None:
    db.execute(text("select usage_count(:f)"), {"f": feature})
