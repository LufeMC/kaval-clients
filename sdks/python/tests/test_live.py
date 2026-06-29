"""Opt-in live test against a running REST server. Skipped unless KAVAL_BASE_URL is set."""

import os

import pytest

from kaval import KavalClient

BASE_URL = os.environ.get("KAVAL_BASE_URL")
STATUSES = {"current", "stale", "contradicted", "unsupported", "conflicting", "insufficient"}


@pytest.mark.skipif(not BASE_URL, reason="KAVAL_BASE_URL not set")
def test_live_check_end_to_end():
    with KavalClient(BASE_URL, api_key=os.environ.get("KAVAL_API_KEY")) as client:
        assert client.health()["ok"] is True
        gap = client.check("Satya Nadella is the CEO of Microsoft", freshness_sla="30d")
        assert gap["status"] in STATUSES
        assert "id" in gap
