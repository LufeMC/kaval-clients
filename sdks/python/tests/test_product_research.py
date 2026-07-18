"""Hermetic Product Research JSON/SSE parity tests."""

import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread, enumerate as enumerate_threads
from time import monotonic
from typing import get_type_hints

import httpx
import pytest

from kaval import (
    KavalCancellationToken,
    KavalCancelledError,
    KavalClient,
    KavalError,
    ProductResearchCandidate,
    ProductResearchCatalogIdentityEvidence,
    ProductResearchExecutionReceipt,
    ProductResearchFieldEvidence,
)
from kaval.models import (
    ProductResearchCancelledEvent,
    ProductResearchDeliveryEvidence,
    ProductResearchFailedEvent,
    ProductResearchInput,
    ProductResearchResult,
)

REQUEST: ProductResearchInput = {
    "query": "cordless framing nailer",
    "market": {"country_code": "US", "preferred_currency": "USD"},
    "filters": {
        "condition": "new",
        "merchant_policy": {
            "allowed_domains": [],
            "blocked_domains": [],
            "marketplace_policy": "exclude",
        },
    },
}

RESULT: ProductResearchResult = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "fixtures"
        / "product-research-result-v1.json"
    ).read_text()
)

DELIVERY: ProductResearchDeliveryEvidence = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "fixtures"
        / "product-research-delivery-v1.json"
    ).read_text()
)

ACCEPTED = {
    "type": "accepted",
    "research_id": RESULT["research_id"],
    "request_digest": RESULT["request_digest"],
    "sequence": 0,
    "observed_at": RESULT["started_at"],
    "query": REQUEST["query"],
}


def canonical_terminal_result(
    operational_state: str,
) -> ProductResearchResult:
    result = copy.deepcopy(RESULT)
    result["operational_state"] = operational_state
    result["research_state"] = "not_completed"
    result["coverage"]["stop_reason"] = (
        "upstream_unavailable" if operational_state == "failed" else "cancelled"
    )
    return result


def result_with_discovery(
    overrides: dict | None = None,
) -> ProductResearchResult:
    result = copy.deepcopy(RESULT)
    result["unverified_discoveries"] = [
        {
            "discovery_id": f"sha256:{'d' * 64}",
            "title": "Unverified web result",
            "origin_url": "https://merchant.example/products/accessory-1",
            "merchant_domain": "merchant.example",
            "listing_kind": "unknown",
            "relationship": "unknown",
            "discovered_price": None,
            "observed_at": result["completed_at"],
            "discovered_by": ["search:fixture"],
            "verification_tier": "discovered_unverified",
            "possible_group_id": None,
            "warning_codes": ["DISCOVERY_NOT_ORIGIN_VERIFIED"],
            **(overrides or {}),
        }
    ]
    result["coverage"]["unverified_discovery_count"] = 1
    return result


def result_with_blocked_source() -> ProductResearchResult:
    result = copy.deepcopy(RESULT)
    result["coverage"]["source_ledger"].append(
        {
            "source_id": "search:blocked-by-policy",
            "family": "shopping_search",
            "origin_domain": None,
            "disposition": "blocked",
            "reason_code": "RIGHTS_BLOCKED",
            "reason_codes": ["RIGHTS_BLOCKED"],
            "calls": 0,
            "outcome_counts": {
                "succeeded": 0,
                "empty": 0,
                "failed": 0,
                "blocked": 1,
                "cancelled": 0,
                "deferred": 0,
                "unsearched": 0,
            },
            "candidates_discovered": 0,
            "verified_offers": 0,
            "cost_micro_usd": 0,
            "avoided_cost_micro_usd": 0,
        }
    )
    return result


def result_with_safety_blocked_source(calls: int) -> ProductResearchResult:
    result = copy.deepcopy(RESULT)
    result["coverage"]["source_ledger"].append(
        {
            "source_id": "origin:unsafe-host",
            "family": "retailer_origin",
            "origin_domain": "unsafe-host.example",
            "disposition": "blocked",
            "reason_code": "ORIGIN_BLOCKED",
            "reason_codes": ["ORIGIN_BLOCKED"],
            "calls": calls,
            "outcome_counts": {
                "succeeded": 0,
                "empty": 0,
                "failed": 0,
                "blocked": 1,
                "cancelled": 0,
                "deferred": 0,
                "unsearched": 0,
            },
            "candidates_discovered": 0,
            "verified_offers": 0,
            "cost_micro_usd": 0,
            "avoided_cost_micro_usd": 0,
        }
    )
    result["coverage"]["execution_receipt"]["fetch_calls"] += calls
    result["coverage"]["execution_receipt"]["providers_configured"] += 1
    result["coverage"]["source_families_attempted"].append("retailer_origin")
    result["coverage"]["merchant_origins_attempted"] += 1
    return result


MATERIAL_CANDIDATE_FIELDS = [
    ("title", "publish_title"),
    ("origin_url", "publish_origin_url"),
    ("merchant_origin", "derive_merchant_origin"),
    ("listing_kind", "classify_listing_kind"),
    ("seller_name", "publish_seller_name"),
    ("relationship", "classify_relationship"),
    ("condition", "publish_condition"),
    ("pack", "publish_pack"),
    ("availability", "publish_availability"),
    ("product_identity", "publish_identity"),
    ("item_price", "publish_item_price"),
    ("price_basis", "derive_price_basis"),
    ("price_qualifiers", "derive_price_qualifiers"),
]


def origin_field_evidence(origin_url: str, observed_at: str) -> list[dict]:
    evidence = []
    for index, (field, derivation) in enumerate(MATERIAL_CANDIDATE_FIELDS, 1):
        digest = f"sha256:{index:064x}"
        evidence.append(
            {
                "field": field,
                "verification_tier": "origin_verified",
                "source_id": "origin:merchant.example",
                "source_url": origin_url,
                "observed_at": observed_at,
                "evidence_digest": digest,
                "version_receipt": None,
                "evidence_binding": {
                    "kind": "origin",
                    "receipt": {
                        "artifact": "static_http_body",
                        "structure": "json_ld",
                        "source_block_index": 0,
                        "product_index": 0,
                        "offer_index": 0,
                        "content_digest": digest,
                        "version_receipt": None,
                    },
                    "locators": [
                        {
                            "field_path": field,
                            "source_values": [
                                {
                                    "object_role": (
                                        "artifact_origin"
                                        if field in {"origin_url", "merchant_origin"}
                                        else "product"
                                    ),
                                    "path": (
                                        "$origin_url"
                                        if field in {"origin_url", "merchant_origin"}
                                        else f"/{field.replace('.', '/')}"
                                    ),
                                    "raw_value_digest": digest,
                                }
                            ],
                            "transformations": ["trim_text"],
                            "observed_value_digest": digest,
                        }
                    ],
                },
                "derivations": [derivation],
            }
        )
    return evidence


def candidate_with_delivery(
    delivery: ProductResearchDeliveryEvidence | None,
    qualifiers: list[str] | None = None,
    basis: dict | None = None,
) -> dict:
    origin_url = "https://merchant.example/products/framing-nailer"
    price_qualifiers = ["standard"] if qualifiers is None else list(qualifiers)
    price_basis = (
        {"kind": "per_orderable_item"} if basis is None else copy.deepcopy(basis)
    )
    return {
        "candidate_id": f"sha256:{'e' * 64}",
        "candidate_state": "offer",
        "product_name": "Cordless framing nailer",
        "identifiers": [
            {
                "scheme": "mpn",
                "value": "NAILER-1",
                "issuer": "Fixture Tools",
            }
        ],
        "attributes": [],
        "pack": {"count": 1},
        "condition": "new",
        "listing_kind": "purchase",
        "relationship": "primary_product",
        "price": {
            "amount": {"amount_minor": 19_900, "currency": "USD"},
            "basis": price_basis,
            "qualifiers": price_qualifiers,
            "shipping_included": None,
            "tax_included": None,
        },
        "delivery": copy.deepcopy(delivery),
        "availability": "in_stock",
        "merchant": {
            "display_name": "Merchant",
            "origin_domain": "merchant.example",
        },
        "origin_url": origin_url,
        "observed_at": RESULT["completed_at"],
        "expires_at": (
            delivery["expires_at"] if delivery is not None else RESULT["expires_at"]
        ),
        "verification_tier": "origin_verified",
        "field_evidence": origin_field_evidence(origin_url, RESULT["completed_at"]),
        "identity_evidence": {
            "basis": "hard_identifier",
            "identifier": {
                "scheme": "mpn",
                "value": "NAILER-1",
                "issuer": "Fixture Tools",
            },
        },
        "conflict_codes": [],
        "discovered_by": ["search:fixture"],
    }


def discovery_candidate(overrides: dict | None = None) -> dict:
    candidate = candidate_with_delivery(None)
    candidate.update(
        {
            "candidate_state": "discovery",
            "product_name": "Unverified web result",
            "identifiers": [],
            "pack": None,
            "condition": "unknown",
            "relationship": "unknown",
            "listing_kind": "unknown",
            "price": None,
            "availability": "unknown",
            "verification_tier": "discovered_unverified",
            "field_evidence": [],
            "identity_evidence": {"basis": "descriptive"},
            **(overrides or {}),
        }
    )
    return candidate


def result_with_offer(
    delivery: ProductResearchDeliveryEvidence | None,
    qualifiers: list[str] | None = None,
    basis: dict | None = None,
) -> ProductResearchResult:
    result = copy.deepcopy(RESULT)
    candidate = candidate_with_delivery(delivery, qualifiers, basis)
    result["research_state"] = "offers_found"
    result["groups"] = [
        {
            "group_id": f"sha256:{'2' * 64}",
            "rank": 1,
            "match_status": "possible",
            "identity_basis": "descriptive",
            "identity_receipt_digest": None,
            "product_name": candidate["product_name"],
            "identifiers": candidate["identifiers"],
            "attributes": candidate["attributes"],
            "pack": candidate["pack"],
            "condition": candidate["condition"],
            "listing_kind": candidate["listing_kind"],
            "relationship": candidate["relationship"],
            "offers": [
                {
                    "offer_id": candidate["candidate_id"],
                    "rank": 1,
                    "match_status": "possible",
                    "title": candidate["product_name"],
                    "origin_url": candidate["origin_url"],
                    "merchant": candidate["merchant"],
                    "listing_kind": candidate["listing_kind"],
                    "relationship": candidate["relationship"],
                    "condition": candidate["condition"],
                    "pack": candidate["pack"],
                    "price": candidate["price"],
                    "delivery": candidate["delivery"],
                    "availability": candidate["availability"],
                    "verification_tier": "origin_verified",
                    "observed_at": candidate["observed_at"],
                    "expires_at": candidate["expires_at"],
                    "field_evidence": candidate["field_evidence"],
                    "comparison_key": None,
                    "price_label": None,
                    "warning_codes": [],
                }
            ],
            "conflict_codes": [],
            "refinement_codes": ["EXACT_IDENTITY_REFINEMENT_REQUIRED"],
        }
    ]
    result["coverage"]["verified_offer_count"] = 1
    result["coverage"]["product_group_count"] = 1
    result["coverage"]["execution_receipt"]["first_useful_candidate_ms"] = 1_000
    result["expires_at"] = candidate["expires_at"]
    return result


def make_client(handler):
    return KavalClient(base_url="http://test", transport=httpx.MockTransport(handler))


def product_research_sse(*events: dict) -> bytes:
    return "".join(
        f"event: {event['type']}\nid: {event['sequence']}\n"
        f"data: {json.dumps(event)}\n\n"
        for event in events
    ).encode()


def collect(stream):
    events = []
    while True:
        try:
            events.append(next(stream))
        except StopIteration as completed:
            return events, completed.value


def test_product_research_models_keep_limits_server_owned():
    assert ProductResearchInput.__required_keys__ == {"query"}
    assert "limits" not in ProductResearchInput.__annotations__
    assert ProductResearchResult.__required_keys__ >= {
        "research_id",
        "request_digest",
        "authority",
        "coverage",
    }
    assert "result" in ProductResearchFailedEvent.__required_keys__
    assert "result" in ProductResearchCancelledEvent.__required_keys__
    assert ProductResearchFieldEvidence.__required_keys__ >= {
        "evidence_binding",
        "derivations",
    }
    assert (
        "resolution_supporting_records"
        in ProductResearchCatalogIdentityEvidence.__required_keys__
    )
    assert "NotRequired" in repr(
        get_type_hints(
            ProductResearchExecutionReceipt,
            include_extras=True,
        )["browser_attempt_count"]
    )
    assert "unknown" in repr(get_type_hints(ProductResearchCandidate)["listing_kind"])


def test_research_products_accepts_canonical_performance_rating_clue():
    payload = copy.deepcopy(RESULT)
    payload["interpretation"]["clues"] = [
        {
            "clue_id": "clue:performance_rating:0:8",
            "kind": "performance_rating",
            "value": "cordless",
            "normalized_value": "cordless",
            "authority": "retrieval_only",
            "provenance": {
                "source": "query_text",
                "field": "query",
                "span": {
                    "encoding": "utf16_code_unit",
                    "start": 0,
                    "end": 8,
                    "text": "cordless",
                },
            },
        }
    ]

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == payload


def test_cancellation_token_is_one_shot_and_preserves_the_first_reason():
    token = KavalCancellationToken()
    first_reason = RuntimeError("caller cancelled")

    assert token.cancelled is False
    assert token.cancel(first_reason) is True
    assert token.cancel("ignored second reason") is False
    assert token.cancelled is True
    assert token.reason is first_reason
    assert token.wait(0) is True
    with pytest.raises(KavalCancelledError) as raised:
        token.raise_if_cancelled()
    assert raised.value.reason is first_reason
    assert str(raised.value) == "caller cancelled"
    assert raised.value.idempotency_key is None


def test_research_products_pre_cancel_skips_transport_and_retains_operation_key():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=RESULT)

    token = KavalCancellationToken()
    token.cancel("cancelled before call")
    with make_client(handler) as client:
        with pytest.raises(KavalCancelledError) as raised:
            client.research_products(
                REQUEST,
                idempotency_key="product-research-pre-cancel-0001",
                cancellation_token=token,
            )

    assert calls == 0
    assert str(raised.value) == "cancelled before call"
    assert raised.value.idempotency_key == "product-research-pre-cancel-0001"


def test_research_products_inflight_cancel_releases_caller_without_retry():
    request_started = Event()
    release_transport = Event()
    response_closed = Event()
    calls = 0

    class LateResponseStream(httpx.SyncByteStream):
        def __iter__(self):
            yield json.dumps(RESULT).encode()

        def close(self):
            response_closed.set()

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        request_started.set()
        assert release_transport.wait(3)
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            stream=LateResponseStream(),
        )

    token = KavalCancellationToken()
    outcome = []
    client = make_client(handler)

    def invoke() -> None:
        try:
            outcome.append(
                client.research_products(
                    REQUEST,
                    idempotency_key="product-research-inflight-cancel-0001",
                    cancellation_token=token,
                )
            )
        except BaseException as error:
            outcome.append(error)

    caller = Thread(target=invoke)
    try:
        caller.start()
        assert request_started.wait(2)
        token.cancel("caller cancelled")
        caller.join(2)

        assert caller.is_alive() is False
        assert len(outcome) == 1
        assert isinstance(outcome[0], KavalCancelledError)
        assert str(outcome[0]) == "caller cancelled"
        assert outcome[0].idempotency_key == "product-research-inflight-cancel-0001"
        assert calls == 1
    finally:
        release_transport.set()
        assert response_closed.wait(2)
        caller.join(2)
        client.close()


def test_research_products_cancel_does_not_wait_for_blocking_response_close():
    response_body_started = Event()
    release_response_body = Event()
    response_close_started = Event()
    release_response_close = Event()
    response_close_finished = Event()

    class BlockingCloseStream(httpx.SyncByteStream):
        def __iter__(self):
            response_body_started.set()
            assert release_response_body.wait(3)
            yield json.dumps(RESULT).encode()

        def close(self):
            response_close_started.set()
            assert release_response_close.wait(3)
            response_close_finished.set()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            stream=BlockingCloseStream(),
        )

    token = KavalCancellationToken()
    outcome = []
    client = make_client(handler)

    def invoke() -> None:
        try:
            outcome.append(
                client.research_products(
                    REQUEST,
                    idempotency_key="product-research-blocking-close-0001",
                    cancellation_token=token,
                )
            )
        except BaseException as error:
            outcome.append(error)

    caller = Thread(target=invoke)
    try:
        caller.start()
        assert response_body_started.wait(2)
        cancelled_at = monotonic()
        assert token.cancel("caller cancelled before blocking cleanup")
        cancel_seconds = monotonic() - cancelled_at
        caller.join(0.25)

        assert cancel_seconds < 0.25
        assert caller.is_alive() is False
        assert len(outcome) == 1
        assert isinstance(outcome[0], KavalCancelledError)
        assert outcome[0].idempotency_key == ("product-research-blocking-close-0001")
        assert response_close_started.wait(1)
        assert response_close_finished.is_set() is False
    finally:
        release_response_close.set()
        release_response_body.set()
        assert response_close_finished.wait(2)
        caller.join(2)
        client.close()


def test_research_products_posts_exact_product_only_request_and_key():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        captured["key"] = request.headers["idempotency-key"]
        return httpx.Response(200, json=RESULT)

    with make_client(handler) as client:
        result = client.research_products(
            REQUEST,
            idempotency_key="product-research-operation-0001",
            timeout=12.0,
        )

    assert captured == {
        "path": "/v1/product-research",
        "body": REQUEST,
        "key": "product-research-operation-0001",
    }
    assert result == RESULT
    assert result["authority"]["permission"] == "withheld"
    assert result["coverage"]["execution_receipt"]["browser_attempt_count"] == 0


def test_research_products_accepts_legacy_receipt_without_browser_metrics():
    payload = copy.deepcopy(RESULT)
    del payload["coverage"]["execution_receipt"]["browser_attempt_count"]

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == payload


@pytest.mark.parametrize(
    "count",
    [-1, 0.5, True, 9_007_199_254_740_992, 1],
)
def test_research_products_rejects_invalid_browser_attempt_count(count):
    payload = copy.deepcopy(RESULT)
    payload["coverage"]["execution_receipt"]["browser_attempt_count"] = count

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


def test_research_products_preserves_canonical_failed_result():
    failed = copy.deepcopy(RESULT)
    failed["operational_state"] = "failed"
    failed["research_state"] = "not_completed"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=failed)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == failed


def test_research_products_preserves_neutral_unverified_discovery():
    payload = result_with_discovery()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == payload


@pytest.mark.parametrize(
    "overrides",
    [
        {"title": "Compatible framing nailer accessory"},
        {"relationship": "accessory"},
        {"origin_url": ("https://merchant.example/products/accessory-1#sig=secret")},
        {"merchant_domain": "other.example"},
    ],
)
def test_research_products_rejects_noncanonical_unverified_discovery(
    overrides,
):
    payload = result_with_discovery(overrides)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


def test_research_products_preserves_zero_call_blocked_source():
    payload = result_with_blocked_source()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == payload


def test_research_products_preserves_one_call_safety_blocked_source():
    payload = result_with_safety_blocked_source(1)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == payload


def test_research_products_rejects_blocked_source_call_overcount():
    payload = result_with_safety_blocked_source(2)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


@pytest.mark.parametrize("delivery", [DELIVERY, None])
def test_research_products_preserves_delivery_evidence_and_explicit_null(delivery):
    payload = result_with_offer(delivery)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == payload


@pytest.mark.parametrize("field", ["pack", "condition"])
def test_research_products_accepts_unknown_offer_field_under_known_group(field):
    payload = result_with_offer(None)
    payload["groups"][0]["offers"][0][field] = None if field == "pack" else "unknown"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == payload


@pytest.mark.parametrize(
    "mutation",
    [
        "empty_material_evidence",
        "missing_price_basis",
        "foreign_evidence_url",
        "foreign_merchant_hostname",
        "unbound_receipt_digest",
        "secret_origin_url",
    ],
)
def test_research_products_rejects_unbound_verified_offer(mutation):
    payload = result_with_offer(None)
    offer = payload["groups"][0]["offers"][0]
    if mutation == "empty_material_evidence":
        offer["field_evidence"] = []
    elif mutation == "missing_price_basis":
        offer["field_evidence"] = [
            item for item in offer["field_evidence"] if item["field"] != "price_basis"
        ]
    elif mutation == "foreign_evidence_url":
        offer["field_evidence"][0]["source_url"] = (
            "https://other.example/products/framing-nailer"
        )
    elif mutation == "foreign_merchant_hostname":
        offer["merchant"]["origin_domain"] = "other.example"
    elif mutation == "unbound_receipt_digest":
        offer["field_evidence"][0]["evidence_digest"] = f"sha256:{'f' * 64}"
    else:
        offer["origin_url"] += "#sig=secret"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


def test_research_products_preserves_unknown_price_qualifier():
    payload = result_with_offer(None, ["unknown"])

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == payload


def test_research_products_preserves_positive_per_unit_basis():
    payload = result_with_offer(
        None,
        ["estimated"],
        {"kind": "per_unit", "quantity": 12, "unit": "ft"},
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        assert client.research_products(REQUEST) == payload


@pytest.mark.parametrize(
    "basis",
    [
        {"kind": "per_unit", "quantity": 12},
        {"kind": "per_unit", "unit": "ft"},
        {"kind": "per_unit", "quantity": 0, "unit": "ft"},
        {"kind": "per_unit", "quantity": 12, "unit": ""},
        {"kind": "per_unit", "quantity": 12, "unit": "ft", "rate": 1},
    ],
)
def test_research_products_rejects_malformed_per_unit_basis(basis):
    payload = result_with_offer(None, ["estimated"], basis)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


@pytest.mark.parametrize(
    "qualifiers",
    [
        ["unknown", "sale"],
        ["standard", "member"],
    ],
)
def test_research_products_rejects_exclusive_price_terms_mixed_with_conditionals(
    qualifiers,
):
    payload = result_with_offer(None, qualifiers)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        (
            "calculated_landed_total",
            {"amount_minor": 22_051, "currency": "USD"},
        ),
        ("origin_url", "https://other.example/products/framing-nailer"),
        ("version_receipt", "checkout-other/1:quote-42"),
        ("research_request_digest", f"sha256:{'9' * 64}"),
    ],
)
def test_research_products_rejects_invalid_delivery_evidence(field, value):
    delivery = copy.deepcopy(DELIVERY)
    delivery[field] = value
    payload = result_with_offer(delivery)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


@pytest.mark.parametrize(
    "payload",
    [
        {
            **RESULT,
            "authority": {
                "mode": "review_only",
                "action_authorized": True,
                "permission": "withheld",
            },
        },
        {**RESULT, "request_digest": "sha256:not-a-digest"},
        {
            **RESULT,
            "interpretation": {
                **RESULT["interpretation"],
                "original_query": "a different product",
            },
        },
        result_with_discovery({"relationship": "other"}),
    ],
)
def test_research_products_rejects_authority_shape_and_query_drift(payload):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


@pytest.mark.parametrize(
    "mutation",
    [
        "malformed_clue",
        "duplicate_clue_id",
        "malformed_query",
        "duplicate_query_id",
        "duplicate_query_text",
        "duplicate_listing_intent",
        "invalid_warning",
        "invalid_refinement",
        "duplicate_discovery_id",
        "invalid_gap_code",
        "invalid_ledger_reason",
    ],
)
def test_research_products_rejects_noncanonical_nested_contracts(mutation):
    payload = copy.deepcopy(RESULT)
    if mutation == "malformed_clue":
        payload["interpretation"]["clues"] = [{"garbage": 1}]
    elif mutation == "duplicate_clue_id":
        clue = {
            "clue_id": "clue:brand:fixture",
            "kind": "brand",
            "value": "Fixture",
            "normalized_value": "fixture",
            "authority": "retrieval_only",
            "provenance": {
                "source": "request_filter",
                "field": "filters.brand",
            },
        }
        payload["interpretation"]["clues"] = [clue, copy.deepcopy(clue)]
    elif mutation == "malformed_query":
        query = copy.deepcopy(payload["interpretation"]["query_bundle"]["queries"][0])
        query.update({"text": "", "rationale_codes": [], "extra": True})
        payload["interpretation"]["query_bundle"]["queries"] = [query]
    elif mutation == "duplicate_query_id":
        query = copy.deepcopy(payload["interpretation"]["query_bundle"]["queries"][0])
        query.update({"kind": "commercial", "text": "cordless framing nailer price"})
        payload["interpretation"]["query_bundle"]["queries"].append(query)
    elif mutation == "duplicate_query_text":
        query = copy.deepcopy(payload["interpretation"]["query_bundle"]["queries"][0])
        query.update(
            {
                "query_id": f"sha256:{'c' * 64}",
                "kind": "normalized",
                "text": query["text"].upper(),
            }
        )
        payload["interpretation"]["query_bundle"]["queries"].append(query)
    elif mutation == "duplicate_listing_intent":
        payload["interpretation"]["listing_intent"] = [
            "purchase",
            "purchase",
        ]
    elif mutation == "invalid_warning":
        payload["warnings"][0].update({"code": "not canonical", "message": ""})
    elif mutation == "invalid_refinement":
        payload["requested_refinements"] = [
            {
                "field": "brand",
                "reason_code": "",
                "prompt": "",
                "required_for": "better_matches",
                "options": ["", ""],
            }
        ]
    elif mutation == "duplicate_discovery_id":
        payload["unverified_discoveries"].append(
            copy.deepcopy(payload["unverified_discoveries"][0])
        )
        payload["coverage"]["unverified_discovery_count"] = 2
    elif mutation == "invalid_gap_code":
        payload["coverage"]["gap_codes"] = [""]
    else:
        ledger = payload["coverage"]["source_ledger"][0]
        ledger["reason_code"] = "not canonical"
        ledger["reason_codes"] = ["not canonical"]

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


@pytest.mark.parametrize("duplicate", ["group_id", "rank"])
def test_research_products_rejects_duplicate_group_identity_or_rank(duplicate):
    payload = result_with_offer(None)
    second = copy.deepcopy(payload["groups"][0])
    if duplicate == "group_id":
        second["rank"] = 2
    else:
        second["group_id"] = f"sha256:{'3' * 64}"
    payload["groups"].append(second)
    payload["coverage"]["product_group_count"] = 2
    payload["coverage"]["verified_offer_count"] = 2

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


@pytest.mark.parametrize(
    "mutation",
    ["empty_reason_codes", "outcome_count_drift", "false_first_useful"],
)
def test_research_products_rejects_lossy_or_inconsistent_execution_receipts(
    mutation,
):
    payload = copy.deepcopy(RESULT)
    if mutation == "empty_reason_codes":
        payload["coverage"]["source_ledger"][0]["reason_codes"] = []
    elif mutation == "outcome_count_drift":
        payload["coverage"]["source_ledger"][0]["outcome_counts"]["failed"] = 0
    else:
        payload["coverage"]["execution_receipt"]["first_useful_candidate_ms"] = 1

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            client.research_products(REQUEST)


def test_stream_product_research_retries_preheaders_with_the_same_key():
    attempts = []
    completed = {
        "type": "completed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "result": RESULT,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request.headers["idempotency-key"])
        assert request.url.path == "/v1/product-research"
        assert request.headers["accept"] == "text/event-stream"
        assert json.loads(request.content) == REQUEST
        if len(attempts) == 1:
            raise httpx.ConnectError("before headers", request=request)
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, completed),
        )

    with make_client(handler) as client:
        events, result = collect(
            client.stream_product_research(
                REQUEST,
                idempotency_key="product-research-stream-0001",
            )
        )

    assert attempts == [
        "product-research-stream-0001",
        "product-research-stream-0001",
    ]
    assert [event["type"] for event in events] == ["accepted", "completed"]
    assert result == RESULT


@pytest.mark.parametrize("delivery", [DELIVERY, None])
def test_stream_product_research_validates_candidate_delivery(delivery):
    observed = {
        "type": "candidate_observed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "candidate": candidate_with_delivery(delivery),
    }
    completed = {
        "type": "completed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 2,
        "observed_at": RESULT["completed_at"],
        "result": RESULT,
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, observed, completed),
        )

    with make_client(handler) as client:
        events, result = collect(client.stream_product_research(REQUEST))

    assert events[1]["candidate"]["delivery"] == delivery
    assert result == RESULT


def test_stream_product_research_validates_unknown_price_qualifier():
    observed = {
        "type": "candidate_observed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "candidate": candidate_with_delivery(None, ["unknown"]),
    }
    completed = {
        "type": "completed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 2,
        "observed_at": RESULT["completed_at"],
        "result": RESULT,
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, observed, completed),
        )

    with make_client(handler) as client:
        events, result = collect(client.stream_product_research(REQUEST))

    assert events[1]["candidate"]["price"]["qualifiers"] == ["unknown"]
    assert result == RESULT


def test_stream_product_research_validates_positive_per_unit_basis():
    observed = {
        "type": "candidate_observed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "candidate": candidate_with_delivery(
            None,
            ["estimated"],
            {"kind": "per_unit", "quantity": 2.5, "unit": "kg"},
        ),
    }
    completed = {
        "type": "completed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 2,
        "observed_at": RESULT["completed_at"],
        "result": RESULT,
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, observed, completed),
        )

    with make_client(handler) as client:
        events, result = collect(client.stream_product_research(REQUEST))

    assert events[1]["candidate"]["price"]["basis"] == {
        "kind": "per_unit",
        "quantity": 2.5,
        "unit": "kg",
    }
    assert result == RESULT


@pytest.mark.parametrize("mutation", ["empty_material_evidence", "foreign_hostname"])
def test_stream_product_research_rejects_unbound_candidate(mutation):
    candidate = candidate_with_delivery(None)
    if mutation == "empty_material_evidence":
        candidate["field_evidence"] = []
    else:
        candidate["merchant"]["origin_domain"] = "other.example"
    observed = {
        "type": "candidate_observed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "candidate": candidate,
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=product_research_sse(ACCEPTED, observed),
            headers={"content-type": "text/event-stream"},
        )

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            list(client.stream_product_research(REQUEST))


def test_stream_product_research_validates_neutral_discovery_candidate():
    observed = {
        "type": "candidate_observed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "candidate": discovery_candidate(),
    }
    completed = {
        "type": "completed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 2,
        "observed_at": RESULT["completed_at"],
        "result": RESULT,
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, observed, completed),
        )

    with make_client(handler) as client:
        events, result = collect(client.stream_product_research(REQUEST))

    assert events[1]["candidate"]["product_name"] == "Unverified web result"
    assert events[1]["candidate"]["relationship"] == "unknown"
    assert result == RESULT


@pytest.mark.parametrize(
    "overrides",
    [
        {"product_name": "Merchant nailer deal"},
        {"relationship": "primary_product"},
        {"listing_kind": "purchase"},
    ],
)
def test_stream_product_research_rejects_non_neutral_discovery_candidate(
    overrides,
):
    observed = {
        "type": "candidate_observed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "candidate": discovery_candidate(overrides),
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, observed),
        )

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            list(client.stream_product_research(REQUEST))


@pytest.mark.parametrize(
    "qualifiers",
    [
        ["unknown", "coupon"],
        ["standard", "estimated"],
    ],
)
def test_stream_product_research_rejects_mixed_exclusive_price_terms(
    qualifiers,
):
    observed = {
        "type": "candidate_observed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "candidate": candidate_with_delivery(None, qualifiers),
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, observed),
        )

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            list(client.stream_product_research(REQUEST))


@pytest.mark.parametrize("terminal_type", ["failed", "cancelled"])
def test_stream_product_research_returns_terminal_result(terminal_type):
    result = canonical_terminal_result(terminal_type)
    terminal = {
        "type": terminal_type,
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        **(
            {
                "error_code": "UPSTREAM_UNAVAILABLE",
                "message": "The source was unavailable.",
            }
            if terminal_type == "failed"
            else {"reason_code": "CLIENT_CANCELLED"}
        ),
        "result": result,
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, terminal),
        )

    with make_client(handler) as client:
        events, result = collect(client.stream_product_research(REQUEST))

    assert events[-1]["type"] == terminal_type
    assert result == terminal["result"]


@pytest.mark.parametrize("event_type", ["source_progress", "failed", "cancelled"])
def test_stream_product_research_rejects_empty_progress_reason_fields(
    event_type,
):
    common = {
        "type": event_type,
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
    }
    if event_type == "source_progress":
        event = {
            **common,
            "source_id": "search:fixture",
            "family": "shopping_search",
            "state": "failed",
            "reason_code": "",
        }
    elif event_type == "failed":
        event = {
            **common,
            "error_code": "",
            "message": "",
            "result": canonical_terminal_result("failed"),
        }
    else:
        event = {
            **common,
            "reason_code": "",
            "result": canonical_terminal_result("cancelled"),
        }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, event),
        )

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            list(client.stream_product_research(REQUEST))


@pytest.mark.parametrize(
    "terminal",
    [
        {
            "type": "failed",
            "research_id": RESULT["research_id"],
            "request_digest": RESULT["request_digest"],
            "sequence": 1,
            "observed_at": RESULT["completed_at"],
            "error_code": "UPSTREAM_UNAVAILABLE",
            "message": "The source was unavailable.",
        },
        {
            "type": "failed",
            "research_id": RESULT["research_id"],
            "request_digest": RESULT["request_digest"],
            "sequence": 1,
            "observed_at": RESULT["completed_at"],
            "error_code": "UPSTREAM_UNAVAILABLE",
            "message": "The source was unavailable.",
            "result": RESULT,
        },
        {
            "type": "completed",
            "research_id": RESULT["research_id"],
            "request_digest": RESULT["request_digest"],
            "sequence": 1,
            "observed_at": RESULT["completed_at"],
            "result": canonical_terminal_result("failed"),
        },
        {
            "type": "failed",
            "research_id": RESULT["research_id"],
            "request_digest": RESULT["request_digest"],
            "sequence": 1,
            "observed_at": RESULT["completed_at"],
            "error_code": "UPSTREAM_UNAVAILABLE",
            "message": "The source was unavailable.",
            "result": {
                **canonical_terminal_result("failed"),
                "research_id": "another-research",
            },
        },
        {
            "type": "failed",
            "research_id": RESULT["research_id"],
            "request_digest": RESULT["request_digest"],
            "sequence": 1,
            "observed_at": RESULT["completed_at"],
            "error_code": "UPSTREAM_UNAVAILABLE",
            "message": "The source was unavailable.",
            "result": {
                **canonical_terminal_result("failed"),
                "request_digest": f"sha256:{'f' * 64}",
            },
        },
        {
            "type": "failed",
            "research_id": RESULT["research_id"],
            "request_digest": RESULT["request_digest"],
            "sequence": 1,
            "observed_at": RESULT["completed_at"],
            "error_code": "UPSTREAM_UNAVAILABLE",
            "message": "The source was unavailable.",
            "result": {
                **canonical_terminal_result("failed"),
                "interpretation": {
                    **RESULT["interpretation"],
                    "original_query": "a different product",
                },
            },
        },
        {
            "type": "cancelled",
            "research_id": RESULT["research_id"],
            "request_digest": RESULT["request_digest"],
            "sequence": 1,
            "observed_at": RESULT["completed_at"],
            "reason_code": "CLIENT_CANCELLED",
            "result": {
                **canonical_terminal_result("cancelled"),
                "authority": {
                    "mode": "review_only",
                    "action_authorized": True,
                    "permission": "withheld",
                },
            },
        },
    ],
)
def test_stream_product_research_rejects_invalid_terminal_results(terminal):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED, terminal),
        )

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            list(client.stream_product_research(REQUEST))


def test_stream_product_research_accepts_explicit_bound_replay():
    replay = {
        "type": "replay",
        "sequence": 0,
        "replayed_at": "2026-07-16T12:10:00.000Z",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "authority": {
            "mode": "review_only",
            "action_authorized": False,
            "permission": "withheld",
        },
    }
    completed = {
        "type": "completed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "result": RESULT,
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(replay, completed),
        )

    with make_client(handler) as client:
        events, result = collect(client.stream_product_research(REQUEST))

    assert [event["type"] for event in events] == ["replay", "completed"]
    assert result == RESULT


@pytest.mark.parametrize(
    "events",
    [
        [{**ACCEPTED, "sequence": 1}],
        [{**ACCEPTED, "type": "source_progress"}],
        [
            ACCEPTED,
            {
                "type": "failed",
                "research_id": "another-research",
                "request_digest": RESULT["request_digest"],
                "sequence": 1,
                "observed_at": RESULT["completed_at"],
                "error_code": "UPSTREAM_UNAVAILABLE",
                "message": "failed",
            },
        ],
        [{**ACCEPTED, "observed_at": "not-a-time"}],
    ],
)
def test_stream_product_research_rejects_order_type_binding_and_time(events):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(*events),
        )

    with make_client(handler) as client:
        with pytest.raises(TypeError):
            list(client.stream_product_research(REQUEST))


def test_stream_product_research_rejects_non_ascii_event_id():
    body = (f"event: accepted\nid: ٠\ndata: {json.dumps(ACCEPTED)}\n\n").encode()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=body,
        )

    with make_client(handler) as client:
        with pytest.raises(TypeError, match="event ID"):
            list(client.stream_product_research(REQUEST))


def test_stream_product_research_surfaces_typed_postopen_error():
    body = (
        "event: error\n"
        f"data: {json.dumps({'status': 503, 'error': {'code': 'product_research_unavailable'}})}"
        "\n\n"
    ).encode()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )

    with make_client(handler) as client:
        with pytest.raises(KavalError) as raised:
            list(
                client.stream_product_research(
                    REQUEST,
                    idempotency_key="product-research-stream-error-0001",
                )
            )
    assert raised.value.status_code == 503
    assert raised.value.idempotency_key == "product-research-stream-error-0001"


def test_stream_product_research_pre_cancel_skips_transport():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=product_research_sse(ACCEPTED),
        )

    token = KavalCancellationToken()
    token.cancel("cancelled before stream")
    with make_client(handler) as client:
        stream = client.stream_product_research(
            REQUEST,
            idempotency_key="product-research-stream-pre-cancel-0001",
            cancellation_token=token,
        )
        with pytest.raises(KavalCancelledError) as raised:
            next(stream)

    assert calls == 0
    assert raised.value.idempotency_key == ("product-research-stream-pre-cancel-0001")


def test_stream_product_research_inflight_cancel_closes_body_without_retry():
    body_waiting = Event()
    release_body = Event()
    body_closed = Event()
    calls = 0
    completed = {
        "type": "completed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "result": RESULT,
    }

    class BlockingStream(httpx.SyncByteStream):
        def __iter__(self):
            yield product_research_sse(ACCEPTED)
            body_waiting.set()
            assert release_body.wait(3)
            if not body_closed.is_set():
                yield product_research_sse(completed)

        def close(self):
            body_closed.set()
            release_body.set()

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=BlockingStream(),
        )

    token = KavalCancellationToken()
    with make_client(handler) as client:
        stream = client.stream_product_research(
            REQUEST,
            idempotency_key="product-research-stream-inflight-cancel-0001",
            cancellation_token=token,
        )
        assert next(stream)["type"] == "accepted"
        assert body_waiting.wait(2)
        token.cancel("caller cancelled stream")
        assert body_closed.wait(2)
        with pytest.raises(KavalCancelledError) as raised:
            next(stream)

    assert calls == 1
    assert str(raised.value) == "caller cancelled stream"
    assert raised.value.idempotency_key == (
        "product-research-stream-inflight-cancel-0001"
    )


def test_stream_product_research_cancel_does_not_wait_for_blocking_close():
    body_waiting = Event()
    release_body = Event()
    close_started = Event()
    release_close = Event()
    close_finished = Event()
    frame = product_research_sse(ACCEPTED)

    class BlockingCloseStream(httpx.SyncByteStream):
        def __iter__(self):
            yield frame
            body_waiting.set()
            assert release_body.wait(3)

        def close(self):
            close_started.set()
            assert release_close.wait(3)
            close_finished.set()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=BlockingCloseStream(),
        )

    token = KavalCancellationToken()
    outcome = []
    client = make_client(handler)
    stream = client.stream_product_research(
        REQUEST,
        idempotency_key="product-research-stream-blocking-close-0001",
        cancellation_token=token,
    )
    consumer = None
    try:
        assert next(stream) == ACCEPTED
        assert body_waiting.wait(2)

        def consume_next() -> None:
            try:
                outcome.append(next(stream))
            except BaseException as error:
                outcome.append(error)

        consumer = Thread(target=consume_next)
        consumer.start()
        cancelled_at = monotonic()
        assert token.cancel("caller cancelled stream before blocking cleanup")
        cancel_seconds = monotonic() - cancelled_at
        consumer.join(0.25)

        assert cancel_seconds < 0.25
        assert consumer.is_alive() is False
        assert len(outcome) == 1
        assert isinstance(outcome[0], KavalCancelledError)
        assert outcome[0].idempotency_key == (
            "product-research-stream-blocking-close-0001"
        )
        assert close_started.wait(1)
        assert close_finished.is_set() is False
    finally:
        release_close.set()
        release_body.set()
        assert close_finished.wait(2)
        stream.close()
        client.close()
        if consumer is not None:
            consumer.join(2)


def test_stream_product_research_real_socket_cancel_releases_caller_and_timeout_cleans_worker():
    body_waiting = Event()
    release_body = Event()
    seen_operation_keys = []
    frame = product_research_sse(ACCEPTED)

    class BlockingSseHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            content_length = int(self.headers.get("content-length", "0"))
            self.rfile.read(content_length)
            seen_operation_keys.append(self.headers.get("idempotency-key"))
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            self.wfile.write(f"{len(frame):X}\r\n".encode() + frame + b"\r\n")
            self.wfile.flush()
            body_waiting.set()
            release_body.wait(3)
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

        def log_message(self, _format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), BlockingSseHandler)
    server.daemon_threads = True
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    workers_before = set(enumerate_threads())
    token = KavalCancellationToken()
    client = KavalClient(
        base_url=f"http://127.0.0.1:{server.server_port}",
        timeout=0.75,
    )
    stream = client.stream_product_research(
        REQUEST,
        idempotency_key="product-research-real-socket-cancel-0001",
        cancellation_token=token,
    )
    outcome = []
    consumer_started = Event()
    caller = None
    try:
        assert next(stream) == ACCEPTED
        assert body_waiting.wait(2)
        stream_workers = [
            thread
            for thread in enumerate_threads()
            if thread not in workers_before
            and thread.name == "kaval-cancellable-stream"
        ]
        assert len(stream_workers) == 1

        def consume_next():
            consumer_started.set()
            try:
                outcome.append(next(stream))
            except BaseException as error:
                outcome.append(error)

        caller = Thread(target=consume_next)
        caller.start()
        assert consumer_started.wait(1)
        cancelled_at = monotonic()
        assert token.cancel("caller cancelled real Product Research stream")
        caller.join(0.25)
        caller_release_seconds = monotonic() - cancelled_at

        assert caller.is_alive() is False
        assert caller_release_seconds < 0.25
        assert len(outcome) == 1
        assert isinstance(outcome[0], KavalCancelledError)
        assert str(outcome[0]) == ("caller cancelled real Product Research stream")
        assert outcome[0].idempotency_key == "product-research-real-socket-cancel-0001"
        assert seen_operation_keys == ["product-research-real-socket-cancel-0001"]

        # Public sync-httpx close is best effort across threads. The finite read
        # timeout is the portable backstop for the daemon transport reader.
        stream_workers[0].join(1.5)
        assert stream_workers[0].is_alive() is False
    finally:
        release_body.set()
        stream.close()
        client.close()
        server.shutdown()
        server.server_close()
        server_thread.join(2)
        if caller is not None:
            caller.join(2)


def test_stream_product_research_close_closes_response_body():
    closed = False
    completed = {
        "type": "completed",
        "research_id": RESULT["research_id"],
        "request_digest": RESULT["request_digest"],
        "sequence": 1,
        "observed_at": RESULT["completed_at"],
        "result": RESULT,
    }

    class TrackingStream(httpx.SyncByteStream):
        def __iter__(self):
            yield product_research_sse(ACCEPTED)
            yield product_research_sse(completed)

        def close(self):
            nonlocal closed
            closed = True

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=TrackingStream(),
        )

    with make_client(handler) as client:
        stream = client.stream_product_research(REQUEST)
        assert next(stream)["type"] == "accepted"
        stream.close()

    assert closed is True
