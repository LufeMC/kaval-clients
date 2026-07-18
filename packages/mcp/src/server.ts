import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KavalError, type Kaval } from "@usekaval/kaval";
import { z } from "zod";

const idempotencyKeyInput = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7e]+$/)
  .optional()
  .describe(
    "reuse the operation key returned by an ambiguous prior attempt; omit for a new operation",
  );
const RECOVERABLE_API_CODES = new Set([
  "idempotency_in_progress",
  "idempotency_resolution_pending",
  "event_persistence_pending",
]);
const materialityInput = z.enum(["low", "medium", "high", "critical"]);
const reversibilityInput = z.enum([
  "reversible",
  "partially_reversible",
  "irreversible",
  "unknown",
]);
const actionContextInput = {
  description: z.string().min(1).max(10_000),
  materiality: materialityInput,
  reversibility: reversibilityInput,
  false_allow_cost_usd: z.number().finite().nonnegative().optional(),
  false_block_cost_usd: z.number().finite().nonnegative().optional(),
  wait_cost_usd: z.number().finite().nonnegative().optional(),
};
const decisionThresholdInput = {
  policy_id: z.string().min(1),
  policy_version: z.string().min(1),
  materiality: materialityInput,
  maximum_false_allow_risk: z.number().min(0).max(1),
  minimum_evidence_coverage: z.number().min(0).max(1),
};
const httpUrlInput = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    );
  }, "must be an http(s) URL");
const PRODUCT_RESEARCH_URL_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//iu;
const SECRET_URL_PARAMETER =
  /(?:^|[_-])(?:api[_-]?key|auth|authorization|credential|password|secret|sig(?:nature)?|token)(?:$|[_-])/iu;

function fragmentParameters(fragment: string): URLSearchParams | null {
  const value = fragment.replace(/^#/u, "");
  if (!value.includes("=")) return null;
  const queryIndex = value.indexOf("?");
  return new URLSearchParams(
    queryIndex === -1 ? value : value.slice(queryIndex + 1),
  );
}

function credentialSafeProductResearchQuery(value: string): boolean {
  if (!PRODUCT_RESEARCH_URL_PREFIX.test(value)) return true;
  try {
    const url = new URL(value);
    const fragment = fragmentParameters(url.hash);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      ![...url.searchParams.keys()].some((key) =>
        SECRET_URL_PARAMETER.test(key),
      ) &&
      (fragment === null ||
        ![...fragment.keys()].some((key) => SECRET_URL_PARAMETER.test(key)))
    );
  } catch {
    return false;
  }
}

const productResearchQueryInput = z
  .string()
  .trim()
  .min(2)
  .max(1_000)
  .refine(
    credentialSafeProductResearchQuery,
    "a whole-query URL must use HTTP(S) and cannot contain credentials or secret URL parameters",
  );
const productIdentifierSchemeInput = z.enum([
  "gtin",
  "upc",
  "ean",
  "isbn",
  "mpn",
  "manufacturer_sku",
  "model",
]);
const productConditionInput = z.enum([
  "new",
  "open_box",
  "refurbished",
  "used_like_new",
  "used_good",
  "used_acceptable",
  "unknown",
]);
const sellerKindInput = z.enum([
  "brand_direct",
  "authorized_retailer",
  "marketplace",
  "independent_retailer",
  "unknown",
]);
const productIdentifierInput = z
  .object({
    scheme: productIdentifierSchemeInput,
    value: z.string().min(1).max(512),
    issuer: z.string().min(1).max(512).optional(),
  })
  .strict();
const productAttributeValueInput = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);
const productAttributeInput = z
  .object({
    key: z.string().min(1).max(512),
    value: productAttributeValueInput,
    unit: z.string().min(1).max(128).optional(),
  })
  .strict();
const packSpecInput = z
  .object({
    count: z.number().int().positive(),
    units_per_item: z.number().finite().positive().optional(),
    unit: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (pack) => (pack.units_per_item === undefined) === (pack.unit === undefined),
    {
      message: "units_per_item and unit must be supplied together",
    },
  );
const commerceDigestInput = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const merchantDomainInput = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => value === value.toLowerCase(), {
    message: "merchant domains must be lowercase",
  })
  .refine((value) => {
    try {
      return new URL(`https://${value}`).hostname === value;
    } catch {
      return false;
    }
  }, "merchant domain must be a valid hostname");
const productResearchListingKindInput = z.enum([
  "purchase",
  "rental",
  "quote_only",
]);
const productResearchPriceFilterInput = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/u),
    minimum_amount_minor: z.number().int().safe().nonnegative().optional(),
    maximum_amount_minor: z.number().int().safe().nonnegative().optional(),
  })
  .strict()
  .refine(
    (price) =>
      price.minimum_amount_minor === undefined ||
      price.maximum_amount_minor === undefined ||
      price.minimum_amount_minor <= price.maximum_amount_minor,
    {
      path: ["maximum_amount_minor"],
      message: "maximum price cannot be below minimum price",
    },
  );
const productResearchFiltersInput = z
  .object({
    condition: productConditionInput.optional(),
    pack: packSpecInput.optional(),
    brand: z.string().trim().min(1).max(256).optional(),
    model: z.string().trim().min(1).max(256).optional(),
    merchant_policy: z
      .object({
        allowed_domains: z.array(merchantDomainInput).max(1_000),
        blocked_domains: z.array(merchantDomainInput).max(1_000),
        marketplace_policy: z.enum(["allow", "exclude"]),
      })
      .strict()
      .superRefine((policy, ctx) => {
        if (
          new Set(policy.allowed_domains).size !== policy.allowed_domains.length
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["allowed_domains"],
            message: "allowed merchant domains must be unique",
          });
        }
        if (
          new Set(policy.blocked_domains).size !== policy.blocked_domains.length
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["blocked_domains"],
            message: "blocked merchant domains must be unique",
          });
        }
        const allowed = new Set(policy.allowed_domains);
        if (policy.blocked_domains.some((domain) => allowed.has(domain))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["blocked_domains"],
            message: "a merchant domain cannot be both allowed and blocked",
          });
        }
      })
      .optional(),
    listing_kinds: z
      .array(productResearchListingKindInput)
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length, {
        message: "listing kinds must be unique",
      })
      .optional(),
    price: productResearchPriceFilterInput.optional(),
  })
  .strict();
const commerceActionBindingInput = z
  .object({
    action_slot_key: z.string().trim().min(1).max(512),
    action_input_digest: commerceDigestInput,
    action_consequence_digest: commerceDigestInput,
  })
  .strict()
  .refine(
    (binding) =>
      binding.action_input_digest !== binding.action_consequence_digest,
    {
      message: "action input and consequence digests cannot alias one another",
      path: ["action_consequence_digest"],
    },
  );
const substitutionBaseInput = {
  rule_id: z.string().min(1).max(512),
  rationale: z.string().min(1).max(4_000),
  maximum_materiality: materialityInput,
};
const permittedSubstitutionInput = z.discriminatedUnion("kind", [
  z
    .object({
      ...substitutionBaseInput,
      kind: z.literal("attribute"),
      key: z.string().min(1).max(512),
      requested_value: productAttributeValueInput,
      permitted_value: productAttributeValueInput,
      requested_unit: z.string().min(1).max(128).optional(),
      permitted_unit: z.string().min(1).max(128).optional(),
    })
    .strict(),
  z
    .object({
      ...substitutionBaseInput,
      kind: z.literal("pack"),
      requested: packSpecInput,
      permitted: packSpecInput,
    })
    .strict(),
  z
    .object({
      ...substitutionBaseInput,
      kind: z.literal("condition"),
      requested: productConditionInput,
      permitted: productConditionInput,
    })
    .strict(),
  z
    .object({
      ...substitutionBaseInput,
      kind: z.literal("variant"),
      requested_identifiers: z.array(productIdentifierInput).min(1).max(50),
      permitted_variant_id: z.string().min(1).max(512),
      permitted_identifiers: z.array(productIdentifierInput).min(1).max(50),
    })
    .strict(),
]);

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function toolError(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

function transportOptions(
  idempotencyKey: string | undefined,
  signal: AbortSignal,
) {
  return {
    signal,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/** Pull the API's `{ error: { code, message } }` envelope off a KavalError payload (defensively — the
 *  body may be a string, null, or some other shape if the API ever returns a non-standard error). */
function apiError(payload: unknown): { code?: string; message?: string } {
  if (payload && typeof payload === "object" && "error" in payload) {
    const err = (payload as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const { code, message } = err as { code?: unknown; message?: unknown };
      return {
        code: typeof code === "string" ? code : undefined,
        message: typeof message === "string" ? message : undefined,
      };
    }
  }
  return {};
}

/** Run a tool body, returning a sanitized error result. An API error (e.g. 402 out-of-credit, 401
 *  invalid key) is surfaced with its status + code/message so the agent can act on it; anything else
 *  collapses to a generic message so internal details never leak. */
async function safe(fn: () => Promise<unknown>) {
  try {
    return json(await fn());
  } catch (e) {
    console.error("[kaval-mcp] tool error:", e);
    if (e instanceof KavalError) {
      const { code, message } = apiError(e.payload);
      return toolError({
        error: code ?? "request_failed",
        ...(message ? { message } : {}),
        status: e.status,
        ...(code && RECOVERABLE_API_CODES.has(code) && e.idempotencyKey
          ? { idempotency_key: e.idempotencyKey }
          : {}),
      });
    }
    const idempotencyKey =
      e && typeof e === "object" && "idempotencyKey" in e
        ? (e as { idempotencyKey?: unknown }).idempotencyKey
        : undefined;
    if (typeof idempotencyKey === "string") {
      return toolError({
        error: "request_ambiguous",
        message: "retry later with the same idempotency_key",
        idempotency_key: idempotencyKey,
      });
    }
    return toolError({ error: "internal error" });
  }
}

/**
 * The agent-facing evidence-gate server. It exposes review-only offer research, the full proof
 * audit/gate protocol, legacy currentness compatibility, and outcome reporting. Tool names use
 * underscores for client portability.
 */
export function createMcpServer(client: Kaval): McpServer {
  const server = new McpServer({ name: "kaval", version: "0.4.0" });

  // Kaval's primary product-only workflow. It returns bounded comparison evidence and remains
  // deliberately incapable of granting action authority.
  server.registerTool(
    "product_research",
    {
      description:
        "Research an ordinary product query across the configured bounded source system. No ZIP, manufacturer, model, or identifier is required. Returns canonical exact/possible/conflicting product groups, item prices, availability, source links, unverified discoveries, refinements, warnings, and an explicit bounded-not-comprehensive coverage ledger. This tool is review-only: authority.permission is always withheld and it NEVER authorizes quoting, purchasing, checkout, or another action.",
      inputSchema: {
        query: productResearchQueryInput,
        vertical: z.string().trim().min(1).max(128).optional(),
        market: z
          .object({
            country_code: z.string().regex(/^[A-Z]{2}$/u),
            preferred_currency: z.string().regex(/^[A-Z]{3}$/u),
          })
          .strict()
          .optional(),
        destination: z
          .object({
            country_code: z.string().regex(/^[A-Z]{2}$/u),
            region: z.string().trim().min(1).max(128).optional(),
            postal_code: z.string().trim().min(1).max(32).optional(),
          })
          .strict()
          .optional(),
        filters: productResearchFiltersInput.optional(),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, extra) =>
      safe(async () => {
        const input = args as Parameters<Kaval["researchProducts"]>[0];
        const progressToken = extra._meta?.progressToken;
        if (progressToken === undefined) {
          return client.researchProducts(
            input,
            transportOptions(idempotency_key, extra.signal),
          );
        }

        // Generate one operation key so the progress stream and its embedded terminal result stay
        // bound to the same durable Product Research operation.
        const operationKey = idempotency_key ?? randomUUID();
        const options = transportOptions(operationKey, extra.signal);
        let finalResult:
          Awaited<ReturnType<Kaval["researchProducts"]>> | undefined;
        for await (const event of client.streamProductResearch(
          input,
          options,
        )) {
          if (event.type === "completed") {
            finalResult = event.result;
            continue;
          }
          if (event.type === "failed" || event.type === "cancelled") {
            finalResult = event.result;
          }
          const message =
            event.type === "replay"
              ? "replay: returning the durable review-only Product Research result"
              : event.type === "accepted"
                ? `accepted: ${event.query}`
                : event.type === "source_progress"
                  ? `source_progress: ${event.source_id} ${event.state}`
                  : event.type === "candidate_observed"
                    ? `candidate_observed: ${event.candidate.product_name}`
                    : event.type === "group_updated"
                      ? `group_updated: ${event.group.product_name}`
                      : event.type === "interpreted"
                        ? `interpreted: ${event.interpretation.normalized_query}`
                        : event.type === "failed"
                          ? `failed: ${event.error_code}`
                          : `cancelled: ${event.reason_code}`;
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: event.sequence,
              message,
              _meta: {
                "usekaval.com/product-research-progress": event,
              },
            },
          });
        }
        if (finalResult) return finalResult;
        throw new TypeError(
          "Product Research stream ended without a canonical terminal state",
        );
      }),
  );

  // Find current evidence for the commerce workflow. This is deliberately incapable of granting
  // action permission while the hosted Offer Search surface remains shadow-grade.
  server.registerTool(
    "offer_search",
    {
      description:
        "Find current offer evidence across permitted configured catalogs, feeds, retailer/search workers, origin pages, browser-rendered DOM, and checkout resolvers for one requested product and destination. Returns candidates, checkout evidence, and an explicit bounded source ledger with action.state NEEDS_REVIEW or NO_RELIABLE_OFFER only. This review-only shadow tool NEVER returns ALLOW or SAFE_TO_QUOTE and does not authorize quoting, purchasing, or any other action; send every candidate to human review.",
      inputSchema: {
        schema_revision: z.number().int().positive(),
        request_id: z.string().min(1).max(256),
        raw_description: z.string().min(1).max(10_000),
        target: z
          .object({
            schema_revision: z.number().int().positive(),
            family: z
              .object({
                brand: z.string().min(1).max(512).optional(),
                name: z.string().min(1).max(1_000).optional(),
                category: z.string().min(1).max(512).optional(),
              })
              .strict()
              .optional(),
            name: z.string().min(1).max(1_000).optional(),
            identifiers: z.array(productIdentifierInput).max(32),
            attributes: z.array(productAttributeInput).max(64),
            pack: packSpecInput.optional(),
          })
          .strict(),
        requested_condition: productConditionInput,
        destination: z
          .object({
            country_code: z.string().regex(/^[A-Z]{2}$/u),
            region: z.string().min(1).max(128).optional(),
            postal_code: z.string().min(1).max(32).optional(),
          })
          .strict(),
        match_policy: z
          .object({
            identity_requirement: z.enum([
              "shared_identifier",
              "shared_identifier_or_complete_attributes",
            ]),
            required_identifier_schemes: z
              .array(productIdentifierSchemeInput)
              .max(7),
            required_attribute_keys: z.array(z.string().min(1)).max(64),
            permitted_substitutions: z
              .array(permittedSubstitutionInput)
              .max(64),
          })
          .strict(),
        seller_policy: z
          .object({
            allowed_seller_ids: z.array(z.string().min(1)).max(1_000),
            blocked_seller_ids: z.array(z.string().min(1)).max(1_000),
            allowed_kinds: z.array(sellerKindInput).min(1).max(5),
            require_authorized: z.boolean(),
          })
          .strict(),
        destination_policy: z
          .object({
            require_eligible: z.boolean(),
            require_exact_region: z.boolean(),
            require_exact_postal_code: z.boolean(),
          })
          .strict(),
        price_policy: z
          .object({
            currency: z.string().regex(/^[A-Z]{3}$/u),
            maximum_landed_total_minor: z
              .number()
              .int()
              .nonnegative()
              .optional(),
            require_complete_landed_total: z.boolean(),
            allow_estimated_components: z.boolean(),
            allow_member_price: z.boolean(),
            allow_subscription_price: z.boolean(),
            allow_coupon_price: z.boolean(),
            allow_installment_display: z.boolean(),
            allow_trade_in_price: z.boolean(),
          })
          .strict(),
        source_policy: z
          .object({
            allowed_source_ids: z.array(z.string().min(1)).max(1_000),
            blocked_source_ids: z.array(z.string().min(1)).max(1_000),
            require_origin_evidence: z.boolean(),
          })
          .strict(),
        intended_action: z
          .object({
            description: z.string().min(1).max(2_000),
            materiality: materialityInput,
            reversibility: z.enum([
              "reversible",
              "partially_reversible",
              "irreversible",
            ]),
          })
          .strict(),
        freshness_maximum_age_ms: z
          .number()
          .int()
          .nonnegative()
          .max(31_536_000_000),
        max_results: z.number().int().min(1).max(100),
        minimum_unique_sellers: z.number().int().min(1).max(100),
        deadline_ms: z.number().int().min(50).max(300_000),
        maximum_cost_micro_usd: z.number().int().nonnegative(),
        maximum_search_calls: z.number().int().nonnegative().max(1_000),
        maximum_fetches: z.number().int().nonnegative().max(10_000),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, extra) =>
      safe(async () => {
        const input = args as Parameters<Kaval["searchOffers"]>[0];
        const options = transportOptions(idempotency_key, extra.signal);
        const progressToken = extra._meta?.progressToken;
        if (progressToken === undefined) {
          return client.searchOffers(input, options);
        }

        let finalResult: Awaited<ReturnType<Kaval["searchOffers"]>> | undefined;
        for await (const event of client.streamOfferSearch(input, options)) {
          if (event.type === "final") {
            finalResult = event.result;
            continue;
          }
          const message =
            event.type === "candidate_provisional"
              ? "candidate_provisional: origin-verified research candidate; final publication pending; durable=false; actionable=false; permission=withheld"
              : "message" in event && typeof event.message === "string"
                ? `${event.type}: ${event.message}`
                : "Offer Search replayed the completed review-only result.";
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: event.sequence,
              message,
              ...(event.type === "candidate_provisional"
                ? {
                    _meta: {
                      "usekaval.com/offer-search-progress": {
                        schema_revision: 1,
                        type: "candidate_provisional",
                        request_id: event.request_id,
                        request_digest: event.details.request_digest,
                        candidate: {
                          candidate_id: event.details.candidate.candidate_id,
                          merchant: {
                            source_id: event.details.candidate.source_id,
                            seller_name:
                              event.details.candidate.origin_offer.seller_name,
                          },
                          price:
                            event.details.candidate.checkout?.observation
                              ?.item_price ??
                            event.details.candidate.origin_offer.item_price,
                          url:
                            event.details.candidate.origin_offer.purchase_url ||
                            event.details.candidate.origin_url,
                          verification: {
                            identity: event.details.candidate.identity,
                            disposition: event.details.candidate.disposition,
                            gaps: event.details.candidate.gaps,
                            reason_codes: event.details.candidate.reason_codes,
                            origin_evidence:
                              event.details.candidate.origin_evidence,
                            checkout: event.details.candidate.checkout,
                            publication_state: "provisional",
                            durable: false,
                            final_inclusion: "not_yet_determined",
                          },
                          action: {
                            state: "REVIEW",
                            actionable: false,
                            permission: "withheld",
                          },
                        },
                      },
                    },
                  }
                : {}),
            },
          });
        }
        if (!finalResult) {
          throw new TypeError(
            "Offer Search stream ended without a canonical final result",
          );
        }
        return finalResult;
      }),
  );

  // Final-fence one exact persisted commerce generation. The hosted contract deliberately keeps
  // permission withheld even when the evidence is current.
  server.registerTool(
    "offer_search_gate",
    {
      description:
        "Re-read one exact persisted Offer Search evidence generation and its stream head immediately before a quote or purchase would be considered. Returns REVIEW with permission withheld for every state, including current_review_only; this tool NEVER authorizes the action. Refresh or send to human review when the generation is missing, stale, expired, invalidated, changed, or otherwise unavailable.",
      inputSchema: {
        dependency_id: z.string().trim().min(1).max(512),
        generation_id: z.string().trim().min(1).max(512),
        generation_number: z.number().int().positive(),
        generation_digest: commerceDigestInput,
        action_binding: commerceActionBindingInput,
      },
    },
    async (args, { signal }) =>
      safe(() =>
        client.gateOfferSearch(
          args as Parameters<Kaval["gateOfferSearch"]>[0],
          { signal },
        ),
      ),
  );

  // Legacy compatibility for the original held-belief API.
  server.registerTool(
    "currentness_verify",
    {
      description:
        "LEGACY HELD-BELIEF COMPATIBILITY — call this before acting on a cached fact, stored field, retrieved RAG chunk, or prior answer. It independently re-derives the truth and returns `act` (boolean) + a typed verdict + the proof. If `act` is false, DO NOT proceed; re-research first. Pass any provenance you kept (source URL, held_at, content hash) so silent drift is caught.",
      inputSchema: {
        belief: z
          .string()
          .describe(
            "the belief you hold, in plain language, e.g. 'Acme is on our Enterprise plan'",
          ),
        context: z
          .string()
          .optional()
          .describe("what you're about to do with it"),
        url: z.string().optional().describe("the source the belief came from"),
        held_at: z
          .string()
          .optional()
          .describe("ISO time you last confirmed it"),
        held_content_hash: z
          .string()
          .optional()
          .describe(
            "content hash you saw at read time (enables changed-since-read detection)",
          ),
        held_evidence: z.array(z.string()).optional(),
        freshness_sla: z
          .string()
          .optional()
          .describe("how current ground truth must be, e.g. '14d'"),
        proof_standard: z.string().optional(),
        minConfidence: z
          .number()
          .optional()
          .describe("act only if confidence ≥ this (default 0.7)"),
        mode: z
          .enum(["instant", "fast", "auto", "deep"])
          .optional()
          .describe(
            "speed/depth tier — instant (cache/prior only, no fetch/LLM) · fast (cheap model) · auto (default) · deep (full multi-source + a cited `explanation`). The result echoes `tier`; on deep it adds `explanation` { content, citations, confidence }.",
          ),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, { signal }) =>
      safe(() =>
        client.verify(args, transportOptions(idempotency_key, signal)),
      ),
  );

  server.registerTool(
    "currentness_check",
    {
      description:
        "Like currentness_verify but returns the raw freshness gap WITHOUT the act/don't-act decision (status: current | stale | contradicted | unsupported | conflicting | insufficient). Prefer currentness_verify when you're about to act on the belief; use this when you just want the status. If status is not 'current', do not rely on the belief.",
      inputSchema: {
        belief: z
          .string()
          .describe(
            "the belief in plain language, e.g. 'Jane Doe is VP Eng at Acme'",
          ),
        context: z
          .string()
          .optional()
          .describe("what you're about to use this belief for"),
        held_evidence: z.array(z.string()).optional(),
        freshness_sla: z
          .string()
          .optional()
          .describe("how current ground truth must be, e.g. '14d'"),
        proof_standard: z.string().optional(),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, { signal }) =>
      safe(() => client.check(args, transportOptions(idempotency_key, signal))),
  );

  server.registerTool(
    "currentness_extract_and_check",
    {
      description:
        "Hand it a paragraph; it finds the checkable factual beliefs itself and re-grounds each. Use when you don't know which facts in some text need checking.",
      inputSchema: {
        text: z.string(),
        context: z.string().optional(),
        freshness_sla: z.string().optional(),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, { signal }) =>
      safe(() =>
        client.extractAndCheck(args, transportOptions(idempotency_key, signal)),
      ),
  );

  server.registerTool(
    "currentness_scan_store",
    {
      description:
        "Re-ground a batch of beliefs your system holds on a freshness SLA (self-sweep). Returns a summary by status + the riskiest (stale/contradicted/unsupported) beliefs, plus the `tier` the sweep ran at. Defaults to the `fast` tier — re-`currentness_verify` a flagged belief at `deep` for the cited explanation.",
      inputSchema: {
        beliefs: z
          .array(z.string())
          .describe("the beliefs to re-ground, in plain language"),
        freshness_sla: z.string().optional(),
        concurrency: z.number().int().positive().optional(),
        mode: z
          .enum(["instant", "fast", "auto", "deep"])
          .optional()
          .describe("speed/depth tier for the whole sweep (default fast)"),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, { signal }) =>
      safe(() =>
        client.scanStore(args, transportOptions(idempotency_key, signal)),
      ),
  );

  server.registerTool(
    "currentness_monitor",
    {
      description:
        "Sweep a batch of beliefs like currentness_scan_store, then POST the NEWLY-risky ones to a `webhook` (server-side delivery). Pass the `state` from the previous run's result to deliver only beliefs that became risky since then (a still-stale belief isn't re-sent each sweep). Run on a schedule (cron) for continuous drift monitoring. The result echoes the `tier` it ran at and the `state` to carry into the next run.",
      inputSchema: {
        beliefs: z
          .array(z.string())
          .describe("the beliefs to monitor, in plain language"),
        freshness_sla: z.string().optional(),
        concurrency: z.number().int().positive().optional(),
        mode: z
          .enum(["instant", "fast", "auto", "deep"])
          .optional()
          .describe("speed/depth tier for the whole sweep (default fast)"),
        webhook: z
          .string()
          .optional()
          .describe("URL that receives a POST with the newly-risky beliefs"),
        state: z
          .object({ riskyKeys: z.array(z.string()) })
          .optional()
          .describe(
            "the `state` from the previous run → deliver only newly-risky beliefs",
          ),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, { signal }) =>
      safe(() =>
        client.monitor(args, transportOptions(idempotency_key, signal)),
      ),
  );

  server.registerTool(
    "proof_audit",
    {
      description:
        "Build the complete action-bound Kaval ProofPacket: compile atomic claims, run support and falsification research, preserve exact evidence and lineage, adjudicate scope/time/conflicts, and return ALLOW, REVIEW, or BLOCK. Apply the result through proof_gate so the configured shadow/block-only/bounded rollout policy remains authoritative.",
      inputSchema: {
        text: z.string().min(1).max(10_000),
        as_of: z
          .string()
          .datetime({ offset: true })
          .describe("RFC 3339 cutoff for what the action may rely on"),
        materiality: materialityInput.optional(),
        intended_action: z.string().min(1).max(10_000).optional(),
        reversibility: reversibilityInput.optional(),
        false_allow_cost_usd: z.number().finite().nonnegative().optional(),
        false_block_cost_usd: z.number().finite().nonnegative().optional(),
        wait_cost_usd: z.number().finite().nonnegative().optional(),
        domain: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            "descriptive metadata only; never expands calibration support",
          ),
        subject_hint: z.string().min(1).max(1_000).optional(),
        jurisdiction: z.string().min(1).max(256).optional(),
        geography: z.string().min(1).max(256).optional(),
        units: z.string().min(1).max(128).optional(),
        context: z.string().min(1).max(4_000).optional(),
        aliases: z.array(z.string().min(1).max(512)).max(50).optional(),
        origin_urls: z.array(httpUrlInput).max(20).optional(),
        record: z
          .object({
            system: z.string(),
            id: z.string(),
            table: z.string().optional(),
          })
          .strict()
          .optional(),
        record_field: z.string().min(1).max(512).optional(),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, { signal }) =>
      safe(() => client.audit(args, transportOptions(idempotency_key, signal))),
  );

  server.registerTool(
    "proof_gate",
    {
      description:
        "Apply an existing durable proof to the exact action without repeating research. Supply exactly one of proof_id or proof_key. Only when enforcement.controlApplied is true may Kaval control execution; then honor executionAllowed exactly. controlApplied false is shadow telemetry and must not control the customer's action. If enforcement is absent, fail closed unless state is current and decision.decision is ALLOW.",
      inputSchema: {
        proof_id: z.string().min(1).max(512).optional(),
        proof_key: z.string().min(1).max(512).optional(),
        expected_dependency_versions: z
          .record(z.string().min(1), z.string().min(1))
          .optional(),
        material_claim_ids: z.array(z.string().min(1).max(512)).min(1).max(100),
        threshold: z.object(decisionThresholdInput).strict(),
        action: z.object(actionContextInput).strict(),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, { signal }) => {
      if ((args.proof_id === undefined) === (args.proof_key === undefined)) {
        return toolError({
          error: "bad_request",
          message: "provide exactly one of proof_id or proof_key",
        });
      }
      return safe(() =>
        client.gateAction(
          args as Parameters<Kaval["gateAction"]>[0],
          transportOptions(idempotency_key, signal),
        ),
      );
    },
  );

  server.registerTool(
    "report_outcome",
    {
      description:
        "Report what actually happened for a prior check (by id) so the service can calibrate.",
      inputSchema: {
        id: z.string(),
        kind: z.enum([
          "current_later_contradicted",
          "stale_caught_real",
          "stale_was_false_alarm",
          "relied_and_correct",
        ]),
        note: z.string().optional(),
      },
    },
    async (args) => safe(() => client.reportOutcome(args)),
  );

  return server;
}
