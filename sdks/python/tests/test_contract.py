"""Hermetic contract tests: assert the client serializes requests + parses responses correctly,
using httpx.MockTransport (no network)."""

import json

import httpx
import pytest

from kaval import KavalClient, KavalError
from kaval.client import DEFAULT_BASE_URL

GAP = {
    "id": "id_1",
    "status": "stale",
    "confidence": 0.9,
    "reason": "team page changed",
    "evidence": [],
    "checked_at": "2026-06-24T18:04:11.000Z",
    "discrepancy": {"kind": "stale", "signals": []},
}


def make_client(handler):
    return KavalClient(base_url="http://test", transport=httpx.MockTransport(handler))


def test_check_sends_clean_body_and_parses_gap():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/check"
        assert request.headers["content-type"] == "application/json"
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=GAP)

    with make_client(handler) as c:
        out = c.check("Jane Doe is at Acme", freshness_sla="14d")

    assert out["status"] == "stale"
    assert out["id"] == "id_1"
    # None-valued optionals are omitted (clean body).
    assert captured["body"] == {"belief": "Jane Doe is at Acme", "freshness_sla": "14d"}


def test_verify_returns_decision_with_act():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/verify"
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={**GAP, "act": False})

    with make_client(handler) as c:
        out = c.verify("Acme's CEO is Jane Doe", min_confidence=0.8)

    assert out["act"] is False
    assert out["status"] == "stale"
    # min_confidence maps to the wire's camelCase minConfidence; None optionals are dropped.
    assert captured["body"] == {"belief": "Acme's CEO is Jane Doe", "minConfidence": 0.8}


def test_verify_sends_mode_and_parses_tier():
    captured = {}
    resp = {
        "id": "id_1",
        "status": "current",
        "confidence": 0.95,
        "reason": "confirmed by the team page",
        "evidence": [],
        "checked_at": "2026-06-25T00:00:00.000Z",
        "act": True,
        "tier": "deep",
        "explanation": {
            "content": "Confirmed by the team page [1].",
            "citations": [{"url": "http://acme.test/team"}],
            "confidence": "high",
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/verify"
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=resp)

    with make_client(handler) as c:
        out = c.verify("Acme's CEO is Jane Doe", mode="deep")

    # `mode` rides the wire verbatim (no camelCase remap, unlike min_confidence).
    assert captured["body"] == {"belief": "Acme's CEO is Jane Doe", "mode": "deep"}
    assert out["tier"] == "deep"
    assert out["explanation"]["confidence"] == "high"
    assert out["explanation"]["citations"][0]["url"] == "http://acme.test/team"


def test_extract_and_check():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/extract-and-check"
        return httpx.Response(200, json={"beliefs": [GAP, GAP]})

    with make_client(handler) as c:
        out = c.extract_and_check("a paragraph")
    assert len(out["beliefs"]) == 2


def test_scan_store():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/scan-store"
        assert json.loads(request.content)["beliefs"] == ["a", "b"]
        return httpx.Response(
            200,
            json={"total": 2, "summary": {"current": 1, "stale": 1}, "riskiest": [], "tier": "fast"},
        )

    with make_client(handler) as c:
        out = c.scan_store(["a", "b"], freshness_sla="30d")
    assert out["total"] == 2
    assert out["summary"]["stale"] == 1


def test_scan_store_sends_mode_and_parses_tier():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"total": 1, "summary": {"current": 1}, "riskiest": [], "tier": "deep"})

    with make_client(handler) as c:
        out = c.scan_store(["a"], mode="deep")

    assert captured["body"] == {"beliefs": ["a"], "mode": "deep"}
    assert out["tier"] == "deep"


def test_monitor_sends_body_and_parses_result():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/monitor"
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "total": 2,
                "summary": {"current": 1, "stale": 1},
                "riskiest": [],
                "tier": "fast",
                "checked_at": "2026-06-25T00:00:00.000Z",
                "delivered": 1,
                "state": {"riskyKeys": ["k1"]},
            },
        )

    with make_client(handler) as c:
        out = c.monitor(["a", "b"], webhook="http://hook.test", mode="deep")

    assert captured["body"]["mode"] == "deep"
    assert captured["body"]["webhook"] == "http://hook.test"
    assert out["tier"] == "fast"
    assert out["state"]["riskyKeys"] == ["k1"]


def test_report_outcome():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/report-outcome"
        assert json.loads(request.content)["kind"] == "relied_and_correct"
        return httpx.Response(200, json={"ok": True})

    with make_client(handler) as c:
        assert c.report_outcome("id_1", "relied_and_correct")["ok"] is True


def test_kaval_structured():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/kaval"
        return httpx.Response(200, json=GAP)

    with make_client(handler) as c:
        out = c.kaval({"fact_type": "person.works_at", "subject": "Jane", "object": "Acme"})
    assert out["status"] == "stale"


def test_auth_header_is_set():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer secret"
        return httpx.Response(200, json=GAP)

    client = KavalClient(
        base_url="http://test", api_key="secret", transport=httpx.MockTransport(handler)
    )
    client.check("x")
    client.close()


def test_error_response_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"code": "bad_request"}})

    with make_client(handler) as c:
        with pytest.raises(KavalError) as exc:
            c.check("x")
    assert exc.value.status_code == 400


def test_default_base_url_is_the_cloud():
    assert DEFAULT_BASE_URL == "https://api.usekaval.com"

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, json=GAP)

    # No base_url given → defaults to the hosted cloud.
    client = KavalClient(transport=httpx.MockTransport(handler))
    client.check("x")
    client.close()
    assert captured["url"] == "https://api.usekaval.com/v1/check"


def test_health_raises_on_non_2xx():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": {"code": "unavailable"}})

    with make_client(handler) as c:
        with pytest.raises(KavalError) as exc:
            c.health()
    assert exc.value.status_code == 503
