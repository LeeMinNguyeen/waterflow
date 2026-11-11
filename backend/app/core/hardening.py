import ctypes

PR_SET_DUMPABLE = 4


def hide_environment() -> None:
    """On Linux, other processes of the same user can no longer read this one's environment (/proc/<pid>/environ) or
    attach to it. It lasts until the next exec, so every process holding a database password calls it itself. A
    process they start (pg_dump) can't; elsewhere it does nothing."""
    try:
        ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
    except (OSError, AttributeError):
        pass
