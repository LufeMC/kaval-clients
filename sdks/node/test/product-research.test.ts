import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Kaval,
  KavalError,
  type NormalizedProductResearchCandidate,
  type ProductResearchDeliveryEvidence,
  type ProductResearchInput,
  type ProductResearchListingKind,
  type ProductResearchPrice,
  type ProductResearchResult,
  type ProductResearchStreamEvent,
} from "../src/index.js";

const RESULT = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/product-research-result-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ProductResearchResult;

const DELIVERY = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/product-research-delivery-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ProductResearchDeliveryEvidence;

const REQUEST: ProductResearchInput = {
  query: "cordless framing nailer",
  market: { country_code: "US", preferred_currency: "USD" },
  filters: {
    condition: "new",
    merchant_policy: {
      allowed_domains: [],
      blocked_domains: [],
      marketplace_policy: "exclude",
    },
  },
};

const accepted = {
  type: "accepted",
  research_id: RESULT.research_id,
  request_digest: RESULT.request_digest,
  sequence: 0,
  observed_at: RESULT.started_at,
  query: REQUEST.query,
} as const;

function canonicalTerminalResult(
  operationalState: "failed" | "cancelled",
): ProductResearchResult {
  const result = structuredClone(RESULT);
  result.operational_state = operationalState;
  result.research_state = "not_completed";
  result.coverage.stop_reason =
    operationalState === "failed" ? "upstream_unavailable" : "cancelled";
  return result;
}

function resultWithDiscovery(
  overrides: Record<string, unknown> = {},
): ProductResearchResult {
  const result = structuredClone(RESULT);
  result.unverified_discoveries = [
    {
      discovery_id: `sha256:${"d".repeat(64)}`,
      title: "Unverified web result",
      origin_url: "https://merchant.example/products/accessory-1",
      merchant_domain: "merchant.example",
      listing_kind: "unknown",
      relationship: "unknown",
      discovered_price: null,
      observed_at: result.completed_at,
      discovered_by: ["search:fixture"],
      verification_tier: "discovered_unverified",
      possible_group_id: null,
      warning_codes: ["DISCOVERY_NOT_ORIGIN_VERIFIED"],
      ...overrides,
    } as ProductResearchResult["unverified_discoveries"][number],
  ];
  result.coverage.unverified_discovery_count = 1;
  return result;
}

function resultWithBlockedSource(): ProductResearchResult {
  const result = structuredClone(RESULT);
  result.coverage.source_ledger.push({
    source_id: "search:blocked-by-policy",
    family: "shopping_search",
    origin_domain: null,
    disposition: "blocked",
    reason_code: "RIGHTS_BLOCKED",
    reason_codes: ["RIGHTS_BLOCKED"],
    calls: 0,
    outcome_counts: {
      succeeded: 0,
      empty: 0,
      failed: 0,
      blocked: 1,
      cancelled: 0,
      deferred: 0,
      unsearched: 0,
    },
    candidates_discovered: 0,
    verified_offers: 0,
    cost_micro_usd: 0,
    avoided_cost_micro_usd: 0,
  });
  return result;
}

function resultWithSafetyBlockedSource(calls: number): ProductResearchResult {
  const result = structuredClone(RESULT);
  result.coverage.source_ledger.push({
    source_id: "origin:unsafe-host",
    family: "retailer_origin",
    origin_domain: "unsafe-host.example",
    disposition: "blocked",
    reason_code: "ORIGIN_BLOCKED",
    reason_codes: ["ORIGIN_BLOCKED"],
    calls,
    outcome_counts: {
      succeeded: 0,
      empty: 0,
      failed: 0,
      blocked: 1,
      cancelled: 0,
      deferred: 0,
      unsearched: 0,
    },
    candidates_discovered: 0,
    verified_offers: 0,
    cost_micro_usd: 0,
    avoided_cost_micro_usd: 0,
  });
  result.coverage.execution_receipt.fetch_calls += calls;
  result.coverage.execution_receipt.providers_configured += 1;
  result.coverage.source_families_attempted.push("retailer_origin");
  result.coverage.merchant_origins_attempted += 1;
  return result;
}

const MATERIAL_CANDIDATE_FIELDS = [
  ["title", "publish_title"],
  ["origin_url", "publish_origin_url"],
  ["merchant_origin", "derive_merchant_origin"],
  ["listing_kind", "classify_listing_kind"],
  ["seller_name", "publish_seller_name"],
  ["relationship", "classify_relationship"],
  ["condition", "publish_condition"],
  ["pack", "publish_pack"],
  ["availability", "publish_availability"],
  ["product_identity", "publish_identity"],
  ["item_price", "publish_item_price"],
  ["price_basis", "derive_price_basis"],
  ["price_qualifiers", "derive_price_qualifiers"],
] as const;

function originFieldEvidence(
  originUrl: string,
  observedAt: string,
): NormalizedProductResearchCandidate["field_evidence"] {
  return MATERIAL_CANDIDATE_FIELDS.map(([field, derivation], index) => {
    const digest =
      `sha256:${(index + 1).toString(16).padStart(64, "0")}` as const;
    return {
      field,
      verification_tier: "origin_verified",
      source_id: "origin:merchant.example",
      source_url: originUrl,
      observed_at: observedAt,
      evidence_digest: digest,
      version_receipt: null,
      evidence_binding: {
        kind: "origin",
        receipt: {
          artifact: "static_http_body",
          structure: "json_ld",
          source_block_index: 0,
          product_index: 0,
          offer_index: 0,
          content_digest: digest,
          version_receipt: null,
        },
        locators: [
          {
            field_path: field,
            source_values: [
              {
                object_role:
                  field === "origin_url" || field === "merchant_origin"
                    ? "artifact_origin"
                    : "product",
                path:
                  field === "origin_url" || field === "merchant_origin"
                    ? "$origin_url"
                    : `/${field.replaceAll(".", "/")}`,
                raw_value_digest: digest,
              },
            ],
            transformations: ["trim_text"],
            observed_value_digest: digest,
          },
        ],
      },
      derivations: [derivation],
    };
  });
}

function candidateWithDelivery(
  delivery: ProductResearchDeliveryEvidence | null,
  qualifiers: ProductResearchPrice["qualifiers"] = ["standard"],
  basis: ProductResearchPrice["basis"] = { kind: "per_orderable_item" },
): NormalizedProductResearchCandidate & {
  listing_kind: ProductResearchListingKind;
} {
  const originUrl = "https://merchant.example/products/framing-nailer";
  return {
    candidate_id: `sha256:${"e".repeat(64)}`,
    candidate_state: "offer",
    product_name: "Cordless framing nailer",
    identifiers: [
      { scheme: "mpn", value: "NAILER-1", issuer: "Fixture Tools" },
    ],
    attributes: [],
    pack: { count: 1 },
    condition: "new",
    listing_kind: "purchase",
    relationship: "primary_product",
    price: {
      amount: { amount_minor: 19_900, currency: "USD" },
      basis,
      qualifiers,
      shipping_included: null,
      tax_included: null,
    },
    delivery,
    availability: "in_stock",
    merchant: {
      display_name: "Merchant",
      origin_domain: "merchant.example",
    },
    origin_url: originUrl,
    observed_at: RESULT.completed_at,
    expires_at: delivery?.expires_at ?? RESULT.expires_at,
    verification_tier: "origin_verified",
    field_evidence: originFieldEvidence(originUrl, RESULT.completed_at),
    identity_evidence: {
      basis: "hard_identifier",
      identifier: { scheme: "mpn", value: "NAILER-1", issuer: "Fixture Tools" },
    },
    conflict_codes: [],
    discovered_by: ["search:fixture"],
  };
}

function discoveryCandidate(
  overrides: Record<string, unknown> = {},
): NormalizedProductResearchCandidate {
  return {
    ...candidateWithDelivery(null),
    candidate_state: "discovery",
    product_name: "Unverified web result",
    identifiers: [],
    pack: null,
    condition: "unknown",
    listing_kind: "unknown",
    relationship: "unknown",
    price: null,
    availability: "unknown",
    verification_tier: "discovered_unverified",
    field_evidence: [],
    identity_evidence: { basis: "descriptive" },
    ...overrides,
  } as NormalizedProductResearchCandidate;
}

function resultWithOffer(
  delivery: ProductResearchDeliveryEvidence | null,
  qualifiers: ProductResearchPrice["qualifiers"] = ["standard"],
  basis: ProductResearchPrice["basis"] = { kind: "per_orderable_item" },
): ProductResearchResult {
  const result = structuredClone(RESULT);
  const candidate = candidateWithDelivery(delivery, qualifiers, basis);
  result.research_state = "offers_found";
  result.groups = [
    {
      group_id: `sha256:${"2".repeat(64)}`,
      rank: 1,
      match_status: "possible",
      identity_basis: "descriptive",
      identity_receipt_digest: null,
      product_name: candidate.product_name,
      identifiers: candidate.identifiers,
      attributes: candidate.attributes,
      pack: candidate.pack,
      condition: candidate.condition,
      listing_kind: candidate.listing_kind,
      relationship: candidate.relationship,
      offers: [
        {
          offer_id: candidate.candidate_id,
          rank: 1,
          match_status: "possible",
          title: candidate.product_name,
          origin_url: candidate.origin_url,
          merchant: candidate.merchant,
          listing_kind: candidate.listing_kind,
          relationship: candidate.relationship,
          condition: candidate.condition,
          pack: candidate.pack,
          price: candidate.price,
          delivery: candidate.delivery,
          availability: candidate.availability,
          verification_tier: "origin_verified",
          observed_at: candidate.observed_at,
          expires_at: candidate.expires_at,
          field_evidence: candidate.field_evidence,
          comparison_key: null,
          price_label: null,
          warning_codes: [],
        },
      ],
      conflict_codes: [],
      refinement_codes: ["EXACT_IDENTITY_REFINEMENT_REQUIRED"],
    },
  ];
  result.coverage.verified_offer_count = 1;
  result.coverage.product_group_count = 1;
  result.coverage.execution_receipt.first_useful_candidate_ms = 1_000;
  result.expires_at = candidate.expires_at;
  return result;
}

function eventFrame(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\nid: ${String(event.sequence)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamResponse(...events: Record<string, unknown>[]): Response {
  return new Response(events.map(eventFrame).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

async function drain(
  stream: AsyncGenerator<
    ProductResearchStreamEvent,
    ProductResearchResult,
    void
  >,
): Promise<{
  events: ProductResearchStreamEvent[];
  result: ProductResearchResult;
}> {
  const events: ProductResearchStreamEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

describe("Product Research", () => {
  it("posts the product-only request with one caller operation key", async () => {
    let seen: { path: string; key: string | null; body: unknown } | undefined;
    const client = new Kaval({
      fetch: (async (input, init) => {
        seen = {
          path: new URL(String(input)).pathname,
          key: new Headers(init?.headers).get("idempotency-key"),
          body: JSON.parse(String(init?.body)),
        };
        return new Response(JSON.stringify(RESULT), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await expect(
      client.researchProducts(REQUEST, {
        idempotencyKey: "product-research-operation-0001",
      }),
    ).resolves.toEqual(RESULT);
    expect(seen).toEqual({
      path: "/v1/product-research",
      key: "product-research-operation-0001",
      body: REQUEST,
    });
    expect(seen?.body).not.toHaveProperty("limits");
    expect(RESULT.coverage.execution_receipt.browser_attempt_count).toBe(0);
  });

  it("accepts the canonical neutral discovery fixture and performance-rating clues", async () => {
    const payload = structuredClone(RESULT);
    payload.interpretation.clues.push({
      clue_id: "clue:performance_rating:0:8",
      kind: "performance_rating",
      value: "cordless",
      normalized_value: "cordless",
      authority: "retrieval_only",
      provenance: {
        source: "query_text",
        field: "query",
        span: {
          encoding: "utf16_code_unit",
          start: 0,
          end: 8,
          text: "cordless",
        },
      },
    });
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).resolves.toEqual(payload);
    expect(payload.unverified_discoveries[0]).toMatchObject({
      title: "Unverified web result",
      listing_kind: "unknown",
      relationship: "unknown",
    });
  });

  it("accepts and preserves a legacy receipt without browser metrics", async () => {
    const payload = structuredClone(RESULT);
    delete payload.coverage.execution_receipt.browser_attempt_count;
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).resolves.toEqual(payload);
  });

  it.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["greater than fetch_calls", 1],
  ])("rejects a %s browser attempt count", async (_name, count) => {
    const payload = structuredClone(RESULT);
    payload.coverage.execution_receipt.browser_attempt_count = count;
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("preserves canonical failed JSON results instead of converting them to errors", async () => {
    const failed = structuredClone(RESULT);
    failed.operational_state = "failed";
    failed.research_state = "not_completed";
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(failed), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).resolves.toEqual(failed);
  });

  it("preserves the neutral final unverified-discovery provenance", async () => {
    const payload = resultWithDiscovery();
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).resolves.toEqual(payload);
  });

  it.each([
    {
      name: "seller-derived title",
      overrides: { title: "Compatible framing nailer accessory" },
    },
    {
      name: "inferred relationship",
      overrides: { relationship: "accessory" },
    },
    {
      name: "secret-bearing origin URL",
      overrides: {
        origin_url: "https://merchant.example/products/accessory-1#sig=secret",
      },
    },
    {
      name: "foreign merchant hostname",
      overrides: { merchant_domain: "other.example" },
    },
  ])(
    "rejects a final unverified discovery with $name",
    async ({ overrides }) => {
      const payload = resultWithDiscovery(overrides);
      const client = new Kaval({
        fetch: (async () =>
          new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      });

      await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
        TypeError,
      );
    },
  );

  it("preserves a policy-blocked source without inventing a call", async () => {
    const payload = resultWithBlockedSource();
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).resolves.toEqual(payload);
  });

  it("preserves a safety-blocked source that crossed the call boundary", async () => {
    const payload = resultWithSafetyBlockedSource(1);
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).resolves.toEqual(payload);
  });

  it("rejects blocked-source call counts beyond blocked outcomes", async () => {
    const payload = resultWithSafetyBlockedSource(2);
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it.each([
    ["destination-bound evidence", DELIVERY],
    ["an explicit product-only null", null],
  ] as const)("preserves %s on verified offers", async (_name, delivery) => {
    const payload = resultWithOffer(delivery);
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).resolves.toEqual(payload);
  });

  it.each([
    [
      "unknown pack",
      (offer: Record<string, unknown>): void => {
        offer.pack = null;
      },
    ],
    [
      "unknown condition",
      (offer: Record<string, unknown>): void => {
        offer.condition = "unknown";
      },
    ],
  ] as const)(
    "accepts an offer with %s under a compatible known group value",
    async (_name, mutate) => {
      const payload = resultWithOffer(null);
      mutate(
        payload.groups[0]!.offers[0]! as unknown as Record<string, unknown>,
      );
      const client = new Kaval({
        fetch: (async () =>
          new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      });

      await expect(client.researchProducts(REQUEST)).resolves.toEqual(payload);
    },
  );

  it.each([
    [
      "empty material evidence",
      (offer: Record<string, unknown>) => (offer.field_evidence = []),
    ],
    [
      "missing price-basis evidence",
      (offer: Record<string, unknown>) => {
        offer.field_evidence = (
          offer.field_evidence as Array<Record<string, unknown>>
        ).filter(({ field }) => field !== "price_basis");
      },
    ],
    [
      "foreign evidence URL",
      (offer: Record<string, unknown>) => {
        (
          offer.field_evidence as Array<Record<string, unknown>>
        )[0]!.source_url = "https://other.example/products/framing-nailer";
      },
    ],
    [
      "foreign merchant hostname",
      (offer: Record<string, unknown>) => {
        (offer.merchant as Record<string, unknown>).origin_domain =
          "other.example";
      },
    ],
    [
      "unbound receipt digest",
      (offer: Record<string, unknown>) => {
        const evidence = (
          offer.field_evidence as Array<Record<string, unknown>>
        )[0]!;
        evidence.evidence_digest = `sha256:${"f".repeat(64)}`;
      },
    ],
  ] as const)(
    "rejects a verified result offer with %s",
    async (_name, mutate) => {
      const payload = resultWithOffer(null);
      mutate(
        payload.groups[0]!.offers[0]! as unknown as Record<string, unknown>,
      );
      const client = new Kaval({
        fetch: (async () =>
          new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      });

      await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
        TypeError,
      );
    },
  );

  it("preserves the explicit unknown price qualifier on a result offer", async () => {
    const payload = resultWithOffer(null, ["unknown"]);
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).resolves.toEqual(payload);
  });

  it("preserves a positive per-unit basis on a result offer", async () => {
    const payload = resultWithOffer(null, ["estimated"], {
      kind: "per_unit",
      quantity: 12,
      unit: "ft",
    });
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).resolves.toEqual(payload);
  });

  it.each([
    {
      name: "missing unit",
      basis: { kind: "per_unit", quantity: 12 },
    },
    {
      name: "missing quantity",
      basis: { kind: "per_unit", unit: "ft" },
    },
    {
      name: "nonpositive quantity",
      basis: { kind: "per_unit", quantity: 0, unit: "ft" },
    },
    {
      name: "blank unit",
      basis: { kind: "per_unit", quantity: 12, unit: "" },
    },
    {
      name: "unexpected field",
      basis: { kind: "per_unit", quantity: 12, unit: "ft", rate: 1 },
    },
  ])("rejects a per-unit result basis with $name", async ({ basis }) => {
    const payload = resultWithOffer(
      null,
      ["estimated"],
      basis as ProductResearchPrice["basis"],
    );
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it.each([
    ["unknown", ["unknown", "sale"]],
    ["standard", ["standard", "member"]],
  ] as const)(
    "rejects exclusive %s price terms mixed with a conditional qualifier",
    async (_exclusive, qualifiers) => {
      const payload = resultWithOffer(null, [...qualifiers]);
      const client = new Kaval({
        fetch: (async () =>
          new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      });

      await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
        TypeError,
      );
    },
  );

  it.each([
    {
      name: "landed-total arithmetic drift",
      delivery: {
        ...DELIVERY,
        calculated_landed_total: { amount_minor: 22_051, currency: "USD" },
      },
    },
    {
      name: "foreign origin binding",
      delivery: {
        ...DELIVERY,
        origin_url: "https://other.example/products/framing-nailer",
      },
    },
    {
      name: "foreign adapter receipt",
      delivery: {
        ...DELIVERY,
        version_receipt: "checkout-other/1:quote-42",
      },
    },
    {
      name: "foreign research request",
      delivery: {
        ...DELIVERY,
        research_request_digest: `sha256:${"9".repeat(64)}`,
      },
    },
  ])("rejects delivery evidence with $name", async ({ delivery }) => {
    const payload = resultWithOffer(
      delivery as ProductResearchDeliveryEvidence,
    );
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it.each([
    {
      ...RESULT,
      authority: {
        mode: "review_only",
        action_authorized: true,
        permission: "withheld",
      },
    },
    { ...RESULT, request_digest: "sha256:not-a-digest" },
    {
      ...RESULT,
      interpretation: { ...RESULT.interpretation, original_query: "other" },
    },
    {
      ...RESULT,
      coverage: {
        ...RESULT.coverage,
        source_ledger: RESULT.coverage.source_ledger.map((entry) => ({
          ...entry,
          reason_codes: [],
        })),
      },
    },
    {
      ...RESULT,
      coverage: {
        ...RESULT.coverage,
        source_ledger: RESULT.coverage.source_ledger.map((entry) => ({
          ...entry,
          outcome_counts: { ...entry.outcome_counts, failed: 0 },
        })),
      },
    },
    {
      ...RESULT,
      coverage: {
        ...RESULT.coverage,
        execution_receipt: {
          ...RESULT.coverage.execution_receipt,
          first_useful_candidate_ms: 1,
        },
      },
    },
    resultWithDiscovery({ relationship: "other" }),
  ])("rejects malformed or authority-bearing JSON", async (payload) => {
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it.each([
    {
      name: "an offer observed after research completion",
      payload: (() => {
        const result = resultWithOffer(null);
        const observedAt = new Date(
          Date.parse(result.completed_at) + 1_000,
        ).toISOString();
        result.groups[0]!.offers[0]!.observed_at = observedAt;
        for (const evidence of result.groups[0]!.offers[0]!.field_evidence) {
          evidence.observed_at = observedAt;
        }
        return result;
      })(),
    },
    {
      name: "a result expiry beyond its verified offer",
      payload: (() => {
        const result = resultWithOffer(null);
        result.expires_at = new Date(
          Date.parse(result.groups[0]!.offers[0]!.expires_at) + 1_000,
        ).toISOString();
        return result;
      })(),
    },
    {
      name: "a discovery observed after research completion",
      payload: (() => {
        const result = resultWithDiscovery();
        result.unverified_discoveries[0]!.observed_at = new Date(
          Date.parse(result.completed_at) + 1_000,
        ).toISOString();
        return result;
      })(),
    },
  ])("rejects $name", async ({ payload }) => {
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it.each([
    {
      name: "asserted identity without an asserted identifier clue",
      mutate: (payload: ProductResearchResult) => {
        payload.interpretation.identity_state = "asserted_identifier";
      },
    },
    {
      name: "an exact-identifier class without asserted identity",
      mutate: (payload: ProductResearchResult) => {
        payload.interpretation.query_class = "exact_identifier";
      },
    },
    {
      name: "rental-or-quote classification without matching listing intent",
      mutate: (payload: ProductResearchResult) => {
        payload.interpretation.query_class = "rental_or_quote";
      },
    },
    {
      name: "a thirteenth planned query",
      mutate: (payload: ProductResearchResult) => {
        const template = payload.interpretation.query_bundle.queries[0]!;
        for (let index = 1; index < 13; index += 1) {
          payload.interpretation.query_bundle.queries.push({
            ...template,
            query_id: `sha256:${index.toString(16).padStart(64, "0")}`,
            text: `cordless framing nailer ${index}`,
          });
        }
      },
    },
    {
      name: "a noncanonical warning extension",
      mutate: (payload: ProductResearchResult) => {
        payload.warnings = [
          {
            code: "BOUNDED_NOT_COMPREHENSIVE",
            message: "Bounded research.",
            scope: "coverage",
            subject_id: null,
            unexpected: true,
          } as ProductResearchResult["warnings"][number],
        ];
      },
    },
  ])("rejects $name", async ({ mutate }) => {
    const payload = structuredClone(RESULT);
    mutate(payload);
    const client = new Kaval({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    await expect(client.researchProducts(REQUEST)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("streams ordered canonical events and returns the exact completed result", async () => {
    const source = {
      type: "source_progress",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 1,
      observed_at: "2026-07-16T12:00:01.000Z",
      source_id: "search:fixture",
      family: "shopping_search",
      state: "failed",
      reason_code: "UPSTREAM_UNAVAILABLE",
    };
    const completed = {
      type: "completed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 2,
      observed_at: RESULT.completed_at,
      result: RESULT,
    };
    const client = new Kaval({
      fetch: (async () =>
        streamResponse(accepted, source, completed)) as typeof fetch,
    });

    const output = await drain(
      client.streamProductResearch(REQUEST, {
        idempotencyKey: "product-research-stream-0001",
      }),
    );
    expect(output.events.map((event) => event.type)).toEqual([
      "accepted",
      "source_progress",
      "completed",
    ]);
    expect(output.result).toEqual(RESULT);
  });

  it("retries one pre-open transport failure with the same operation key", async () => {
    const completed = {
      type: "completed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 1,
      observed_at: RESULT.completed_at,
      result: RESULT,
    };
    const seen: Array<{ key: string | null; body: unknown }> = [];
    const client = new Kaval({
      fetch: (async (_input, init) => {
        seen.push({
          key: new Headers(init?.headers).get("idempotency-key"),
          body: JSON.parse(String(init?.body)),
        });
        if (seen.length === 1) throw new TypeError("connection reset");
        return streamResponse(accepted, completed);
      }) as typeof fetch,
    });

    const output = await drain(
      client.streamProductResearch(REQUEST, {
        idempotencyKey: "product-research-retry-0001",
      }),
    );
    expect(seen).toEqual([
      { key: "product-research-retry-0001", body: REQUEST },
      { key: "product-research-retry-0001", body: REQUEST },
    ]);
    expect(output.result).toEqual(RESULT);
  });

  it("retries one ambiguous HTTP response with the same operation key", async () => {
    const completed = {
      type: "completed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 1,
      observed_at: RESULT.completed_at,
      result: RESULT,
    };
    const keys: Array<string | null> = [];
    const client = new Kaval({
      fetch: (async (_input, init) => {
        keys.push(new Headers(init?.headers).get("idempotency-key"));
        if (keys.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: "idempotency_resolution_pending",
                message: "retry the same operation",
              },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return streamResponse(accepted, completed);
      }) as typeof fetch,
    });

    const output = await drain(
      client.streamProductResearch(REQUEST, {
        idempotencyKey: "product-research-ambiguous-0001",
      }),
    );
    expect(keys).toEqual([
      "product-research-ambiguous-0001",
      "product-research-ambiguous-0001",
    ]);
    expect(output.result).toEqual(RESULT);
  });

  it("times out an open Product Research stream and retains the recovery key", async () => {
    const client = new Kaval({
      fetch: (async (_input, init) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const abort = () =>
                controller.error(signal?.reason ?? new Error("timed out"));
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch,
      timeoutMs: 20,
    });

    await expect(
      drain(
        client.streamProductResearch(REQUEST, {
          idempotencyKey: "product-research-timeout-0001",
        }),
      ),
    ).rejects.toMatchObject({
      idempotencyKey: "product-research-timeout-0001",
    });
  });

  it("cancels the response body when a consumer stops reading early", async () => {
    let markCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const client = new Kaval({
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(eventFrame(accepted)),
              );
            },
            cancel() {
              markCancelled();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )) as typeof fetch,
      timeoutMs: null,
    });

    for await (const event of client.streamProductResearch(REQUEST)) {
      expect(event.type).toBe("accepted");
      break;
    }
    await expect(cancelled).resolves.toBeUndefined();
  });

  it.each([
    ["destination-bound evidence", DELIVERY],
    ["an explicit product-only null", null],
  ] as const)(
    "validates candidate progress carrying %s",
    async (_name, delivery) => {
      const candidate = candidateWithDelivery(delivery);
      const observed = {
        type: "candidate_observed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        candidate,
      };
      const completed = {
        type: "completed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 2,
        observed_at: RESULT.completed_at,
        result: RESULT,
      };
      const client = new Kaval({
        fetch: (async () =>
          streamResponse(accepted, observed, completed)) as typeof fetch,
      });

      const output = await drain(client.streamProductResearch(REQUEST));
      expect(output.events[1]).toMatchObject({
        type: "candidate_observed",
        candidate: { delivery },
      });
      expect(output.result).toEqual(RESULT);
    },
  );

  it("validates candidate progress carrying the unknown price qualifier", async () => {
    const candidate = candidateWithDelivery(null, ["unknown"]);
    const observed = {
      type: "candidate_observed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 1,
      observed_at: RESULT.completed_at,
      candidate,
    };
    const completed = {
      type: "completed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 2,
      observed_at: RESULT.completed_at,
      result: RESULT,
    };
    const client = new Kaval({
      fetch: (async () =>
        streamResponse(accepted, observed, completed)) as typeof fetch,
    });

    const output = await drain(client.streamProductResearch(REQUEST));
    expect(output.events[1]).toMatchObject({
      type: "candidate_observed",
      candidate: { price: { qualifiers: ["unknown"] } },
    });
    expect(output.result).toEqual(RESULT);
  });

  it("validates candidate progress carrying a positive per-unit basis", async () => {
    const candidate = candidateWithDelivery(null, ["estimated"], {
      kind: "per_unit",
      quantity: 2.5,
      unit: "kg",
    });
    const observed = {
      type: "candidate_observed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 1,
      observed_at: RESULT.completed_at,
      candidate,
    };
    const completed = {
      type: "completed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 2,
      observed_at: RESULT.completed_at,
      result: RESULT,
    };
    const client = new Kaval({
      fetch: (async () =>
        streamResponse(accepted, observed, completed)) as typeof fetch,
    });

    const output = await drain(client.streamProductResearch(REQUEST));
    expect(output.events[1]).toMatchObject({
      type: "candidate_observed",
      candidate: {
        price: { basis: { kind: "per_unit", quantity: 2.5, unit: "kg" } },
      },
    });
    expect(output.result).toEqual(RESULT);
  });

  it.each([
    [
      "empty material evidence",
      (candidate: Record<string, unknown>) => (candidate.field_evidence = []),
    ],
    [
      "foreign merchant hostname",
      (candidate: Record<string, unknown>) => {
        (candidate.merchant as Record<string, unknown>).origin_domain =
          "other.example";
      },
    ],
  ] as const)("rejects candidate progress with %s", async (_name, mutate) => {
    const candidate = candidateWithDelivery(null);
    mutate(candidate as unknown as Record<string, unknown>);
    const observed = {
      type: "candidate_observed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 1,
      observed_at: RESULT.completed_at,
      candidate,
    };
    const client = new Kaval({
      fetch: (async () => streamResponse(accepted, observed)) as typeof fetch,
    });

    await expect(
      drain(client.streamProductResearch(REQUEST)),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("validates neutral discovery-candidate progress", async () => {
    const observed = {
      type: "candidate_observed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 1,
      observed_at: RESULT.completed_at,
      candidate: discoveryCandidate(),
    };
    const completed = {
      type: "completed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 2,
      observed_at: RESULT.completed_at,
      result: RESULT,
    };
    const client = new Kaval({
      fetch: (async () =>
        streamResponse(accepted, observed, completed)) as typeof fetch,
    });

    const output = await drain(client.streamProductResearch(REQUEST));
    expect(output.events[1]).toMatchObject({
      type: "candidate_observed",
      candidate: {
        candidate_state: "discovery",
        product_name: "Unverified web result",
        relationship: "unknown",
      },
    });
    expect(output.result).toEqual(RESULT);
  });

  it.each([
    ["seller-derived title", { product_name: "Merchant nailer deal" }],
    ["inferred relationship", { relationship: "primary_product" }],
  ] as const)(
    "rejects discovery-candidate progress with %s",
    async (_name, overrides) => {
      const observed = {
        type: "candidate_observed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        candidate: discoveryCandidate(overrides),
      };
      const client = new Kaval({
        fetch: (async () => streamResponse(accepted, observed)) as typeof fetch,
      });

      await expect(
        drain(client.streamProductResearch(REQUEST)),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it.each([
    ["unknown", ["unknown", "coupon"]],
    ["standard", ["standard", "estimated"]],
  ] as const)(
    "rejects candidate progress mixing %s with a conditional qualifier",
    async (_exclusive, qualifiers) => {
      const observed = {
        type: "candidate_observed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        candidate: candidateWithDelivery(null, [...qualifiers]),
      };
      const client = new Kaval({
        fetch: (async () => streamResponse(accepted, observed)) as typeof fetch,
      });

      await expect(
        drain(client.streamProductResearch(REQUEST)),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "returns the canonical result carried by a live %s terminal event",
    async (type) => {
      const result = canonicalTerminalResult(type);
      const terminal =
        type === "failed"
          ? {
              type,
              research_id: RESULT.research_id,
              request_digest: RESULT.request_digest,
              sequence: 1,
              observed_at: RESULT.completed_at,
              error_code: "UPSTREAM_UNAVAILABLE",
              message: "The configured source was unavailable.",
              result,
            }
          : {
              type,
              research_id: RESULT.research_id,
              request_digest: RESULT.request_digest,
              sequence: 1,
              observed_at: RESULT.completed_at,
              reason_code: "CLIENT_CANCELLED",
              result,
            };
      const client = new Kaval({
        fetch: (async () => streamResponse(accepted, terminal)) as typeof fetch,
      });
      const output = await drain(client.streamProductResearch(REQUEST));
      expect(output.events.at(-1)?.type).toBe(type);
      expect(output.result).toEqual(result);
    },
  );

  it.each([
    {
      name: "a missing failed result",
      terminal: {
        type: "failed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        error_code: "UPSTREAM_UNAVAILABLE",
        message: "The configured source was unavailable.",
      },
    },
    {
      name: "terminal/result operational-state drift",
      terminal: {
        type: "failed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        error_code: "UPSTREAM_UNAVAILABLE",
        message: "The configured source was unavailable.",
        result: RESULT,
      },
    },
    {
      name: "completed/result operational-state drift",
      terminal: {
        type: "completed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        result: canonicalTerminalResult("failed"),
      },
    },
    {
      name: "terminal/result research-id drift",
      terminal: {
        type: "failed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        error_code: "UPSTREAM_UNAVAILABLE",
        message: "The configured source was unavailable.",
        result: {
          ...canonicalTerminalResult("failed"),
          research_id: "another-research",
        },
      },
    },
    {
      name: "terminal/result digest drift",
      terminal: {
        type: "failed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        error_code: "UPSTREAM_UNAVAILABLE",
        message: "The configured source was unavailable.",
        result: {
          ...canonicalTerminalResult("failed"),
          request_digest: `sha256:${"f".repeat(64)}`,
        },
      },
    },
    {
      name: "terminal/result query drift",
      terminal: {
        type: "failed",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        error_code: "UPSTREAM_UNAVAILABLE",
        message: "The configured source was unavailable.",
        result: {
          ...canonicalTerminalResult("failed"),
          interpretation: {
            ...RESULT.interpretation,
            original_query: "a different product",
          },
        },
      },
    },
    {
      name: "authority-bearing terminal result",
      terminal: {
        type: "cancelled",
        research_id: RESULT.research_id,
        request_digest: RESULT.request_digest,
        sequence: 1,
        observed_at: RESULT.completed_at,
        reason_code: "CLIENT_CANCELLED",
        result: {
          ...canonicalTerminalResult("cancelled"),
          authority: {
            mode: "review_only",
            action_authorized: true,
            permission: "withheld",
          },
        },
      },
    },
  ])("rejects $name", async ({ terminal }) => {
    const client = new Kaval({
      fetch: (async () => streamResponse(accepted, terminal)) as typeof fetch,
    });
    await expect(
      drain(client.streamProductResearch(REQUEST)),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("accepts the explicit replay extension followed by a bound completion", async () => {
    const replay = {
      type: "replay",
      sequence: 0,
      replayed_at: "2026-07-16T12:10:00.000Z",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      authority: {
        mode: "review_only",
        action_authorized: false,
        permission: "withheld",
      },
    };
    const completed = {
      type: "completed",
      research_id: RESULT.research_id,
      request_digest: RESULT.request_digest,
      sequence: 1,
      observed_at: RESULT.completed_at,
      result: RESULT,
    };
    const client = new Kaval({
      fetch: (async () => streamResponse(replay, completed)) as typeof fetch,
    });
    const output = await drain(client.streamProductResearch(REQUEST));
    expect(output.events.map((event) => event.type)).toEqual([
      "replay",
      "completed",
    ]);
    expect(output.result).toEqual(RESULT);
  });

  it.each([
    {
      ...accepted,
      sequence: 1,
    },
    {
      ...accepted,
      type: "source_progress",
    },
    {
      ...accepted,
      request_digest: `sha256:${"f".repeat(64)}`,
    },
    {
      ...accepted,
      observed_at: "not-a-timestamp",
    },
  ])(
    "rejects malformed stream ordering, type, binding, or time",
    async (event) => {
      const client = new Kaval({
        fetch: (async () => streamResponse(event)) as typeof fetch,
      });
      await expect(
        drain(client.streamProductResearch(REQUEST)),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it("surfaces post-open typed SSE errors with the operation key", async () => {
    const client = new Kaval({
      fetch: (async () =>
        new Response(
          `event: error\ndata: ${JSON.stringify({ status: 503, error: { code: "product_research_unavailable" } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )) as typeof fetch,
    });
    const promise = drain(
      client.streamProductResearch(REQUEST, {
        idempotencyKey: "product-research-stream-error-0001",
      }),
    );
    await expect(promise).rejects.toMatchObject({
      status: 503,
      idempotencyKey: "product-research-stream-error-0001",
    });
    await expect(promise).rejects.toBeInstanceOf(KavalError);
  });

  it("propagates cancellation without retrying and retains the recovery key", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const client = new Kaval({
      fetch: (async (_input, init) => {
        attempts += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }) as typeof fetch,
      timeoutMs: null,
    });
    const pending = drain(
      client.streamProductResearch(REQUEST, {
        signal: controller.signal,
        idempotencyKey: "product-research-cancel-0001",
      }),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      idempotencyKey: "product-research-cancel-0001",
    });
    expect(attempts).toBe(1);
  });
});
