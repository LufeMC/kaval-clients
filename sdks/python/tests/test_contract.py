"""Hermetic contract tests: assert the client serializes requests + parses responses correctly,
using httpx.MockTransport (no network)."""

import json
import uuid

import httpx
import pytest

from kaval import KavalClient, KavalError
from kaval.client import DEFAULT_BASE_URL
from kaval.models import CalibrationSupportIdentity, ClaimAssessment

GAP = {
    "id": "id_1",
    "status": "stale",
    "confidence": 0.9,
    "reason": "team page changed",
    "evidence": [],
    "checked_at": "2026-06-24T18:04:11.000Z",
    "discrepancy": {"kind": "stale", "signals": []},
}


def test_proof_models_retain_required_calibration_support_identity():
    assert "calibration_support" in ClaimAssessment.__required_keys__
    assert CalibrationSupportIdentity.__required_keys__ == {
        "feature_schema_version",
        "feature_schema_hash",
        "support_fingerprint",
        "feature_vector",
    }


def make_client(handler):
    return KavalClient(base_url="http://test", transport=httpx.MockTransport(handler))


def test_check_sends_clean_body_and_parses_gap():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/check"
        assert request.headers["content-type"] == "application/json"
        captured["idempotency_key"] = request.headers["idempotency-key"]
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=GAP)

    with make_client(handler) as c:
        out = c.check("Jane Doe is at Acme", freshness_sla="14d")

    assert out["status"] == "stale"
    assert out["id"] == "id_1"
    assert str(uuid.UUID(captured["idempotency_key"])) == captured["idempotency_key"]
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


def test_audit_sends_exact_proof_body_and_returns_packet():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/audit"
        captured["body"] = json.loads(request.content)
        captured["key"] = request.headers["idempotency-key"]
        captured["timeout"] = request.extensions.get("timeout")
        return httpx.Response(
            200,
            json={"proof_id": "proof_1", "action_decision": {"decision": "REVIEW"}},
        )

    with make_client(handler) as c:
        proof = c.audit(
            "Acme is eligible for a refund",
            as_of="2026-07-10T20:00:00Z",
            intended_action="Issue the refund",
            materiality="critical",
            reversibility="irreversible",
            false_allow_cost_usd=12_000,
            record={"system": "billing", "table": "refunds", "id": "acme"},
            idempotency_key="audit-operation-0001",
            timeout=12.0,
        )

    assert captured["key"] == "audit-operation-0001"
    assert captured["body"] == {
        "text": "Acme is eligible for a refund",
        "as_of": "2026-07-10T20:00:00Z",
        "intended_action": "Issue the refund",
        "materiality": "critical",
        "reversibility": "irreversible",
        "false_allow_cost_usd": 12_000,
        "record": {"system": "billing", "table": "refunds", "id": "acme"},
    }
    assert captured["timeout"]["read"] == 12.0
    assert proof["proof_id"] == "proof_1"


def test_gate_action_sends_one_locator_and_returns_enforcement():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/gate"
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "proofId": "proof_1",
                "state": "current",
                "decision": {"decision": "ALLOW"},
                "billingClass": "action_gate",
                "proofReused": True,
                "researchPerformed": False,
                "latencyMs": 4,
                "enforcement": {
                    "mode": "bounded",
                    "controlApplied": True,
                    "executionAllowed": True,
                    "wouldAllow": True,
                    "reason": "inside boundary",
                },
            },
        )

    threshold = {
        "policy_id": "pricing-current",
        "policy_version": "1.0.0",
        "materiality": "low",
        "maximum_false_allow_risk": 0.01,
        "minimum_evidence_coverage": 0.95,
    }
    action = {
        "description": "Display the current price",
        "materiality": "low",
        "reversibility": "reversible",
    }
    with make_client(handler) as c:
        result = c.gate_action(
            proof_id="proof_1",
            material_claim_ids=["claim_1"],
            threshold=threshold,
            action=action,
        )

    assert captured["body"] == {
        "proof_id": "proof_1",
        "material_claim_ids": ["claim_1"],
        "threshold": threshold,
        "action": action,
    }
    assert result["enforcement"]["executionAllowed"] is True


def test_gate_action_rejects_missing_or_ambiguous_locator_before_network():
    with make_client(lambda request: pytest.fail(f"unexpected request: {request.url}")) as c:
        kwargs = {
            "material_claim_ids": ["claim_1"],
            "threshold": {
                "policy_id": "policy_1",
                "policy_version": "1",
                "materiality": "low",
                "maximum_false_allow_risk": 0.01,
                "minimum_evidence_coverage": 0.9,
            },
            "action": {
                "description": "Display it",
                "materiality": "low",
                "reversibility": "reversible",
            },
        }
        with pytest.raises(ValueError, match="exactly one"):
            c.gate_action(**kwargs)
        with pytest.raises(ValueError, match="exactly one"):
            c.gate_action(**kwargs, proof_id="proof_1", proof_key="proof-key:1")


def test_report_outcome():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/report-outcome"
        assert request.headers.get("idempotency-key") is None
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


def test_caller_idempotency_key_reaches_every_billable_method():
    captured = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append((request.url.path, request.headers.get("idempotency-key")))
        return httpx.Response(200, json={})

    operation_key = "logical-operation-0001"
    with make_client(handler) as c:
        c.check("x", idempotency_key=operation_key)
        c.verify("x", idempotency_key=operation_key)
        c.extract_and_check("x", idempotency_key=operation_key)
        c.scan_store(["x"], idempotency_key=operation_key)
        c.monitor(["x"], idempotency_key=operation_key)
        c.audit("x", as_of="2026-07-10T20:00:00Z", idempotency_key=operation_key)
        c.gate_action(
            proof_id="proof_1",
            material_claim_ids=["claim_1"],
            threshold={
                "policy_id": "policy_1",
                "policy_version": "1",
                "materiality": "low",
                "maximum_false_allow_risk": 0.01,
                "minimum_evidence_coverage": 0.9,
            },
            action={
                "description": "Display it",
                "materiality": "low",
                "reversibility": "reversible",
            },
            idempotency_key=operation_key,
        )
        c.kaval({"fact_type": "x"}, idempotency_key=operation_key)
        c.kaval_batch([{"fact_type": "x"}], idempotency_key=operation_key)

    assert [path for path, _ in captured] == [
        "/v1/check",
        "/v1/verify",
        "/v1/extract-and-check",
        "/v1/scan-store",
        "/v1/monitor",
        "/v1/audit",
        "/v1/gate",
        "/v1/kaval",
        "/v1/kaval-batch",
    ]
    assert all(key == operation_key for _, key in captured)


def test_transport_ambiguity_retries_once_with_same_generated_key():
    keys = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers["idempotency-key"])
        if len(keys) == 1:
            raise httpx.ConnectError("connection reset after request write", request=request)
        return httpx.Response(200, json=GAP)

    with make_client(handler) as c:
        out = c.check("x")

    assert out["id"] == "id_1"
    assert len(keys) == 2
    assert keys[1] == keys[0]


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (409, "idempotency_in_progress"),
        (503, "idempotency_resolution_pending"),
        (503, "event_persistence_pending"),
    ],
)
def test_ambiguous_idempotency_response_retries_once_with_same_caller_key(status, code):
    keys = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers["idempotency-key"])
        if len(keys) == 1:
            return httpx.Response(status, json={"error": {"code": code}})
        return httpx.Response(200, json=GAP)

    with make_client(handler) as c:
        out = c.check("x", idempotency_key="caller-operation-0001")

    assert out["id"] == "id_1"
    assert keys == ["caller-operation-0001", "caller-operation-0001"]


def test_ambiguous_idempotency_retries_are_bounded():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(409, json={"error": {"code": "idempotency_in_progress"}})

    with make_client(handler) as c:
        with pytest.raises(KavalError) as exc:
            c.check("x")

    assert exc.value.status_code == 409
    assert uuid.UUID(exc.value.idempotency_key)
    assert calls == ["/v1/check", "/v1/check"]


def test_malformed_success_response_raises_json_error():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, text="not-json")

    with make_client(handler) as c:
        with pytest.raises(ValueError) as exc:
            c.check("x")

    assert uuid.UUID(exc.value.idempotency_key)
    assert calls == ["/v1/check"]


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


def test_kaval_batch_serializes_body_and_returns_list():
    captured = {}
    resp = [GAP, {**GAP, "id": "id_2", "status": "current"}]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/kaval-batch"
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=resp)

    requests = [
        {"fact_type": "person.works_at", "subject": "Jane", "object": "Acme"},
        {"fact_type": "person.works_at", "subject": "John", "object": "Acme"},
    ]
    with make_client(handler) as c:
        out = c.kaval_batch(requests, concurrency=4)

    # Body carries both requests + concurrency; the response is a list, returned verbatim.
    assert captured["body"] == {"requests": requests, "concurrency": 4}
    assert isinstance(out, list)
    assert [r["id"] for r in out] == ["id_1", "id_2"]


def test_kaval_batch_omits_none_concurrency():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=[GAP])

    with make_client(handler) as c:
        c.kaval_batch([{"fact_type": "person.works_at", "subject": "Jane", "object": "Acme"}])

    # concurrency=None is dropped (clean body) — only `requests` rides the wire.
    assert "concurrency" not in captured["body"]
    assert list(captured["body"].keys()) == ["requests"]


def test_health_success_returns_dict():
    payload = {"status": "ok", "version": "1.2.3"}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/health"
        return httpx.Response(200, json=payload)

    with make_client(handler) as c:
        out = c.health()

    assert out == payload
    assert out["version"] == "1.2.3"


def test_post_propagates_connect_error():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        raise httpx.ConnectError("connection refused", request=request)

    # A transport-level ConnectError is retried once with the same operation key, then surfaces as
    # the original httpx.ConnectError (not wrapped in KavalError).
    with make_client(handler) as c:
        with pytest.raises(httpx.ConnectError) as exc:
            c.check("x")
    assert uuid.UUID(exc.value.idempotency_key)
    assert calls == ["/v1/check", "/v1/check"]


def test_health_propagates_timeout_exception():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("timed out", request=request)

    with make_client(handler) as c:
        with pytest.raises(httpx.TimeoutException):
            c.health()


def test_default_timeout_is_30_seconds():
    with KavalClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=GAP))) as c:
        assert c._http.timeout.read == 30.0


def test_timeout_is_overridable():
    with KavalClient(
        timeout=5.0,
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=GAP)),
    ) as c:
        assert c._http.timeout.read == 5.0


def test_no_automatic_retries_on_http_error():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(503, json={"error": {"code": "unavailable"}})

    with KavalClient(transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(KavalError) as exc:
            c.check("x")
        assert exc.value.status_code == 503

    assert calls == ["/v1/check"]


def test_env_defaults_api_key_and_base_url(monkeypatch):
    monkeypatch.setenv("KAVAL_API_KEY", "kv_live_from_env")
    monkeypatch.setenv("KAVAL_BASE_URL", "http://env.test")

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        captured["host"] = str(request.url)
        return httpx.Response(200, json=GAP)

    with KavalClient(transport=httpx.MockTransport(handler)) as c:
        c.check("Jane Doe is at Acme")

    assert captured["auth"] == "Bearer kv_live_from_env"
    assert captured["host"].startswith("http://env.test/v1/check")


def test_explicit_args_override_env(monkeypatch):
    monkeypatch.setenv("KAVAL_API_KEY", "kv_live_from_env")
    monkeypatch.setenv("KAVAL_BASE_URL", "http://env.test")

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        captured["host"] = str(request.url)
        return httpx.Response(200, json=GAP)

    with KavalClient(
        base_url="http://explicit.test",
        api_key="kv_live_explicit",
        transport=httpx.MockTransport(handler),
    ) as c:
        c.check("x")

    assert captured["auth"] == "Bearer kv_live_explicit"
    assert captured["host"].startswith("http://explicit.test/v1/check")
