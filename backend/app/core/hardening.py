import ctypes
import sys

PR_SET_DUMPABLE = 4


def hide_environment() -> None:
    """On Linux, other processes of the same user can no longer read this one's environment (/proc/<pid>/environ) or
    attach to it, from this call on. It lasts until the next exec, so a process calls it itself as it starts; one it
    runs that can't (pg_dump) stays readable. Not a boundary on its own: the same user can still read the secrets
    folder and catch a process before this call."""
    if sys.platform.startswith("linux"):
        try:
            ctypes.CDLL(None).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
        except (OSError, AttributeError):
            pass
