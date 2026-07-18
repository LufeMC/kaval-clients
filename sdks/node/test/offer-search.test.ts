import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Kaval } from "../src/index.js";
import type {
  CommerceActionTimeGateInput,
  CommerceActionTimeGateResult,
  LiveOfferSearchResult,
  OfferSearchInput,
} from "../src/index.js";

const REPRESENTATIVE_WIRE_RESULT = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/offer-search-result-v2.json", import.meta.url),
    "utf8",
  ),
) as unknown;

const REQUEST: OfferSearchInput = {
  schema_revision: 1,
  request_id: "offer-request-1",
  raw_description: "Makita XPH14Z 18V hammer drill, tool only",
  target: {
    schema_revision: 1,
    family: { brand: "Makita", name: "18V LXT hammer drill" },
    name: "Makita XPH14Z",
    identifiers: [{ scheme: "model", value: "XPH14Z" }],
    attributes: [{ key: "kit", value: false }],
  },
  requested_condition: "new",
  destination: { country_code: "US", region: "CA", postal_code: "94107" },
  match_policy: {
    identity_requirement: "shared_identifier",
    required_identifier_schemes: ["model"],
    required_attribute_keys: ["kit"],
    permitted_substitutions: [],
  },
  seller_policy: {
    allowed_seller_ids: [],
    blocked_seller_ids: [],
    allowed_kinds: ["brand_direct", "authorized_retailer"],
    require_authorized: true,
  },
  destination_policy: {
    require_eligible: true,
    require_exact_region: true,
    require_exact_postal_code: true,
  },
  price_policy: {
    currency: "USD",
    require_complete_landed_total: true,
    allow_estimated_components: false,
    allow_member_price: false,
    allow_subscription_price: false,
    allow_coupon_price: false,
    allow_installment_display: false,
    allow_trade_in_price: false,
  },
  source_policy: {
    allowed_source_ids: [],
    blocked_source_ids: [],
    require_origin_evidence: true,
  },
  intended_action: {
    description: "Quote this exact item to a customer",
    materiality: "high",
    reversibility: "partially_reversible",
  },
  freshness_maximum_age_ms: 300_000,
  max_results: 5,
  minimum_unique_sellers: 2,
  deadline_ms: 15_000,
  maximum_cost_micro_usd: 50_000,
  maximum_search_calls: 4,
  maximum_fetches: 12,
};

const REVIEW_RESULT: LiveOfferSearchResult = {
  schema_revision: 2,
  request_id: REQUEST.request_id,
  request_digest: `sha256:${"a".repeat(64)}`,
  status: "complete",
  action: { state: "NEEDS_REVIEW", reason_codes: ["SHADOW_MODE"] },
  stop_reason: "source_exhausted",
  query: "Makita XPH14Z",
  candidates: [],
  source_attempts: [],
  receipt: {
    search_calls: 2,
    fetch_calls: 3,
    providers_configured: 2,
    providers_succeeded: 2,
    cost_micro_usd: 2_500,
    cost_basis: "reserved_ceiling",
    provider_estimated_cost_micro_usd: null,
    provider_estimated_cost_reported_search_calls: 0,
    discovery_cache_hits: 0,
    cost_avoided_micro_usd: 0,
    elapsed_ms: 120,
  },
  started_at: "2026-07-15T00:00:00.000Z",
  completed_at: "2026-07-15T00:00:00.120Z",
  acquisition: {
    coverage_claim: "bounded_not_comprehensive",
    plan_digest: `sha256:${"f".repeat(64)}`,
    plan: {
      schema_revision: 1,
      request_id: REQUEST.request_id,
      request_digest: `sha256:${"a".repeat(64)}`,
      supplier_registry_schema_revision: 1,
      supplier_registry_digest: `sha256:${"e".repeat(64)}`,
      waves: [],
      receipt: {
        schema_revision: 1,
        request_id: REQUEST.request_id,
        coverage_claim: "bounded_not_comprehensive",
        name_only_target: false,
        minimum_independent_families_required: 2,
        planned_independent_families: [],
        planned_independence_groups: [],
        independence_requirement_met: false,
        origin_verification_required: true,
        origin_verification_planned: false,
        origin_verification_source_ids: [],
        eligible_supplier_count_before_budget: 0,
        total_planned_cost_micro_usd: 0,
        total_planned_search_calls: 0,
        total_planned_fetches: 0,
        exclusions: [],
      },
    },
    source_ledger: [
      {
        source_id: "catalog:fixture",
        family: "catalog",
        disposition: "unsearched",
        reason_code: "NO_CONFIGURED_ADAPTER",
      },
    ],
  },
};

const CHECKOUT_CANDIDATE: LiveOfferSearchResult["candidates"][number] = {
  candidate_id: `sha256:${"1".repeat(64)}`,
  origin_url: "https://retailer.example/makita-xph14z",
  source_id: "retailer:fixture",
  discovered_by: ["catalog:fixture"],
  discovery_metadata: [{ provider: "catalog:fixture", title: "Makita XPH14Z" }],
  origin_evidence: {
    kind: "json_ld",
    content_digest: `sha256:${"2".repeat(64)}`,
    source_block_index: 0,
    jsonld_product_index: 0,
    jsonld_offer_index: 0,
  },
  origin_offer: {
    evidence_kind: "json_ld",
    source_block_index: 0,
    jsonld_product_index: 0,
    jsonld_offer_index: 0,
    variant: {
      schema_revision: 1,
      variant_id: "makita-xph14z",
      family: {
        schema_revision: 1,
        family_id: "makita-18v-lxt-hammer-drill",
        brand: "Makita",
        name: "18V LXT hammer drill",
        identifiers: [],
      },
      name: "Makita XPH14Z",
      identifiers: [{ scheme: "model", value: "XPH14Z" }],
      attributes: [{ key: "kit", value: false }],
      pack: { count: 1 },
    },
    title: "Makita XPH14Z",
    purchase_url: "https://retailer.example/makita-xph14z",
    seller_name: "Fixture Retailer",
    condition: "new",
    availability: "in_stock",
    item_price: { amount_minor: 19_999, currency: "USD" },
    destination_eligibility: "unknown",
    landed_price_complete: false,
    extraction_gaps: ["DESTINATION_ELIGIBILITY_UNPROVEN"],
  },
  identity: {
    state: "exact",
    conflict_codes: [],
    matched_identifier_schemes: ["model"],
    matched_attribute_keys: ["kit"],
    applied_substitutions: [],
    explanation: "Exact model and requested kit form matched.",
  },
  disposition: "review",
  gaps: ["COMMERCE_PERMISSION_REVIEW_ONLY"],
  reason_codes: ["COMMERCE_PERMISSION_REVIEW_ONLY"],
  checkout: {
    status: "verified",
    resolver: {
      schema_revision: 1,
      source_id: "checkout:fixture",
      adapter_revision: "checkout-fixture/1",
      execution_mode: "live",
      estimated_cost_micro_usd: 500,
    },
    request_digest: `sha256:${"3".repeat(64)}`,
    observation: {
      destination_eligibility: "eligible",
      availability: "in_stock",
      seller_authorized: true,
      item_price: { amount_minor: 19_999, currency: "USD" },
      shipping_price: { amount_minor: 0, currency: "USD" },
      tax_price: { amount_minor: 1_650, currency: "USD" },
      mandatory_fees: { amount_minor: 0, currency: "USD" },
      declared_landed_total: { amount_minor: 21_649, currency: "USD" },
      quote_id: "checkout-quote-1",
      evidence_digest: `sha256:${"4".repeat(64)}`,
      observed_at: "2026-07-15T00:00:00.000Z",
      expires_at: "2026-07-15T00:05:00.000Z",
    },
    landed_price_validation: {
      state: "complete",
      expected_currency: "USD",
      calculated_landed_total: { amount_minor: 21_649, currency: "USD" },
      reason_codes: [],
    },
    action: {
      state: "REVIEW",
      action_authorized: false,
      reason_codes: ["COMMERCE_PERMISSION_REVIEW_ONLY"],
    },
    actual_cost_micro_usd: 500,
    version_receipt: "checkout-fixture/1:checkout-quote-1",
    operational_error_code: null,
  },
};

const ACTION_BINDING = {
  action_slot_key: "quote:line-item-1",
  action_input_digest: `sha256:${"b".repeat(64)}`,
  action_consequence_digest: `sha256:${"c".repeat(64)}`,
} as const;

const GATE_REQUEST: CommerceActionTimeGateInput = {
  dependency_id: "offer:dependency-1",
  generation_id: "offer:generation-1",
  generation_number: 1,
  generation_digest: `sha256:${"d".repeat(64)}`,
  action_binding: ACTION_BINDING,
};

const GATE_RESULT: CommerceActionTimeGateResult = {
  state: "current_review_only",
  disposition: "REVIEW",
  permission: "withheld",
  reason_codes: ["COMMERCE_PERMISSION_REVIEW_ONLY"],
  checked_at: "2026-07-15T00:00:00.130Z",
  final_fence_checked: true,
  generation_id: GATE_REQUEST.generation_id,
  generation_number: GATE_REQUEST.generation_number,
  generation_digest: GATE_REQUEST.generation_digest,
  expires_at: "2026-07-15T00:05:00.000Z",
};

describe("Offer Search", () => {
  it("POSTs the exact request with caller idempotency and returns review-only research", async () => {
    let seen: { path: string; key: string | null; body: unknown } | undefined;
    const client = new Kaval({
      fetch: (async (input, init) => {
        seen = {
          path: new URL(String(input)).pathname,
          key: new Headers(init?.headers).get("idempotency-key"),
          body: JSON.parse(String(init?.body)),
        };
        return new Response(JSON.stringify(REVIEW_RESULT), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const result = await client.searchOffers(REQUEST, {
      idempotencyKey: "offer-search-operation-0001",
    });

    expect(seen).toEqual({
      path: "/v1/search-offers",
      key: "offer-search-operation-0001",
      body: REQUEST,
    });
    expect(result.action.state).toBe("NEEDS_REVIEW");
    expect(result.receipt.browser_attempt_count).toBeUndefined();
  });

  it("keeps the representative strict wire fixture typed and review-only", async () => {
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(REPRESENTATIVE_WIRE_RESULT), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const result: LiveOfferSearchResult = await client.searchOffers(REQUEST);
    const candidate = result.candidates[0];

    expect(result.effective_request_digest).toBe(`sha256:${"b".repeat(64)}`);
    expect(result.rejected_explanations?.[0]).toMatchObject({
      contender: false,
      disposition: "rejected",
      identity_state: "conflict",
    });
    expect(result.identity_resolution).toMatchObject({
      resolver_version: "catalog-identity/v1",
      resolution_state: "exact_variant",
      exact_identity: true,
    });
    expect(candidate?.origin_evidence).toMatchObject({
      artifact: "rendered_page",
      version_receipt: "browser-renderer/2026-07-16.1",
    });
    expect(candidate?.origin_offer.field_provenance?.[0]).toMatchObject({
      field_path: "variant.identifiers",
      transformations: [
        "trim_text",
        "canonicalize_identifier",
        "construct_product_variant",
      ],
    });
    expect(candidate?.checkout?.observation?.delivery_promise).toEqual({
      certainty: "estimated",
      earliest_at: "2026-07-18T00:00:00.000Z",
      latest_at: "2026-07-20T00:00:00.000Z",
    });
    expect(result.lifecycle).toMatchObject({
      persistence: "not_created",
      action_time_gate: {
        disposition: "REVIEW",
        permission: "withheld",
        final_fence_checked: false,
      },
    });
    expect(result.source_attempts[0]?.browser_attempted).toBe(true);
    expect(result.receipt.browser_attempt_count).toBe(1);
    expect(JSON.stringify(result)).not.toContain("SAFE_TO_QUOTE");
  });

  it("accepts and preserves legacy recordings without browser metrics", async () => {
    const payload = structuredClone(REPRESENTATIVE_WIRE_RESULT) as Record<
      string,
      any
    >;
    delete payload.source_attempts[0].browser_attempted;
    delete payload.receipt.browser_attempt_count;
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.searchOffers(REQUEST)).resolves.toEqual(payload);
  });

  it.each([
    {
      name: "a non-boolean source-attempt flag",
      mutate: (payload: Record<string, any>) => {
        payload.source_attempts[0].browser_attempted = "yes";
      },
    },
    {
      name: "a negative receipt count",
      mutate: (payload: Record<string, any>) => {
        payload.receipt.browser_attempt_count = -1;
      },
    },
    {
      name: "a fractional receipt count",
      mutate: (payload: Record<string, any>) => {
        payload.receipt.browser_attempt_count = 0.5;
      },
    },
    {
      name: "an unsafe receipt count",
      mutate: (payload: Record<string, any>) => {
        payload.receipt.browser_attempt_count = Number.MAX_SAFE_INTEGER + 1;
      },
    },
  ])("rejects $name", async ({ mutate }) => {
    const payload = structuredClone(REPRESENTATIVE_WIRE_RESULT) as Record<
      string,
      any
    >;
    mutate(payload);
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.searchOffers(REQUEST)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("surfaces typed persisted lifecycle metadata without granting permission", async () => {
    const payload: LiveOfferSearchResult = {
      ...REVIEW_RESULT,
      candidates: [CHECKOUT_CANDIDATE],
      lifecycle: {
        persistence: "persisted",
        dependency_id: GATE_REQUEST.dependency_id,
        generation_id: GATE_REQUEST.generation_id,
        generation_number: GATE_REQUEST.generation_number,
        generation_digest: GATE_REQUEST.generation_digest,
        selected_candidate_id: `sha256:${"1".repeat(64)}`,
        expires_at: GATE_RESULT.expires_at!,
        action_binding: ACTION_BINDING,
        action_time_gate: GATE_RESULT,
      },
    };
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const result = await client.searchOffers(REQUEST);

    expect(result.lifecycle?.persistence).toBe("persisted");
    expect(result.lifecycle?.action_time_gate).toMatchObject({
      disposition: "REVIEW",
      permission: "withheld",
    });
  });

  it.each([
    [
      "a selected candidate absent from the final result",
      {
        ...REVIEW_RESULT,
        candidates: [],
      },
    ],
    [
      "a selected candidate repeated in the final result",
      {
        ...REVIEW_RESULT,
        candidates: [CHECKOUT_CANDIDATE, CHECKOUT_CANDIDATE],
      },
    ],
    [
      "an action-time gate bound to another generation",
      {
        ...REVIEW_RESULT,
        candidates: [CHECKOUT_CANDIDATE],
      },
    ],
    [
      "a non-current action-time gate reporting another generation",
      {
        ...REVIEW_RESULT,
        candidates: [CHECKOUT_CANDIDATE],
      },
    ],
    [
      "an unchecked current action-time fence",
      {
        ...REVIEW_RESULT,
        candidates: [CHECKOUT_CANDIDATE],
      },
    ],
  ])("rejects persisted lifecycle metadata with %s", async (label, base) => {
    const mismatchedGate =
      label === "an action-time gate bound to another generation"
        ? { ...GATE_RESULT, generation_id: "offer:generation-other" }
        : label ===
            "a non-current action-time gate reporting another generation"
          ? {
              ...GATE_RESULT,
              state: "stale_generation",
              generation_id: "offer:generation-other",
            }
          : label === "an unchecked current action-time fence"
            ? { ...GATE_RESULT, final_fence_checked: false }
            : GATE_RESULT;
    const payload = {
      ...base,
      lifecycle: {
        persistence: "persisted",
        dependency_id: GATE_REQUEST.dependency_id,
        generation_id: GATE_REQUEST.generation_id,
        generation_number: GATE_REQUEST.generation_number,
        generation_digest: GATE_REQUEST.generation_digest,
        selected_candidate_id: CHECKOUT_CANDIDATE.candidate_id,
        expires_at: GATE_RESULT.expires_at!,
        action_binding: ACTION_BINDING,
        action_time_gate: mismatchedGate,
      },
    };
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.searchOffers(REQUEST)).rejects.toThrow(
      /invalid lifecycle|permission must remain withheld/u,
    );
  });

  it("surfaces typed checkout evidence and the bounded source ledger", async () => {
    const payload: LiveOfferSearchResult = {
      ...REVIEW_RESULT,
      candidates: [CHECKOUT_CANDIDATE],
    };
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const result = await client.searchOffers(REQUEST);

    expect(result.candidates[0]?.checkout).toMatchObject({
      status: "verified",
      action: { state: "REVIEW", action_authorized: false },
      landed_price_validation: {
        calculated_landed_total: { amount_minor: 21_649, currency: "USD" },
      },
    });
    expect(result.acquisition?.source_ledger).toEqual([
      expect.objectContaining({
        source_id: "catalog:fixture",
        disposition: "unsearched",
      }),
    ]);
  });

  it("streams monotonic review-only progress and the canonical final result", async () => {
    const progress = {
      type: "accepted",
      sequence: 0,
      at: "2026-07-15T00:00:00.000Z",
      request_id: REQUEST.request_id,
      message: "Offer Search accepted.",
      authority: "research_only",
      action_state: "REVIEW",
      details: {},
    } as const;
    const acquisition = {
      ...progress,
      type: "acquisition",
      sequence: 1,
      message: "Current sources are being checked.",
      details: { coverage_claim: "bounded_not_comprehensive" },
    } as const;
    const provisional = {
      ...progress,
      type: "candidate_provisional",
      sequence: 2,
      message:
        "An origin-verified research candidate is available provisionally; final publication is pending.",
      details: {
        request_digest: REVIEW_RESULT.request_digest,
        origin_sequence: 4,
        publication_state: "provisional",
        durable: false,
        actionable: false,
        permission: "withheld",
        final_inclusion: "not_yet_determined",
        candidate: CHECKOUT_CANDIDATE,
      },
    } as const;
    const body = [
      `id: 0\nevent: accepted\ndata: ${JSON.stringify(progress)}\n\n`,
      `id: 1\nevent: acquisition\ndata: ${JSON.stringify(acquisition)}\n\n`,
      `id: 2\nevent: candidate_provisional\ndata: ${JSON.stringify(provisional)}\n\n`,
      `id: 3\nevent: final\ndata: ${JSON.stringify(REVIEW_RESULT)}\n\n`,
    ].join("");
    let accept: string | null = null;
    let operationKey: string | null = null;
    const client = new Kaval({
      fetch: (async (_input, init) => {
        const headers = new Headers(init?.headers);
        accept = headers.get("accept");
        operationKey = headers.get("idempotency-key");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }) as typeof fetch,
    });

    const events = [];
    for await (const event of client.streamOfferSearch(REQUEST, {
      idempotencyKey: "offer-search-stream-0001",
    })) {
      events.push(event);
    }

    expect(accept).toBe("text/event-stream");
    expect(operationKey).toBe("offer-search-stream-0001");
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "acquisition",
      "candidate_provisional",
      "final",
    ]);
    expect(events[2]).toMatchObject({
      type: "candidate_provisional",
      details: {
        publication_state: "provisional",
        durable: false,
        actionable: false,
        permission: "withheld",
        final_inclusion: "not_yet_determined",
        candidate: { disposition: "review" },
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "final",
      sequence: 3,
      result: { action: { state: "NEEDS_REVIEW" } },
    });
  });

  it("rejects a provisional candidate whose digest does not bind to the final result", async () => {
    const provisional = {
      type: "candidate_provisional",
      sequence: 0,
      at: "2026-07-15T00:00:00.000Z",
      request_id: REQUEST.request_id,
      message: "Provisional research candidate.",
      authority: "research_only",
      action_state: "REVIEW",
      details: {
        request_digest: `sha256:${"9".repeat(64)}`,
        origin_sequence: 1,
        publication_state: "provisional",
        durable: false,
        actionable: false,
        permission: "withheld",
        final_inclusion: "not_yet_determined",
        candidate: CHECKOUT_CANDIDATE,
      },
    } as const;
    const client = new Kaval({
      fetch: (async () =>
        new Response(
          [
            `id: 0\nevent: candidate_provisional\ndata: ${JSON.stringify(provisional)}\n\n`,
            `id: 1\nevent: final\ndata: ${JSON.stringify(REVIEW_RESULT)}\n\n`,
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        )) as typeof fetch,
    });

    const consume = async () => {
      for await (const _event of client.streamOfferSearch(REQUEST)) {
        // Final binding validation must fail before completion.
      }
    };
    await expect(consume()).rejects.toThrow(
      "stream events are bound to another final result",
    );
  });

  it("retries a pre-stream transport failure once with the same operation key", async () => {
    const keys: Array<string | null> = [];
    let calls = 0;
    const replay = {
      type: "replay",
      sequence: 0,
      replayed_at: "2026-07-15T00:00:01.000Z",
      request_id: REQUEST.request_id,
      request_digest: REVIEW_RESULT.request_digest,
      authority: "research_only",
      action_state: "REVIEW",
    } as const;
    const finalBody = [
      `id: 0\nevent: replay\ndata: ${JSON.stringify(replay)}\n\n`,
      `id: 1\nevent: final\ndata: ${JSON.stringify(REVIEW_RESULT)}\n\n`,
    ].join("");
    const client = new Kaval({
      fetch: (async (_input, init) => {
        calls += 1;
        keys.push(new Headers(init?.headers).get("idempotency-key"));
        if (calls === 1)
          throw new TypeError("connection reset before response");
        return new Response(finalBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });

    const events = [];
    for await (const event of client.streamOfferSearch(REQUEST, {
      idempotencyKey: "offer-search-stream-replay-0001",
    })) {
      events.push(event);
    }

    expect(calls).toBe(2);
    expect(keys).toEqual([
      "offer-search-stream-replay-0001",
      "offer-search-stream-replay-0001",
    ]);
    expect(events.map((event) => event.type)).toEqual(["replay", "final"]);
    expect(events[1]).toMatchObject({ type: "final", sequence: 1 });
  });

  it("rejects authority-bearing stream progress before exposing it", async () => {
    const unsafe = {
      type: "candidate",
      sequence: 0,
      at: "2026-07-15T00:00:00.000Z",
      request_id: REQUEST.request_id,
      message: "Unsafe drift.",
      authority: "research_only",
      action_state: "REVIEW",
      details: { decision: "ALLOW" },
    };
    const client = new Kaval({
      fetch: (async () =>
        new Response(
          `id: 0\nevent: candidate\ndata: ${JSON.stringify(unsafe)}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        )) as typeof fetch,
    });

    const consume = async () => {
      for await (const _event of client.streamOfferSearch(REQUEST)) {
        // The first event must fail validation before this body runs.
      }
    };
    await expect(consume()).rejects.toThrow("authority-bearing progress event");
  });

  it("rejects a final stream payload bound to another request", async () => {
    const client = new Kaval({
      fetch: (async () =>
        new Response(
          `id: 0\nevent: final\ndata: ${JSON.stringify({
            ...REVIEW_RESULT,
            request_id: "another-request",
          })}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        )) as typeof fetch,
    });

    const consume = async () => {
      for await (const _event of client.streamOfferSearch(REQUEST)) {
        // The final event must fail the request-binding fence before this body runs.
      }
    };
    await expect(consume()).rejects.toThrow("bound to another request");
  });

  it.each([
    [
      "missing request digest",
      (() => {
        const payload = { ...REVIEW_RESULT } as Record<string, unknown>;
        delete payload.request_digest;
        return payload;
      })(),
    ],
    [
      "malformed request digest",
      { ...REVIEW_RESULT, request_digest: "sha256:not-a-digest" },
    ],
    [
      "mismatched request ID",
      { ...REVIEW_RESULT, request_id: "another-request" },
    ],
  ])("rejects a JSON result with %s", async (_label, payload) => {
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.searchOffers(REQUEST)).rejects.toThrow(
      /request ID|digest|another request/u,
    );
  });

  it.each([
    [
      "missing digest",
      (() => {
        const replay: Record<string, unknown> = {
          type: "replay",
          sequence: 0,
          replayed_at: "2026-07-15T00:00:01.000Z",
          request_id: REQUEST.request_id,
          authority: "research_only",
          action_state: "REVIEW",
        };
        return replay;
      })(),
    ],
    [
      "malformed digest",
      {
        type: "replay",
        sequence: 0,
        replayed_at: "2026-07-15T00:00:01.000Z",
        request_id: REQUEST.request_id,
        request_digest: "sha256:not-a-digest",
        authority: "research_only",
        action_state: "REVIEW",
      },
    ],
    [
      "mismatched request ID",
      {
        type: "replay",
        sequence: 0,
        replayed_at: "2026-07-15T00:00:01.000Z",
        request_id: "another-request",
        request_digest: REVIEW_RESULT.request_digest,
        authority: "research_only",
        action_state: "REVIEW",
      },
    ],
  ])("rejects a replay event with %s", async (_label, replay) => {
    const client = new Kaval({
      fetch: (async () =>
        new Response(
          `id: 0\nevent: replay\ndata: ${JSON.stringify(replay)}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        )) as typeof fetch,
    });
    const consume = async () => {
      for await (const _event of client.streamOfferSearch(REQUEST)) {
        // Invalid replay binding must fail before exposure.
      }
    };

    await expect(consume()).rejects.toThrow("replay event");
  });

  it("rejects a replay digest that does not bind to the final result", async () => {
    const replay = {
      type: "replay",
      sequence: 0,
      replayed_at: "2026-07-15T00:00:01.000Z",
      request_id: REQUEST.request_id,
      request_digest: `sha256:${"9".repeat(64)}`,
      authority: "research_only",
      action_state: "REVIEW",
    };
    const client = new Kaval({
      fetch: (async () =>
        new Response(
          [
            `id: 0\nevent: replay\ndata: ${JSON.stringify(replay)}\n\n`,
            `id: 1\nevent: final\ndata: ${JSON.stringify(REVIEW_RESULT)}\n\n`,
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        )) as typeof fetch,
    });
    const consume = async () => {
      for await (const _event of client.streamOfferSearch(REQUEST)) {
        // Final digest consistency must fail before completion.
      }
    };

    await expect(consume()).rejects.toThrow(
      "stream events are bound to another final result",
    );
  });

  it("cancels the response body when a caller stops consuming progress", async () => {
    let cancelled = false;
    const accepted = {
      type: "accepted",
      sequence: 0,
      at: "2026-07-15T00:00:00.000Z",
      request_id: REQUEST.request_id,
      message: "Offer Search accepted.",
      authority: "research_only",
      action_state: "REVIEW",
      details: {},
    } as const;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `id: 0\nevent: accepted\ndata: ${JSON.stringify(accepted)}\n\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new Kaval({
      timeoutMs: null,
      fetch: (async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    });

    for await (const event of client.streamOfferSearch(REQUEST)) {
      expect(event.type).toBe("accepted");
      break;
    }

    expect(cancelled).toBe(true);
  });

  it("surfaces a typed not-created lifecycle as a review-only absence", async () => {
    const payload: LiveOfferSearchResult = {
      ...REVIEW_RESULT,
      lifecycle: {
        persistence: "not_created",
        reason_codes: ["NO_QUALIFIED_CHECKOUT_EVIDENCE"],
        action_time_gate: {
          state: "not_found",
          disposition: "REVIEW",
          permission: "withheld",
          reason_codes: ["COMMERCE_GENERATION_NOT_CREATED"],
          checked_at: "2026-07-15T00:00:00.130Z",
          final_fence_checked: false,
        },
      },
    };
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const result = await client.searchOffers(REQUEST);

    expect(result.lifecycle).toMatchObject({
      persistence: "not_created",
      action_time_gate: { state: "not_found", permission: "withheld" },
    });
  });

  it("POSTs the exact action-time gate request without caller-selected tenant or authority", async () => {
    let seen: { path: string; key: string | null; body: unknown } | undefined;
    const client = new Kaval({
      fetch: (async (input, init) => {
        seen = {
          path: new URL(String(input)).pathname,
          key: new Headers(init?.headers).get("idempotency-key"),
          body: JSON.parse(String(init?.body)),
        };
        return new Response(JSON.stringify(GATE_RESULT), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const result = await client.gateOfferSearch(GATE_REQUEST);

    expect(seen).toEqual({
      path: "/v1/search-offers/gate",
      key: null,
      body: GATE_REQUEST,
    });
    expect(result).toMatchObject({
      state: "current_review_only",
      disposition: "REVIEW",
      permission: "withheld",
      final_fence_checked: true,
    });
  });

  it.each([
    { ...GATE_RESULT, disposition: "ALLOW" },
    { ...GATE_RESULT, permission: "granted" },
    { ...GATE_RESULT, decision: "BLOCK" },
    { ...GATE_RESULT, nested: { safe_to_quote: true } },
    { ...GATE_RESULT, nested: { permission: "granted" } },
    { ...GATE_RESULT, final_fence_checked: false },
    { ...GATE_RESULT, generation_id: "offer:generation-other" },
    { ...GATE_RESULT, generation_number: 2 },
    { ...GATE_RESULT, generation_digest: `sha256:${"e".repeat(64)}` },
  ])(
    "rejects authority drift in an action-time gate response",
    async (payload) => {
      const client = new Kaval({
        fetch: (async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      });

      await expect(client.gateOfferSearch(GATE_REQUEST)).rejects.toThrow(
        "commerce permission must remain withheld",
      );
    },
  );

  it.each([
    { ...REVIEW_RESULT, decision: "ALLOW" },
    { ...REVIEW_RESULT, action: { state: "SAFE_TO_QUOTE", reason_codes: [] } },
    {
      ...REVIEW_RESULT,
      candidates: [{ disposition: "eligible", safe_to_quote: true }],
    },
  ])(
    "rejects a drifted response that could be mistaken for permission",
    async (payload) => {
      const client = new Kaval({
        fetch: (async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      });

      await expect(client.searchOffers(REQUEST)).rejects.toThrow(
        "shadow results cannot authorize an action",
      );
    },
  );

  it("propagates cancellation without retry and preserves the operation key", async () => {
    let calls = 0;
    const client = new Kaval({
      timeoutMs: null,
      fetch: (async (_input, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () =>
            reject(signal?.reason ?? new Error("cancelled"));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const pending = client.searchOffers(REQUEST, {
      signal: controller.signal,
      idempotencyKey: "cancel-offer-search-0001",
    });
    controller.abort(new Error("caller cancelled"));

    await expect(pending).rejects.toMatchObject({
      message: "caller cancelled",
      idempotencyKey: "cancel-offer-search-0001",
    });
    expect(calls).toBe(1);
  });
});
