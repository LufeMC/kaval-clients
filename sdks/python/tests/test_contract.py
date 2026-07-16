"""Hermetic contract tests: assert the client serializes requests + parses responses correctly,
using httpx.MockTransport (no network)."""

import json
import uuid
from pathlib import Path

import httpx
import pytest

from kaval import KavalClient, KavalError
from kaval.client import DEFAULT_BASE_URL
from kaval.models import (
    CalibrationSupportIdentity,
    ClaimAssessment,
    CommerceAcquisitionSourceLedgerEntry,
    CommerceCheckoutObservation,
    CommerceCheckoutVerification,
    LiveOfferSearchAcquisitionTrace,
    LiveOfferSearchCandidate,
    LiveOfferSearchResult,
    OfferOriginEvidence,
    ProductCatalogIdentityResolution,
)

GAP = {
    "id": "id_1",
    "status": "stale",
    "confidence": 0.9,
    "reason": "team page changed",
    "evidence": [],
    "checked_at": "2026-06-24T18:04:11.000Z",
    "discrepancy": {"kind": "stale", "signals": []},
}

OFFER_REQUEST = {
    "schema_revision": 1,
    "request_id": "offer-request-1",
    "raw_description": "Makita XPH14Z 18V hammer drill, tool only",
    "target": {
        "schema_revision": 1,
        "family": {"brand": "Makita", "name": "18V LXT hammer drill"},
        "name": "Makita XPH14Z",
        "identifiers": [{"scheme": "model", "value": "XPH14Z"}],
        "attributes": [{"key": "kit", "value": False}],
    },
    "requested_condition": "new",
    "destination": {"country_code": "US", "region": "CA", "postal_code": "94107"},
    "match_policy": {
        "identity_requirement": "shared_identifier",
        "required_identifier_schemes": ["model"],
        "required_attribute_keys": ["kit"],
        "permitted_substitutions": [],
    },
    "seller_policy": {
        "allowed_seller_ids": [],
        "blocked_seller_ids": [],
        "allowed_kinds": ["brand_direct", "authorized_retailer"],
        "require_authorized": True,
    },
    "destination_policy": {
        "require_eligible": True,
        "require_exact_region": True,
        "require_exact_postal_code": True,
    },
    "price_policy": {
        "currency": "USD",
        "require_complete_landed_total": True,
        "allow_estimated_components": False,
        "allow_member_price": False,
        "allow_subscription_price": False,
        "allow_coupon_price": False,
        "allow_installment_display": False,
        "allow_trade_in_price": False,
    },
    "source_policy": {
        "allowed_source_ids": [],
        "blocked_source_ids": [],
        "require_origin_evidence": True,
    },
    "intended_action": {
        "description": "Quote this exact item to a customer",
        "materiality": "high",
        "reversibility": "partially_reversible",
    },
    "freshness_maximum_age_ms": 300_000,
    "max_results": 5,
    "minimum_unique_sellers": 2,
    "deadline_ms": 15_000,
    "maximum_cost_micro_usd": 50_000,
    "maximum_search_calls": 4,
    "maximum_fetches": 12,
}

OFFER_RESULT = {
    "schema_revision": 2,
    "request_id": "offer-request-1",
    "request_digest": f"sha256:{'a' * 64}",
    "status": "complete",
    "action": {"state": "NEEDS_REVIEW", "reason_codes": ["SHADOW_MODE"]},
    "stop_reason": "source_exhausted",
    "query": "Makita XPH14Z",
    "candidates": [],
    "source_attempts": [],
    "receipt": {
        "search_calls": 2,
        "fetch_calls": 3,
        "providers_configured": 2,
        "providers_succeeded": 2,
        "cost_micro_usd": 2_500,
        "cost_basis": "reserved_ceiling",
        "provider_estimated_cost_micro_usd": None,
        "provider_estimated_cost_reported_search_calls": 0,
        "discovery_cache_hits": 0,
        "cost_avoided_micro_usd": 0,
        "elapsed_ms": 120,
    },
    "started_at": "2026-07-15T00:00:00.000Z",
    "completed_at": "2026-07-15T00:00:00.120Z",
}

ACTION_BINDING = {
    "action_slot_key": "quote:line-item-1",
    "action_input_digest": f"sha256:{'b' * 64}",
    "action_consequence_digest": f"sha256:{'c' * 64}",
}

OFFER_GATE_REQUEST = {
    "dependency_id": "offer:dependency-1",
    "generation_id": "offer:generation-1",
    "generation_number": 1,
    "generation_digest": f"sha256:{'d' * 64}",
    "action_binding": ACTION_BINDING,
}

OFFER_GATE_RESULT = {
    "state": "current_review_only",
    "disposition": "REVIEW",
    "permission": "withheld",
    "reason_codes": ["COMMERCE_PERMISSION_REVIEW_ONLY"],
    "checked_at": "2026-07-15T00:00:00.130Z",
    "final_fence_checked": True,
    "generation_id": OFFER_GATE_REQUEST["generation_id"],
    "generation_number": OFFER_GATE_REQUEST["generation_number"],
    "generation_digest": OFFER_GATE_REQUEST["generation_digest"],
    "expires_at": "2026-07-15T00:05:00.000Z",
}

CHECKOUT = {
    "status": "verified",
    "resolver": {
        "schema_revision": 1,
        "source_id": "retailer-checkout",
        "adapter_revision": "checkout/2026-07-15.1",
        "execution_mode": "live",
        "estimated_cost_micro_usd": 700,
    },
    "request_digest": f"sha256:{'e' * 64}",
    "observation": {
        "destination_eligibility": "eligible",
        "availability": "in_stock",
        "seller_authorized": True,
        "item_price": {"amount_minor": 18_999, "currency": "USD"},
        "shipping_price": {"amount_minor": 0, "currency": "USD"},
        "tax_price": {"amount_minor": 1_567, "currency": "USD"},
        "mandatory_fees": {"amount_minor": 0, "currency": "USD"},
        "declared_landed_total": {"amount_minor": 20_566, "currency": "USD"},
        "quote_id": "checkout-quote-1",
        "evidence_digest": f"sha256:{'f' * 64}",
        "observed_at": "2026-07-15T00:00:00.050Z",
        "expires_at": "2026-07-15T00:05:00.050Z",
    },
    "landed_price_validation": {
        "state": "complete",
        "expected_currency": "USD",
        "calculated_landed_total": {"amount_minor": 20_566, "currency": "USD"},
        "reason_codes": [],
    },
    "action": {
        "state": "REVIEW",
        "action_authorized": False,
        "reason_codes": ["COMMERCE_PERMISSION_REVIEW_ONLY"],
    },
    "actual_cost_micro_usd": 650,
    "version_receipt": "checkout/2026-07-15.1",
    "operational_error_code": None,
}

SOURCE_LEDGER = [
    {
        "source_id": "catalog-primary",
        "family": "catalog",
        "disposition": "succeeded",
        "reason_code": "COMPLETED",
    },
    {
        "source_id": "open-web-tail",
        "family": "open_web",
        "disposition": "unsearched",
        "reason_code": "COVERAGE_SATISFIED",
    },
]

REPRESENTATIVE_WIRE_RESULT = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "fixtures"
        / "offer-search-result-v2.json"
    ).read_text()
)


def test_proof_models_retain_required_calibration_support_identity():
    assert "calibration_support" in ClaimAssessment.__required_keys__
    assert CalibrationSupportIdentity.__required_keys__ == {
        "feature_schema_version",
        "feature_schema_hash",
        "support_fingerprint",
        "feature_vector",
    }


def test_offer_search_models_expose_checkout_and_acquisition_ledger_fields():
    assert "checkout" in LiveOfferSearchCandidate.__annotations__
    assert CommerceCheckoutVerification.__required_keys__ >= {
        "status",
        "observation",
        "landed_price_validation",
        "action",
    }
    assert CommerceAcquisitionSourceLedgerEntry.__required_keys__ == {
        "source_id",
        "family",
        "disposition",
        "reason_code",
    }
    assert LiveOfferSearchAcquisitionTrace.__required_keys__ >= {
        "coverage_claim",
        "plan",
        "plan_digest",
        "source_ledger",
    }
    assert "delivery_promise" in CommerceCheckoutObservation.__annotations__
    assert OfferOriginEvidence.__annotations__.keys() >= {
        "artifact",
        "version_receipt",
    }
    assert LiveOfferSearchResult.__annotations__.keys() >= {
        "effective_request_digest",
        "rejected_explanations",
        "identity_resolution",
    }
    assert ProductCatalogIdentityResolution.__required_keys__ >= {
        "resolver_version",
        "resolution_state",
        "resolved_target",
        "resolved_variant",
        "record_assessments",
        "resolution_digest",
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


def test_search_offers_posts_exact_request_and_returns_review_only_result():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/search-offers"
        captured["body"] = json.loads(request.content)
        captured["key"] = request.headers["idempotency-key"]
        captured["timeout"] = request.extensions.get("timeout")
        return httpx.Response(200, json=OFFER_RESULT)

    with make_client(handler) as c:
        result = c.search_offers(
            OFFER_REQUEST,
            idempotency_key="offer-search-operation-0001",
            timeout=12.0,
        )

    assert captured["body"] == OFFER_REQUEST
    assert captured["key"] == "offer-search-operation-0001"
    assert captured["timeout"]["read"] == 12.0
    assert result["action"]["state"] == "NEEDS_REVIEW"


def test_search_offers_preserves_representative_strict_wire_fixture():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=REPRESENTATIVE_WIRE_RESULT)

    with make_client(handler) as c:
        result = c.search_offers(OFFER_REQUEST)

    candidate = result["candidates"][0]
    assert result["effective_request_digest"] == f"sha256:{'b' * 64}"
    assert result["rejected_explanations"][0]["contender"] is False
    assert result["identity_resolution"]["resolution_state"] == "exact_variant"
    assert candidate["origin_evidence"]["artifact"] == "rendered_page"
    assert (
        candidate["origin_evidence"]["version_receipt"]
        == "browser-renderer/2026-07-16.1"
    )
    assert candidate["origin_offer"]["field_provenance"][0]["field_path"] == (
        "variant.identifiers"
    )
    assert candidate["checkout"]["observation"]["delivery_promise"] == {
        "certainty": "estimated",
        "earliest_at": "2026-07-18T00:00:00.000Z",
        "latest_at": "2026-07-20T00:00:00.000Z",
    }
    assert result["lifecycle"]["action_time_gate"]["permission"] == "withheld"
    assert "SAFE_TO_QUOTE" not in json.dumps(result)


def test_search_offers_preserves_typed_checkout_and_acquisition_source_ledger():
    response = {
        **OFFER_RESULT,
        "candidates": [
            {
                "candidate_id": f"sha256:{'1' * 64}",
                "origin_url": "https://retailer.test/makita-xph14z",
                "source_id": "catalog-primary",
                "discovered_by": ["catalog-primary"],
                "discovery_metadata": [
                    {"provider": "catalog-primary", "title": "Makita XPH14Z"}
                ],
                "origin_evidence": {
                    "kind": "json_ld",
                    "content_digest": f"sha256:{'2' * 64}",
                    "source_block_index": 0,
                    "jsonld_product_index": 0,
                    "jsonld_offer_index": 0,
                },
                "origin_offer": {},
                "identity": {},
                "disposition": "review",
                "gaps": [],
                "reason_codes": ["SHADOW_MODE"],
                "checkout": CHECKOUT,
            }
        ],
        "acquisition": {
            "coverage_claim": "bounded_not_comprehensive",
            "plan": {},
            "plan_digest": f"sha256:{'3' * 64}",
            "source_ledger": SOURCE_LEDGER,
        },
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response)

    with make_client(handler) as c:
        result = c.search_offers(OFFER_REQUEST)

    assert result["candidates"][0]["checkout"]["status"] == "verified"
    assert (
        result["candidates"][0]["checkout"]["observation"]["declared_landed_total"][
            "amount_minor"
        ]
        == 20_566
    )
    assert result["acquisition"]["coverage_claim"] == "bounded_not_comprehensive"
    assert result["acquisition"]["source_ledger"] == SOURCE_LEDGER


def offer_search_sse(
    *events: tuple[str, int, object],
) -> bytes:
    return "".join(
        f"event: {name}\nid: {sequence}\ndata: {json.dumps(payload)}\n\n"
        for name, sequence, payload in events
    ).encode()


def collect_offer_search_stream(stream):
    events = []
    while True:
        try:
            events.append(next(stream))
        except StopIteration as completed:
            return events, completed.value


def test_stream_offer_search_retries_only_before_stream_with_same_operation_key():
    attempts = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request.headers["idempotency-key"])
        assert request.headers["accept"] == "text/event-stream"
        assert json.loads(request.content) == OFFER_REQUEST
        if len(attempts) == 1:
            raise httpx.ConnectError("connection failed before headers", request=request)
        accepted = {
            "type": "accepted",
            "sequence": 0,
            "at": "2026-07-15T00:00:00.000Z",
            "request_id": OFFER_REQUEST["request_id"],
            "message": "Offer Search was admitted; every result remains review-only.",
            "authority": "research_only",
            "action_state": "REVIEW",
            "details": {"newly_admitted": True},
        }
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream; charset=utf-8"},
            content=offer_search_sse(
                ("accepted", 0, accepted),
                ("final", 1, OFFER_RESULT),
            ),
        )

    with make_client(handler) as c:
        events, final = collect_offer_search_stream(
            c.stream_offer_search(
                OFFER_REQUEST,
                idempotency_key="offer-stream-operation-0001",
                timeout=12.0,
            )
        )

    assert attempts == [
        "offer-stream-operation-0001",
        "offer-stream-operation-0001",
    ]
    assert [event["type"] for event in events] == ["accepted", "final"]
    assert events[-1]["result"] == OFFER_RESULT
    assert final == OFFER_RESULT


def test_stream_offer_search_accepts_explicit_same_key_replay_without_new_work():
    replay = {
        "type": "replay",
        "sequence": 0,
        "replayed_at": "2026-07-15T00:00:01.000Z",
        "request_id": OFFER_REQUEST["request_id"],
        "request_digest": OFFER_RESULT["request_digest"],
        "authority": "research_only",
        "action_state": "REVIEW",
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=offer_search_sse(
                ("replay", 0, replay),
                ("final", 1, OFFER_RESULT),
            ),
        )

    with make_client(handler) as c:
        events, final = collect_offer_search_stream(
            c.stream_offer_search(OFFER_REQUEST)
        )

    assert events[0] == replay
    assert final == OFFER_RESULT


def test_stream_offer_search_exposes_explicit_non_actionable_provisional_candidate():
    provisional = {
        "type": "candidate_provisional",
        "sequence": 0,
        "at": "2026-07-15T00:00:00.000Z",
        "request_id": OFFER_REQUEST["request_id"],
        "message": (
            "An origin-verified research candidate is available provisionally; "
            "final publication is pending."
        ),
        "authority": "research_only",
        "action_state": "REVIEW",
        "details": {
            "request_digest": OFFER_RESULT["request_digest"],
            "origin_sequence": 2,
            "publication_state": "provisional",
            "durable": False,
            "actionable": False,
            "permission": "withheld",
            "final_inclusion": "not_yet_determined",
            "candidate": {
                "candidate_id": f"sha256:{'1' * 64}",
                "origin_url": "https://retailer.example/makita-xph14z",
                "source_id": "origin:retailer.example",
                "disposition": "review",
            },
        },
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=offer_search_sse(
                ("candidate_provisional", 0, provisional),
                ("final", 1, OFFER_RESULT),
            ),
        )

    with make_client(handler) as c:
        events, final = collect_offer_search_stream(
            c.stream_offer_search(OFFER_REQUEST)
        )

    assert events[0] == provisional
    assert events[0]["details"] == {
        **provisional["details"],
        "durable": False,
        "actionable": False,
        "permission": "withheld",
        "final_inclusion": "not_yet_determined",
    }
    assert final == OFFER_RESULT


def test_stream_offer_search_rejects_provisional_digest_drift_from_final():
    provisional = {
        "type": "candidate_provisional",
        "sequence": 0,
        "at": "2026-07-15T00:00:00.000Z",
        "request_id": OFFER_REQUEST["request_id"],
        "message": "Provisional research candidate.",
        "authority": "research_only",
        "action_state": "REVIEW",
        "details": {
            "request_digest": f"sha256:{'9' * 64}",
            "origin_sequence": 2,
            "publication_state": "provisional",
            "durable": False,
            "actionable": False,
            "permission": "withheld",
            "final_inclusion": "not_yet_determined",
            "candidate": {
                "candidate_id": f"sha256:{'1' * 64}",
                "origin_url": "https://retailer.example/makita-xph14z",
                "source_id": "origin:retailer.example",
                "disposition": "review",
            },
        },
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=offer_search_sse(
                ("candidate_provisional", 0, provisional),
                ("final", 1, OFFER_RESULT),
            ),
        )

    with make_client(handler) as c:
        with pytest.raises(TypeError, match="bound to another final result"):
            list(c.stream_offer_search(OFFER_REQUEST))


@pytest.mark.parametrize(
    "replay",
    [
        {
            "type": "replay",
            "sequence": 0,
            "replayed_at": "2026-07-15T00:00:01.000Z",
            "request_id": OFFER_REQUEST["request_id"],
            "authority": "research_only",
            "action_state": "REVIEW",
        },
        {
            "type": "replay",
            "sequence": 0,
            "replayed_at": "2026-07-15T00:00:01.000Z",
            "request_id": OFFER_REQUEST["request_id"],
            "request_digest": "sha256:not-a-digest",
            "authority": "research_only",
            "action_state": "REVIEW",
        },
        {
            "type": "replay",
            "sequence": 0,
            "replayed_at": "2026-07-15T00:00:01.000Z",
            "request_id": "different-request",
            "request_digest": OFFER_RESULT["request_digest"],
            "authority": "research_only",
            "action_state": "REVIEW",
        },
    ],
)
def test_stream_offer_search_rejects_missing_malformed_or_foreign_replay_binding(
    replay,
):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=offer_search_sse(("replay", 0, replay)),
        )

    with make_client(handler) as c:
        with pytest.raises(TypeError, match="replay event"):
            list(c.stream_offer_search(OFFER_REQUEST))


def test_stream_offer_search_rejects_replay_digest_drift_from_final():
    replay = {
        "type": "replay",
        "sequence": 0,
        "replayed_at": "2026-07-15T00:00:01.000Z",
        "request_id": OFFER_REQUEST["request_id"],
        "request_digest": f"sha256:{'9' * 64}",
        "authority": "research_only",
        "action_state": "REVIEW",
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=offer_search_sse(
                ("replay", 0, replay),
                ("final", 1, OFFER_RESULT),
            ),
        )

    with make_client(handler) as c:
        with pytest.raises(TypeError, match="stream events are bound"):
            list(c.stream_offer_search(OFFER_REQUEST))


@pytest.mark.parametrize(
    "events, message",
    [
        (
            [
                (
                    "accepted",
                    0,
                    {
                        "type": "accepted",
                        "sequence": 0,
                        "at": "2026-07-15T00:00:00.000Z",
                        "request_id": OFFER_REQUEST["request_id"],
                        "message": "admitted",
                        "authority": "research_only",
                        "action_state": "ALLOW",
                        "details": {},
                    },
                )
            ],
            "authority-bearing progress event",
        ),
        (
            [
                (
                    "accepted",
                    1,
                    {
                        "type": "accepted",
                        "sequence": 1,
                        "at": "2026-07-15T00:00:00.000Z",
                        "request_id": OFFER_REQUEST["request_id"],
                        "message": "admitted",
                        "authority": "research_only",
                        "action_state": "REVIEW",
                        "details": {},
                    },
                ),
                (
                    "coverage",
                    1,
                    {
                        "type": "coverage",
                        "sequence": 1,
                        "at": "2026-07-15T00:00:00.010Z",
                        "request_id": OFFER_REQUEST["request_id"],
                        "message": "coverage recorded",
                        "authority": "research_only",
                        "action_state": "REVIEW",
                        "details": {},
                    },
                ),
            ],
            "not monotonic",
        ),
        (
            [
                (
                    "accepted",
                    0,
                    {
                        "type": "accepted",
                        "sequence": 0,
                        "at": "2026-07-15T00:00:00.000Z",
                        "request_id": "different-request",
                        "message": "admitted",
                        "authority": "research_only",
                        "action_state": "REVIEW",
                        "details": {},
                    },
                )
            ],
            "request ID",
        ),
    ],
)
def test_stream_offer_search_rejects_authority_or_sequence_drift(events, message):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=offer_search_sse(*events),
        )

    with make_client(handler) as c:
        with pytest.raises(TypeError, match=message):
            list(c.stream_offer_search(OFFER_REQUEST))


def test_stream_offer_search_close_closes_the_http_response():
    closed = False
    accepted = {
        "type": "accepted",
        "sequence": 0,
        "at": "2026-07-15T00:00:00.000Z",
        "request_id": OFFER_REQUEST["request_id"],
        "message": "admitted",
        "authority": "research_only",
        "action_state": "REVIEW",
        "details": {},
    }

    class TrackingStream(httpx.SyncByteStream):
        def __iter__(self):
            yield offer_search_sse(("accepted", 0, accepted))
            yield offer_search_sse(("final", 1, OFFER_RESULT))

        def close(self):
            nonlocal closed
            closed = True

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=TrackingStream(),
        )

    with make_client(handler) as c:
        stream = c.stream_offer_search(OFFER_REQUEST)
        assert next(stream)["type"] == "accepted"
        stream.close()

    assert closed is True


def test_search_offers_surfaces_persisted_lifecycle_without_permission():
    response = {
        **OFFER_RESULT,
        "candidates": [
            {
                "candidate_id": f"sha256:{'1' * 64}",
                "disposition": "review",
            }
        ],
        "lifecycle": {
            "persistence": "persisted",
            "dependency_id": OFFER_GATE_REQUEST["dependency_id"],
            "generation_id": OFFER_GATE_REQUEST["generation_id"],
            "generation_number": OFFER_GATE_REQUEST["generation_number"],
            "generation_digest": OFFER_GATE_REQUEST["generation_digest"],
            "selected_candidate_id": f"sha256:{'1' * 64}",
            "expires_at": OFFER_GATE_RESULT["expires_at"],
            "action_binding": ACTION_BINDING,
            "action_time_gate": OFFER_GATE_RESULT,
        },
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response)

    with make_client(handler) as c:
        result = c.search_offers(OFFER_REQUEST)

    assert result["lifecycle"]["persistence"] == "persisted"
    assert result["lifecycle"]["action_time_gate"]["disposition"] == "REVIEW"
    assert result["lifecycle"]["action_time_gate"]["permission"] == "withheld"


@pytest.mark.parametrize(
    ("candidates", "gate"),
    [
        ([], OFFER_GATE_RESULT),
        (
            [
                {
                    "candidate_id": f"sha256:{'1' * 64}",
                    "disposition": "review",
                },
                {
                    "candidate_id": f"sha256:{'1' * 64}",
                    "disposition": "review",
                },
            ],
            OFFER_GATE_RESULT,
        ),
        (
            [
                {
                    "candidate_id": f"sha256:{'1' * 64}",
                    "disposition": "review",
                }
            ],
            {**OFFER_GATE_RESULT, "generation_id": "offer:generation-other"},
        ),
        (
            [
                {
                    "candidate_id": f"sha256:{'1' * 64}",
                    "disposition": "review",
                }
            ],
            {
                **OFFER_GATE_RESULT,
                "state": "stale_generation",
                "generation_id": "offer:generation-other",
            },
        ),
        (
            [
                {
                    "candidate_id": f"sha256:{'1' * 64}",
                    "disposition": "review",
                }
            ],
            {**OFFER_GATE_RESULT, "final_fence_checked": False},
        ),
    ],
)
def test_search_offers_rejects_inconsistent_persisted_lifecycle(
    candidates, gate
):
    response = {
        **OFFER_RESULT,
        "candidates": candidates,
        "lifecycle": {
            "persistence": "persisted",
            "dependency_id": OFFER_GATE_REQUEST["dependency_id"],
            "generation_id": OFFER_GATE_REQUEST["generation_id"],
            "generation_number": OFFER_GATE_REQUEST["generation_number"],
            "generation_digest": OFFER_GATE_REQUEST["generation_digest"],
            "selected_candidate_id": f"sha256:{'1' * 64}",
            "expires_at": OFFER_GATE_RESULT["expires_at"],
            "action_binding": ACTION_BINDING,
            "action_time_gate": gate,
        },
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response)

    with make_client(handler) as c:
        with pytest.raises(
            TypeError, match="invalid lifecycle|permission must remain withheld"
        ):
            c.search_offers(OFFER_REQUEST)


def test_search_offers_surfaces_not_created_lifecycle_as_review_only_absence():
    response = {
        **OFFER_RESULT,
        "lifecycle": {
            "persistence": "not_created",
            "reason_codes": ["NO_QUALIFIED_CHECKOUT_EVIDENCE"],
            "action_time_gate": {
                "state": "not_found",
                "disposition": "REVIEW",
                "permission": "withheld",
                "reason_codes": ["COMMERCE_GENERATION_NOT_CREATED"],
                "checked_at": "2026-07-15T00:00:00.130Z",
                "final_fence_checked": False,
            },
        },
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response)

    with make_client(handler) as c:
        result = c.search_offers(OFFER_REQUEST)

    assert result["lifecycle"]["persistence"] == "not_created"
    assert result["lifecycle"]["action_time_gate"]["state"] == "not_found"
    assert result["lifecycle"]["action_time_gate"]["permission"] == "withheld"


def test_gate_offer_search_posts_exact_final_fence_request_and_stays_review_only():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/search-offers/gate"
        captured["body"] = json.loads(request.content)
        captured["key"] = request.headers.get("idempotency-key")
        captured["timeout"] = request.extensions.get("timeout")
        return httpx.Response(200, json=OFFER_GATE_RESULT)

    with make_client(handler) as c:
        result = c.gate_offer_search(OFFER_GATE_REQUEST, timeout=12.0)

    assert captured["body"] == OFFER_GATE_REQUEST
    assert captured["key"] is None
    assert captured["timeout"]["read"] == 12.0
    assert result["state"] == "current_review_only"
    assert result["disposition"] == "REVIEW"
    assert result["permission"] == "withheld"


@pytest.mark.parametrize(
    "drift",
    [
        {"disposition": "ALLOW"},
        {"permission": "granted"},
        {"decision": "BLOCK"},
        {"nested": {"safe_to_quote": True}},
        {"nested": {"permission": "granted"}},
        {"final_fence_checked": False},
        {"generation_id": "offer:generation-other"},
        {"generation_number": 2},
        {"generation_digest": f"sha256:{'e' * 64}"},
    ],
)
def test_gate_offer_search_rejects_authority_drift(drift):
    response = {**OFFER_GATE_RESULT, **drift}

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response)

    with make_client(handler) as c:
        with pytest.raises(TypeError, match="permission must remain withheld"):
            c.gate_offer_search(OFFER_GATE_REQUEST)


@pytest.mark.parametrize(
    "drift",
    [
        {"decision": "ALLOW"},
        {"action": {"state": "SAFE_TO_QUOTE", "reason_codes": []}},
        {"candidates": [{"disposition": "eligible", "safe_to_quote": True}]},
    ],
)
def test_search_offers_rejects_any_response_that_looks_like_permission(drift):
    response = {**OFFER_RESULT, **drift}

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response)

    with make_client(handler) as c:
        with pytest.raises(TypeError, match="shadow results cannot authorize"):
            c.search_offers(OFFER_REQUEST)


@pytest.mark.parametrize(
    "response",
    [
        {key: value for key, value in OFFER_RESULT.items() if key != "request_digest"},
        {**OFFER_RESULT, "request_digest": "sha256:not-a-digest"},
        {**OFFER_RESULT, "request_id": "different-request"},
    ],
)
def test_search_offers_rejects_missing_malformed_or_foreign_request_binding(
    response,
):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response)

    with make_client(handler) as c:
        with pytest.raises(TypeError, match="request ID|digest|another request"):
            c.search_offers(OFFER_REQUEST)


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
        return httpx.Response(
            200,
            json=OFFER_RESULT if request.url.path == "/v1/search-offers" else {},
        )

    operation_key = "logical-operation-0001"
    with make_client(handler) as c:
        c.check("x", idempotency_key=operation_key)
        c.verify("x", idempotency_key=operation_key)
        c.extract_and_check("x", idempotency_key=operation_key)
        c.scan_store(["x"], idempotency_key=operation_key)
        c.monitor(["x"], idempotency_key=operation_key)
        c.search_offers(OFFER_REQUEST, idempotency_key=operation_key)
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
        "/v1/search-offers",
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
