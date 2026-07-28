"""Opt-in live test against a running REST server. Skipped unless KAVAL_BASE_URL is set."""

import os

import pytest

from kaval import KavalClient

BASE_URL = os.environ.get("KAVAL_BASE_URL")
DECISIONS = {"ALLOW", "REVIEW", "BLOCK"}


@pytest.mark.skipif(not BASE_URL, reason="KAVAL_BASE_URL not set")
def test_live_check_end_to_end():
    with KavalClient() as client:
        assert client.health()["ok"] is True
        result = client.check(
            action="Tell the customer Satya Nadella is the CEO of Microsoft",
            mode="fast",
        )
        assert result["decision"] in DECISIONS
        assert result["receipt"]["id"]
        # The receipt fetches back exactly as it was signed.
        receipt = client.get_receipt(result["receipt"]["id"])
        assert receipt["id"] == result["receipt"]["id"]
        assert receipt["decision"] == result["decision"]


@pytest.mark.skipif(not BASE_URL, reason="KAVAL_BASE_URL not set")
def test_live_sources_registry():
    with KavalClient() as client:
        assert isinstance(client.list_sources(), list)
