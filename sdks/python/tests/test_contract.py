"""Hermetic contract tests: assert the client serializes requests + parses responses correctly,
using httpx.MockTransport (no network)."""

import json
import uuid
from pathlib import Path
from typing import get_args

import httpx
import pytest

import kaval
from kaval import (
    KavalCancellationToken,
    KavalCancelledError,
    KavalClient,
    KavalError,
    KavalProofNotFoundError,
    VerifyReceipt,
)
from kaval.client import DEFAULT_BASE_URL
from kaval.models import (
    CalibrationSupportIdentity,
    ClaimAssessment,
    ProofBillingClass,
    ProofGateState,
)

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures"

GAP = {
    "id": "id_1",
    "status": "stale",
    "confidence": 0.9,
    "reason": "team page changed",
    "evidence": [],
    "checked_at": "2026-06-24T18:04:11.000Z",
    "discrepancy": {"kind": "stale", "signals": []},
}

# The representative /v1/verify success envelope: {status, receipt{..., packet}} with an
# Ed25519-signed packet. Receipt-level expiry deliberately does not exist — it lives at
# receipt.packet.action_decision.expires_at.
VERIFY_RESULT = json.loads((FIXTURES / "py-verify-result-v1.json").read_text())

# The representative 200 /v1/gate result (state "not_found" is an HTTP 404, never a 200).
GATE_RESULT = json.loads((FIXTURES / "py-gate-result-v1.json").read_text())

THRESHOLD = {
    "policy_id": "pricing-current",
    "policy_version": "1.0.0",
    "materiality": "low",
    "maximum_false_allow_risk": 0.01,
    "minimum_evidence_coverage": 0.95,
}
ACTION = {
    "description": "Display the current price",
    "materiality": "low",
    "reversibility": "reversible",
}


def make_client(handler):
    return KavalClient(base_url="http://test", transport=httpx.MockTransport(handler))


def refusing_client():
    return make_client(
        lambda request: pytest.fail(f"unexpected request: {request.url}")
    )


# ---------------------------------------------------------------------------
# Model-shape guarantees
# ---------------------------------------------------------------------------


def test_proof_models_retain_required_calibration_support_identity():
    assert "calibration_support" in ClaimAssessment.__required_keys__
    assert CalibrationSupportIdentity.__required_keys__ == {
        "feature_schema_version",
        "feature_schema_hash",
        "support_fingerprint",
        "feature_vector",
    }


def test_verify_receipt_model_has_no_receipt_level_expiry():
    assert VerifyReceipt.__required_keys__ == {
        "proof_id",
        "decision",
        "reason",
        "share_endpoint",
        "packet",
    }
    assert "expires_at" not in VerifyReceipt.__annotations__


def test_gate_models_match_the_wire_contract():
    assert set(get_args(ProofGateState)) == {
        "current",
        "not_yet_valid",
        "expired",
        "invalidated",
        "dependency_changed",
        "integrity_failed",
        "policy_mismatch",
        "operational_failure",
    }
    assert set(get_args(ProofBillingClass)) == {"action_gate", "operational_failure"}


def test_commerce_surface_is_gone():
    for method in (
        "research_products",
        "stream_product_research",
        "search_offers",
        "stream_offer_search",
        "gate_offer_search",
    ):
        assert not hasattr(KavalClient, method)
    for export in ("ProductResearchInput", "OfferSearchInput", "LiveOfferSearchResult"):
        assert not hasattr(kaval, export)
        assert export not in kaval.__all__


# ---------------------------------------------------------------------------
# verify() — the primary conclusion + evidence_refs surface
# ---------------------------------------------------------------------------


def test_verify_posts_conclusion_and_evidence_refs_and_returns_receipt():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/verify"
        assert request.headers["content-type"] == "application/json"
        captured["idempotency_key"] = request.headers["idempotency-key"]
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=VERIFY_RESULT)

    with make_client(handler) as c:
        out = c.verify(
            conclusion="The 2024 International Building Code is the current IBC edition.",
            evidence_refs=["https://codes.iccsafe.org/content/IBC2024V2.0"],
        )

    assert captured["body"] == {
        "conclusion": "The 2024 International Building Code is the current IBC edition.",
        "evidence_refs": ["https://codes.iccsafe.org/content/IBC2024V2.0"],
    }
    # Billable op: a fresh UUID idempotency key rides the wire automatically.
    assert (
        str(uuid.UUID(captured["idempotency_key"])) == captured["idempotency_key"]
    )
    assert out["status"] == "valid"
    receipt = out["receipt"]
    assert receipt["decision"] == "ALLOW"
    assert receipt["share_endpoint"] == f"/v1/proofs/{receipt['proof_id']}/share"
    # No receipt-level expiry: it lives on the packet's action decision.
    assert "expires_at" not in receipt
    assert receipt["packet"]["action_decision"]["expires_at"]
    assert receipt["packet"]["signature"]["algorithm"] == "Ed25519"
    assert receipt["packet"]["signature"]["key_id"] == "proof-ed25519-2026-07"


def test_verify_accepts_the_canonical_request_mapping():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=VERIFY_RESULT)

    with make_client(handler) as c:
        out = c.verify(
            {
                "conclusion": "The 2024 International Building Code is the current IBC edition.",
                "evidence_refs": ["https://codes.iccsafe.org/content/IBC2024V2.0"],
                "materiality": "high",
            }
        )

    assert captured["body"] == {
        "conclusion": "The 2024 International Building Code is the current IBC edition.",
        "evidence_refs": ["https://codes.iccsafe.org/content/IBC2024V2.0"],
        "materiality": "high",
    }
    assert out == VERIFY_RESULT


def test_verify_serializes_optional_fields_and_document_bound_refs_exactly():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=VERIFY_RESULT)

    with make_client(handler) as c:
        c.verify(
            conclusion="Supplier X holds an active ISO 9001 certificate.",
            evidence_refs=[
                "https://registry.example/cert/123",
                {"url": "https://supplier.example/quality", "document_id": "doc-1"},
            ],
            as_of="2026-07-20T10:00:00+00:00",
            materiality="critical",
            intended_action="Approve the supplier onboarding",
            reversibility="irreversible",
            jurisdiction="US",
            context="procurement gate",
        )

    assert captured["body"] == {
        "conclusion": "Supplier X holds an active ISO 9001 certificate.",
        "evidence_refs": [
            "https://registry.example/cert/123",
            {"url": "https://supplier.example/quality", "document_id": "doc-1"},
        ],
        "as_of": "2026-07-20T10:00:00+00:00",
        "materiality": "critical",
        "intended_action": "Approve the supplier onboarding",
        "reversibility": "irreversible",
        "jurisdiction": "US",
        "context": "procurement gate",
    }


def test_verify_rejects_mixing_mapping_and_keyword_fields_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="not both"):
            c.verify(
                {"conclusion": "x", "evidence_refs": ["https://a.example/"]},
                materiality="high",
            )


def test_verify_rejects_unknown_request_fields_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="unknown verify request fields: belief"):
            c.verify({"belief": "x", "evidence_refs": ["https://a.example/"]})


def test_verify_requires_a_conclusion_before_network():
    with refusing_client() as c:
        with pytest.raises(ValueError, match="conclusion"):
            c.verify(evidence_refs=["https://a.example/"])


@pytest.mark.parametrize(
    ("evidence_refs", "message"),
    [
        (None, "1 to 20"),
        ([], "between 1 and 20"),
        ([f"https://a.example/{i}" for i in range(21)], "between 1 and 20"),
        # A bare object WITHOUT document_id is invalid — must be a plain string instead.
        ([{"url": "https://a.example/"}], "pass a plain URL string"),
        ([{"url": "https://a.example/", "document_id": ""}], "exactly"),
        (
            [{"url": "https://a.example/", "document_id": "d", "extra": 1}],
            "exactly",
        ),
        ([7], "URL string"),
        (
            [
                {"url": "https://a.example/", "document_id": "same"},
                {"url": "https://b.example/", "document_id": "same"},
            ],
            "unique",
        ),
    ],
)
def test_verify_rejects_invalid_evidence_refs_before_network(evidence_refs, message):
    with refusing_client() as c:
        with pytest.raises(ValueError, match=message):
            c.verify(conclusion="an assertable proposition", evidence_refs=evidence_refs)


@pytest.mark.parametrize(
    "payload",
    [
        GAP,  # a legacy belief-freshness body is not a conclusion envelope
        {"status": "current", "receipt": VERIFY_RESULT["receipt"]},
        {"status": "valid"},
        {"status": "valid", "receipt": {}},
        {
            "status": "valid",
            "receipt": {**VERIFY_RESULT["receipt"], "decision": "SAFE"},
        },
        {
            "status": "valid",
            "receipt": {
                key: value
                for key, value in VERIFY_RESULT["receipt"].items()
                if key != "packet"
            },
        },
    ],
)
def test_verify_rejects_a_malformed_verdict_envelope(payload):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as c:
        with pytest.raises(TypeError, match="conclusion-verification envelope"):
            c.verify(conclusion="x is y", evidence_refs=["https://a.example/"])


def test_verify_pre_cancel_skips_transport_and_retains_operation_key():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=VERIFY_RESULT)

    token = KavalCancellationToken()
    token.cancel("cancelled before verify")
    with make_client(handler) as client:
        with pytest.raises(KavalCancelledError) as raised:
            client.verify(
                conclusion="x is y",
                evidence_refs=["https://a.example/"],
                idempotency_key="verify-pre-cancel-0001",
                cancellation_token=token,
            )

    assert calls == 0
    assert raised.value.idempotency_key == "verify-pre-cancel-0001"


# ---------------------------------------------------------------------------
# Legacy belief-freshness compatibility (the server still accepts this body)
# ---------------------------------------------------------------------------


def test_legacy_verify_belief_returns_decision_with_act():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/verify"
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={**GAP, "act": False})

    with make_client(handler) as c:
        out = c.legacy_verify_belief("Acme's CEO is Jane Doe", min_confidence=0.8)

    assert out["act"] is False
    assert out["status"] == "stale"
    # min_confidence maps to the wire's camelCase minConfidence; None optionals are dropped.
    assert captured["body"] == {"belief": "Acme's CEO is Jane Doe", "minConfidence": 0.8}


def test_legacy_verify_belief_sends_mode_and_parses_tier():
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
        out = c.legacy_verify_belief("Acme's CEO is Jane Doe", mode="deep")

    # `mode` rides the wire verbatim (no camelCase remap, unlike min_confidence).
    assert captured["body"] == {"belief": "Acme's CEO is Jane Doe", "mode": "deep"}
    assert out["tier"] == "deep"
    assert out["explanation"]["confidence"] == "high"
    assert out["explanation"]["citations"][0]["url"] == "http://acme.test/team"


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


# ---------------------------------------------------------------------------
# audit() — build the proof (the expensive path)
# ---------------------------------------------------------------------------


def test_audit_sends_exact_proof_body_and_returns_packet():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/audit"
        captured["body"] = json.loads(request.content)
        captured["key"] = request.headers["idempotency-key"]
        captured["timeout"] = request.extensions.get("timeout")
        return httpx.Response(200, json=VERIFY_RESULT["receipt"]["packet"])

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
    # The response is the raw ProofPacket, passed through unmodified.
    assert proof == VERIFY_RESULT["receipt"]["packet"]
    assert proof["action_decision"]["decision"] == "ALLOW"
    assert proof["expiry"]["recheck_at"]
    assert proof["signature"]["algorithm"] == "Ed25519"


def test_audit_pre_cancel_skips_transport():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=VERIFY_RESULT["receipt"]["packet"])

    token = KavalCancellationToken()
    token.cancel("cancelled before audit")
    with make_client(handler) as client:
        with pytest.raises(KavalCancelledError) as raised:
            client.audit(
                "Acme is eligible for a refund",
                as_of="2026-07-10T20:00:00Z",
                idempotency_key="audit-pre-cancel-0001",
                cancellation_token=token,
            )

    assert calls == 0
    assert raised.value.idempotency_key == "audit-pre-cancel-0001"


# ---------------------------------------------------------------------------
# gate() / gate_action() — apply the proof at act time
# ---------------------------------------------------------------------------


def test_gate_action_sends_one_locator_and_returns_the_wire_result():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/gate"
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=GATE_RESULT)

    with make_client(handler) as c:
        result = c.gate_action(
            proof_id="proof_1",
            material_claim_ids=["claim_1"],
            threshold=THRESHOLD,
            action=ACTION,
        )

    assert captured["body"] == {
        "proof_id": "proof_1",
        "material_claim_ids": ["claim_1"],
        "threshold": THRESHOLD,
        "action": ACTION,
    }
    assert result == GATE_RESULT
    assert result["state"] == "current"
    assert result["billingClass"] == "action_gate"
    assert result["researchPerformed"] is False
    assert result["decision"]["decision"] == "ALLOW"


def test_gate_alias_sends_proof_key_locator():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=GATE_RESULT)

    with make_client(handler) as c:
        result = c.gate(
            proof_key="pricing:acme:refund",
            material_claim_ids=["claim_1"],
            threshold=THRESHOLD,
            action=ACTION,
            expected_dependency_versions={"src_iccsafe_codes": "sv_iccsafe_ibc2024"},
        )

    assert captured["body"]["proof_key"] == "pricing:acme:refund"
    assert "proof_id" not in captured["body"]
    assert captured["body"]["expected_dependency_versions"] == {
        "src_iccsafe_codes": "sv_iccsafe_ibc2024"
    }
    assert result["proofId"] == GATE_RESULT["proofId"]


def test_gate_action_rejects_missing_or_ambiguous_locator_before_network():
    with refusing_client() as c:
        kwargs = {
            "material_claim_ids": ["claim_1"],
            "threshold": THRESHOLD,
            "action": ACTION,
        }
        with pytest.raises(ValueError, match="exactly one"):
            c.gate_action(**kwargs)
        with pytest.raises(ValueError, match="exactly one"):
            c.gate_action(**kwargs, proof_id="proof_1", proof_key="proof-key:1")


def test_gate_surfaces_proof_not_found_as_a_typed_error():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/gate"
        return httpx.Response(
            404,
            json={
                "error": {
                    "code": "proof_not_found",
                    "message": "no matching proof packet",
                }
            },
        )

    with make_client(handler) as c:
        with pytest.raises(KavalProofNotFoundError) as exc:
            c.gate(
                proof_id="proof_missing",
                material_claim_ids=["claim_1"],
                threshold=THRESHOLD,
                action=ACTION,
                idempotency_key="gate-not-found-0001",
            )

    assert isinstance(exc.value, KavalError)
    assert exc.value.status_code == 404
    assert exc.value.code == "proof_not_found"
    assert exc.value.payload["error"]["code"] == "proof_not_found"
    assert exc.value.idempotency_key == "gate-not-found-0001"


def test_gate_other_errors_stay_plain_kaval_errors():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    with make_client(handler) as c:
        with pytest.raises(KavalError) as exc:
            c.gate(
                proof_id="proof_1",
                material_claim_ids=["claim_1"],
                threshold=THRESHOLD,
                action=ACTION,
            )

    assert not isinstance(exc.value, KavalProofNotFoundError)
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# Shared transport behavior
# ---------------------------------------------------------------------------


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
        if request.url.path == "/v1/verify" and "conclusion" in json.loads(
            request.content
        ):
            return httpx.Response(200, json=VERIFY_RESULT)
        return httpx.Response(200, json={})

    operation_key = "logical-operation-0001"
    with make_client(handler) as c:
        c.check("x", idempotency_key=operation_key)
        c.verify(
            conclusion="x is y",
            evidence_refs=["https://a.example/"],
            idempotency_key=operation_key,
        )
        c.legacy_verify_belief("x", idempotency_key=operation_key)
        c.extract_and_check("x", idempotency_key=operation_key)
        c.scan_store(["x"], idempotency_key=operation_key)
        c.monitor(["x"], idempotency_key=operation_key)
        c.audit("x", as_of="2026-07-10T20:00:00Z", idempotency_key=operation_key)
        c.gate_action(
            proof_id="proof_1",
            material_claim_ids=["claim_1"],
            threshold=THRESHOLD,
            action=ACTION,
            idempotency_key=operation_key,
        )
        c.kaval({"fact_type": "x"}, idempotency_key=operation_key)
        c.kaval_batch([{"fact_type": "x"}], idempotency_key=operation_key)

    assert [path for path, _ in captured] == [
        "/v1/check",
        "/v1/verify",
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
