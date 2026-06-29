"""Kaval Python SDK — talk to the kaval currentness REST API."""

from importlib.metadata import PackageNotFoundError, version

from .client import KavalClient, KavalError

__all__ = ["KavalClient", "KavalError"]

try:
    # Single source of truth: read the installed distribution's version (set in pyproject.toml)
    # so __version__ can never drift from the package metadata / wheel filename.
    __version__ = version("kaval")
except PackageNotFoundError:  # running from source without an install
    __version__ = "0.0.0+unknown"
