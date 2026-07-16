/** A fake `/v1/*` fetch that always rejects with the given product-API error envelope, so MCP tests can
 *  exercise the out-of-credit (402) / invalid-key (401) paths without the network or the engine. */
export function failingKavalFetch(
  status: number,
  code: string,
  message?: string,
): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({ error: { code, ...(message ? { message } : {}) } }),
      { status, headers: { "content-type": "application/json" } },
    );
}

export const fakeOfferSearchRequest = {
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

export const fakeOfferSearchResult = {
  schema_revision: 2,
  request_id: "offer-request-1",
  request_digest: `sha256:${"a".repeat(64)}`,
  status: "complete",
  action: { state: "NEEDS_REVIEW", reason_codes: ["SHADOW_MODE"] },
  stop_reason: "source_exhausted",
  query: "Makita XPH14Z",
  candidates: [
    {
      candidate_id: `sha256:${"1".repeat(64)}`,
      origin_url: "https://retailer.test/makita-xph14z",
      source_id: "catalog-primary",
      discovered_by: ["catalog-primary"],
      discovery_metadata: [
        { provider: "catalog-primary", title: "Makita XPH14Z" },
      ],
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
        purchase_url: "https://retailer.test/makita-xph14z",
        seller_name: "Authorized Retailer",
        condition: "new",
        availability: "in_stock",
        item_price: { amount_minor: 18_999, currency: "USD" },
        destination_eligibility: "unknown",
        landed_price_complete: false,
        extraction_gaps: ["checkout_required"],
      },
      identity: {
        state: "exact",
        conflict_codes: [],
        matched_identifier_schemes: ["model"],
        matched_attribute_keys: ["kit"],
        applied_substitutions: [],
        explanation: "The origin identifier and requested attributes match.",
      },
      disposition: "review",
      gaps: [],
      reason_codes: ["SHADOW_MODE"],
      checkout: {
        status: "verified",
        resolver: {
          schema_revision: 1,
          source_id: "retailer-checkout",
          adapter_revision: "checkout/2026-07-15.1",
          execution_mode: "live",
          estimated_cost_micro_usd: 700,
        },
        request_digest: `sha256:${"3".repeat(64)}`,
        observation: {
          destination_eligibility: "eligible",
          availability: "in_stock",
          seller_authorized: true,
          item_price: { amount_minor: 18_999, currency: "USD" },
          shipping_price: { amount_minor: 0, currency: "USD" },
          tax_price: { amount_minor: 1_567, currency: "USD" },
          mandatory_fees: { amount_minor: 0, currency: "USD" },
          declared_landed_total: { amount_minor: 20_566, currency: "USD" },
          quote_id: "checkout-quote-1",
          evidence_digest: `sha256:${"4".repeat(64)}`,
          observed_at: "2026-07-15T00:00:00.050Z",
          expires_at: "2026-07-15T00:05:00.050Z",
        },
        landed_price_validation: {
          state: "complete",
          expected_currency: "USD",
          calculated_landed_total: { amount_minor: 20_566, currency: "USD" },
          reason_codes: [],
        },
        action: {
          state: "REVIEW",
          action_authorized: false,
          reason_codes: ["COMMERCE_PERMISSION_REVIEW_ONLY"],
        },
        actual_cost_micro_usd: 650,
        version_receipt: "checkout/2026-07-15.1",
        operational_error_code: null,
      },
    },
  ],
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
    plan: {
      schema_revision: 1,
      request_id: "offer-request-1",
      request_digest: `sha256:${"a".repeat(64)}`,
      supplier_registry_schema_revision: 1,
      supplier_registry_digest: `sha256:${"5".repeat(64)}`,
      waves: [],
      receipt: {
        schema_revision: 1,
        request_id: "offer-request-1",
        coverage_claim: "bounded_not_comprehensive",
        name_only_target: false,
        minimum_independent_families_required: 2,
        planned_independent_families: ["catalog", "open_web"],
        planned_independence_groups: ["catalog-primary", "open-web-tail"],
        independence_requirement_met: true,
        origin_verification_required: true,
        origin_verification_planned: true,
        origin_verification_source_ids: ["retailer-origin"],
        eligible_supplier_count_before_budget: 3,
        total_planned_cost_micro_usd: 3_500,
        total_planned_search_calls: 2,
        total_planned_fetches: 3,
        exclusions: [],
      },
    },
    plan_digest: `sha256:${"6".repeat(64)}`,
    source_ledger: [
      {
        source_id: "catalog-primary",
        family: "catalog",
        disposition: "succeeded",
        reason_code: "COMPLETED",
      },
      {
        source_id: "open-web-tail",
        family: "open_web",
        disposition: "unsearched",
        reason_code: "COVERAGE_SATISFIED",
      },
    ],
  },
};

export const fakeOfferSearchGateRequest = {
  dependency_id: "offer:dependency-1",
  generation_id: "offer:generation-1",
  generation_number: 1,
  generation_digest: `sha256:${"d".repeat(64)}`,
  action_binding: {
    action_slot_key: "quote:line-item-1",
    action_input_digest: `sha256:${"b".repeat(64)}`,
    action_consequence_digest: `sha256:${"c".repeat(64)}`,
  },
};

export const fakeOfferSearchGateResult = {
  state: "current_review_only",
  disposition: "REVIEW",
  permission: "withheld",
  reason_codes: ["COMMERCE_PERMISSION_REVIEW_ONLY"],
  checked_at: "2026-07-15T00:00:00.130Z",
  final_fence_checked: true,
  generation_id: fakeOfferSearchGateRequest.generation_id,
  generation_number: fakeOfferSearchGateRequest.generation_number,
  generation_digest: fakeOfferSearchGateRequest.generation_digest,
  expires_at: "2026-07-15T00:05:00.000Z",
};

/** Canned `/v1/*` responses for MCP conformance without network or the private engine. */
export const fakeKavalFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const path = new URL(url).pathname;
  const body = init?.body
    ? (JSON.parse(init.body as string) as Record<string, unknown>)
    : {};

  // MCP inherits the Node HTTP client. Keep the fake hosted contract strict so conformance fails if
  // a billable tool ever stops sending the operation key required by issued-key traffic.
  if (
    path !== "/v1/report-outcome" &&
    path !== "/v1/search-offers/gate" &&
    !new Headers(init?.headers).get("idempotency-key")
  ) {
    return new Response(
      JSON.stringify({ error: { code: "idempotency_key_required" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  let data: unknown;
  switch (path) {
    case "/v1/search-offers":
      data = fakeOfferSearchResult;
      break;
    case "/v1/search-offers/gate":
      data = fakeOfferSearchGateResult;
      break;
    case "/v1/check":
      data = {
        id: "chk_1",
        status: "current",
        confidence: 0.9,
        reason: "team page confirms it",
        checked_at: "2026-06-24T18:04:11.000Z",
        evidence: [],
      };
      break;
    case "/v1/verify": {
      const tier = (body.mode as string) ?? "auto";
      data = {
        id: "vf_1",
        status: "current",
        act: true,
        confidence: 0.9,
        reason: "team page confirms it",
        checked_at: "2026-06-24T18:04:11.000Z",
        evidence: [],
        tier,
        ...(tier === "deep"
          ? {
              explanation: {
                content: "Confirmed by the team page [1].",
                citations: [{ url: "https://acme.com/team" }],
                confidence: "high",
              },
            }
          : {}),
      };
      break;
    }
    case "/v1/extract-and-check":
      data = {
        beliefs: [
          {
            belief: "Jane Doe is at Acme",
            id: "b1",
            status: "current",
            confidence: 0.9,
          },
          {
            belief: "Acme has SOC 2",
            id: "b2",
            status: "current",
            confidence: 0.9,
          },
        ],
      };
      break;
    case "/v1/audit":
      data = {
        proof_id: "proof_1",
        action_decision: { decision: "REVIEW" },
      };
      break;
    case "/v1/gate":
      data = {
        proofId: "proof_1",
        state: "current",
        decision: { decision: "ALLOW" },
        billingClass: "action_gate",
        proofReused: true,
        researchPerformed: false,
        latencyMs: 3,
        enforcement: {
          mode: "bounded",
          controlApplied: true,
          executionAllowed: true,
          wouldAllow: true,
          reason: "inside boundary",
        },
      };
      break;
    default:
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
      });
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export function parseToolText(res: unknown): {
  status?: string | number;
  state?: string;
  disposition?: string;
  permission?: string;
  reason_codes?: string[];
  final_fence_checked?: boolean;
  id?: string;
  proof_id?: string;
  proofId?: string;
  action_decision?: { decision?: string };
  action?: { state?: string; reason_codes?: string[] };
  candidates?: Array<{
    disposition?: string;
    safe_to_quote?: boolean;
    checkout?: {
      status?: string;
      observation?: {
        destination_eligibility?: string;
        declared_landed_total?: { amount_minor?: number; currency?: string };
      };
      action?: { state?: string; action_authorized?: boolean };
    };
  }>;
  acquisition?: {
    coverage_claim?: string;
    source_ledger?: Array<{
      source_id?: string;
      family?: string;
      disposition?: string;
    }>;
  };
  decision?: { decision?: string };
  enforcement?: { mode?: string; executionAllowed?: boolean | null };
  beliefs?: unknown[];
  tier?: string;
  explanation?: { confidence?: string; citations?: { url: string }[] };
  error?: string;
  message?: string;
  idempotency_key?: string;
} {
  const content = (res as { content: Array<{ type: string; text: string }> })
    .content;
  return JSON.parse(content[0]!.text);
}
