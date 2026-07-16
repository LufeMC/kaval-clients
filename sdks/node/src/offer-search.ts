/** Public REST request and response types for the current review-only Offer Search surface. */

export type ProductIdentifierScheme =
  "gtin" | "upc" | "ean" | "isbn" | "mpn" | "manufacturer_sku" | "model";

export interface ProductIdentifier {
  scheme: ProductIdentifierScheme;
  value: string;
  issuer?: string;
}

export interface ProductAttribute {
  key: string;
  value: string | number | boolean;
  unit?: string;
}

export interface PackSpec {
  count: number;
  units_per_item?: number;
  unit?: string;
}

export interface ProductTarget {
  schema_revision: number;
  family?: { brand?: string; name?: string; category?: string };
  name?: string;
  identifiers: ProductIdentifier[];
  attributes: ProductAttribute[];
  pack?: PackSpec;
}

export interface ProductFamily {
  schema_revision: number;
  family_id: string;
  brand: string;
  name: string;
  category?: string;
  identifiers: ProductIdentifier[];
}

export interface ProductVariant {
  schema_revision: number;
  variant_id: string;
  family: ProductFamily;
  name: string;
  identifiers: ProductIdentifier[];
  attributes: ProductAttribute[];
  pack: PackSpec;
}

export type ProductCondition =
  | "new"
  | "open_box"
  | "refurbished"
  | "used_like_new"
  | "used_good"
  | "used_acceptable"
  | "unknown";

export type SellerKind =
  | "brand_direct"
  | "authorized_retailer"
  | "marketplace"
  | "independent_retailer"
  | "unknown";

interface SubstitutionBase {
  rule_id: string;
  rationale: string;
  maximum_materiality: "low" | "medium" | "high" | "critical";
}

export type PermittedSubstitution =
  | (SubstitutionBase & {
      kind: "attribute";
      key: string;
      requested_value: string | number | boolean;
      permitted_value: string | number | boolean;
      requested_unit?: string;
      permitted_unit?: string;
    })
  | (SubstitutionBase & {
      kind: "pack";
      requested: PackSpec;
      permitted: PackSpec;
    })
  | (SubstitutionBase & {
      kind: "condition";
      requested: ProductCondition;
      permitted: ProductCondition;
    })
  | (SubstitutionBase & {
      kind: "variant";
      requested_identifiers: ProductIdentifier[];
      permitted_variant_id: string;
      permitted_identifiers: ProductIdentifier[];
    });

export interface OfferSearchInput {
  schema_revision: number;
  request_id: string;
  raw_description: string;
  target: ProductTarget;
  requested_condition: ProductCondition;
  destination: {
    country_code: string;
    region?: string;
    postal_code?: string;
  };
  match_policy: {
    identity_requirement:
      "shared_identifier" | "shared_identifier_or_complete_attributes";
    required_identifier_schemes: ProductIdentifierScheme[];
    required_attribute_keys: string[];
    permitted_substitutions: PermittedSubstitution[];
  };
  seller_policy: {
    allowed_seller_ids: string[];
    blocked_seller_ids: string[];
    allowed_kinds: SellerKind[];
    require_authorized: boolean;
  };
  destination_policy: {
    require_eligible: boolean;
    require_exact_region: boolean;
    require_exact_postal_code: boolean;
  };
  price_policy: {
    currency: string;
    maximum_landed_total_minor?: number;
    require_complete_landed_total: boolean;
    allow_estimated_components: boolean;
    allow_member_price: boolean;
    allow_subscription_price: boolean;
    allow_coupon_price: boolean;
    allow_installment_display: boolean;
    allow_trade_in_price: boolean;
  };
  source_policy: {
    allowed_source_ids: string[];
    blocked_source_ids: string[];
    require_origin_evidence: boolean;
  };
  intended_action: {
    description: string;
    materiality: "low" | "medium" | "high" | "critical";
    reversibility: "reversible" | "partially_reversible" | "irreversible";
  };
  freshness_maximum_age_ms: number;
  max_results: number;
  minimum_unique_sellers: number;
  deadline_ms: number;
  maximum_cost_micro_usd: number;
  maximum_search_calls: number;
  maximum_fetches: number;
}

export interface Money {
  amount_minor: number;
  currency: string;
}

export interface OriginSourceValueLocator {
  object_role:
    | "product"
    | "variant_parent"
    | "offer"
    | "embedded_product"
    | "product_meta"
    | "artifact_origin";
  path: string;
  raw_value_digest: `sha256:${string}`;
}

export interface OriginFieldProvenance {
  field_path: string;
  source_values: OriginSourceValueLocator[];
  transformations: Array<
    | "trim_text"
    | "canonicalize_identifier"
    | "construct_product_variant"
    | "normalize_pack"
    | "resolve_public_url"
    | "decimal_currency_to_minor_units"
    | "normalize_availability"
    | "normalize_condition"
    | "normalize_seller_name"
  >;
}

export interface ExtractedOriginOffer {
  evidence_kind: "json_ld" | "embedded_product_json" | "product_meta";
  source_block_index: number;
  jsonld_product_index: number;
  jsonld_offer_index: number | null;
  variant: ProductVariant;
  title: string;
  purchase_url: string;
  seller_name: string | null;
  condition: ProductCondition;
  availability: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  item_price: Money | null;
  destination_eligibility: "unknown";
  landed_price_complete: false;
  extraction_gaps: string[];
  field_provenance?: OriginFieldProvenance[];
}

export type OfferConflictCode =
  | "FAMILY_BRAND_CONFLICT"
  | "FAMILY_NAME_CONFLICT"
  | "IDENTIFIER_CONFLICT"
  | "IDENTIFIER_AMBIGUOUS"
  | "IDENTIFIER_MISSING"
  | "ATTRIBUTE_CONFLICT"
  | "ATTRIBUTE_MISSING"
  | "PACK_CONFLICT"
  | "PACK_INCOMPLETE"
  | "CONDITION_CONFLICT"
  | "SELLER_BLOCKED"
  | "SELLER_NOT_ALLOWED"
  | "SELLER_KIND_NOT_ALLOWED"
  | "SELLER_AUTHORIZATION_REQUIRED"
  | "DESTINATION_CONFLICT"
  | "DESTINATION_INELIGIBLE"
  | "DESTINATION_UNKNOWN"
  | "CURRENCY_CONFLICT"
  | "PRICE_LIMIT_EXCEEDED"
  | "PRICE_INCOMPLETE"
  | "MATERIAL_EVIDENCE_MISSING"
  | "OBSERVATION_EXPIRED";

export interface OfferMatchAssessment {
  state:
    | "exact"
    | "permitted_substitute"
    | "ambiguous"
    | "conflict"
    | "insufficient_identity";
  conflict_codes: OfferConflictCode[];
  matched_identifier_schemes: ProductIdentifierScheme[];
  matched_attribute_keys: string[];
  applied_substitutions: PermittedSubstitution[];
  explanation: string;
}

export interface OfferOriginEvidence {
  kind: ExtractedOriginOffer["evidence_kind"];
  /** Exact acquisition artifact whose bytes produced content_digest. */
  artifact?: "static_http_body" | "rendered_page";
  /** Renderer snapshot or deployment receipt when artifact is rendered_page. */
  version_receipt?: string | null;
  content_digest: `sha256:${string}`;
  source_block_index: number;
  jsonld_product_index: number;
  jsonld_offer_index: number | null;
}

export interface LiveOfferSearchCandidate {
  candidate_id: `sha256:${string}`;
  origin_url: string;
  source_id: string;
  discovered_by: string[];
  discovery_metadata: Array<{ provider: string; title: string | null }>;
  origin_evidence: OfferOriginEvidence;
  origin_offer: ExtractedOriginOffer;
  identity: OfferMatchAssessment;
  /** Current shadow output can only be queued for review or rejected. */
  disposition: "review" | "rejected";
  gaps: string[];
  reason_codes: string[];
  /** Destination-aware checkout evidence. Its action remains REVIEW-only. */
  checkout?: CommerceCheckoutVerification;
}

export interface LiveOfferSearchRejectedExplanation {
  candidate_id: LiveOfferSearchCandidate["candidate_id"];
  origin_url: string;
  contender: false;
  disposition: "rejected";
  identity_state: OfferMatchAssessment["state"];
  reason_codes: string[];
  gaps: string[];
  observed_price: {
    amount_minor: number;
    currency: string;
    basis: "complete_landed_total" | "item_price";
  } | null;
  cheaper_than_candidate_ids: Array<LiveOfferSearchCandidate["candidate_id"]>;
}

export type ProductCatalogIdentityAuthority =
  "manufacturer_catalog" | "authorized_registry" | "merchant_catalog";

export type ProductCatalogRecordReasonCode =
  | "RECORD_SUPPORTS_IDENTITY"
  | "ANALYSIS_BINDING_MISMATCH"
  | "RECORD_DIGEST_INVALID"
  | "SOURCE_RIGHTS_NOT_ALLOWED"
  | "RECORD_NOT_CURRENT"
  | "MATCHED_CLUE_INVALID"
  | "IDENTITY_BINDING_NOT_IN_VARIANT"
  | "EXPLICIT_CONSTRAINT_CONFLICT";

export interface ProductCatalogIdentityRecordAssessment {
  record_digest: `sha256:${string}`;
  source_id: string;
  source_version_id: string;
  independence_group: string;
  authority: ProductCatalogIdentityAuthority;
  content_digest: `sha256:${string}`;
  identity_binding_key: string;
  disposition: "supports_identity" | "rejected";
  reason_codes: ProductCatalogRecordReasonCode[];
}

export type ProductNameAttributeKey =
  | "bundle"
  | "capacity"
  | "color"
  | "compatibility"
  | "condition"
  | "edition"
  | "material"
  | "quantity"
  | "size"
  | "unit";

export interface ProductNameModelProposalAssessment {
  proposal_id: `sha256:${string}`;
  proposal_digest: `sha256:${string}`;
  analysis_input_digest: `sha256:${string}`;
  authority: "non_authoritative";
  exact_identity: false;
  material_state_changed: false;
  aliases: Array<{
    kind:
      | "catalog_search_alias"
      | "brand_alias"
      | "family_alias"
      | "manufacturer_alias";
    value: string;
    disposition: "discovery_only";
  }>;
  attributes: Array<{
    key: ProductNameAttributeKey;
    value: string;
    unit?: string;
    disposition: "corroborated_constraint" | "unverified_candidate";
  }>;
  reason_codes: Array<
    | "MODEL_PROPOSAL_NON_AUTHORITATIVE"
    | "ALIASES_DISCOVERY_ONLY"
    | "ATTRIBUTES_REQUIRE_SOURCE_VALIDATION"
    | "EXACT_IDENTITY_WITHHELD"
  >;
}

export type ProductCatalogResolutionReasonCode =
  | "CATALOG_EXACT_IDENTITY_RESOLVED"
  | "CATALOG_INPUT_AMBIGUOUS"
  | "CATALOG_IDENTITY_CONFLICT"
  | "CATALOG_INDEPENDENT_SUPPORT_INSUFFICIENT"
  | "CATALOG_AUTHORITATIVE_SOURCE_MISSING"
  | "CATALOG_RECORDS_UNUSABLE"
  | "MODEL_PROPOSALS_NON_AUTHORITATIVE";

export interface ProductCatalogIdentityResolution {
  schema_revision: 1;
  resolver_version: "catalog-identity/v1";
  analysis_input_digest: `sha256:${string}`;
  resolution_state: "exact_variant" | "ambiguous" | "insufficient_identity";
  exact_identity: boolean;
  resolved_target: ProductTarget | null;
  resolved_variant: ProductVariant | null;
  supporting_record_digests: Array<`sha256:${string}`>;
  record_assessments: ProductCatalogIdentityRecordAssessment[];
  model_proposal_assessments: ProductNameModelProposalAssessment[];
  reason_codes: ProductCatalogResolutionReasonCode[];
  resolution_digest: `sha256:${string}`;
}

export type CommerceSourceFamily =
  | "catalog"
  | "merchant_feed"
  | "retailer_origin"
  | "shopping_search"
  | "open_web";

export interface CommerceCheckoutResolverDescriptor {
  schema_revision: 1;
  source_id: string;
  adapter_revision: string;
  execution_mode: "recorded_fixture" | "live";
  estimated_cost_micro_usd: number;
}

export interface CommerceCheckoutDeliveryPromise {
  certainty: "guaranteed" | "estimated";
  earliest_at: string;
  latest_at: string;
}

export interface CommerceCheckoutObservation {
  destination_eligibility: "eligible" | "ineligible" | "unknown";
  availability: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  seller_authorized: boolean | null;
  /** Omitted for adapters that predate delivery promises; null means checked but unbounded. */
  delivery_promise?: CommerceCheckoutDeliveryPromise | null;
  item_price: Money | null;
  shipping_price: Money | null;
  tax_price: Money | null;
  mandatory_fees: Money | null;
  declared_landed_total: Money | null;
  quote_id: string | null;
  evidence_digest: `sha256:${string}`;
  observed_at: string;
  expires_at: string;
}

export type LandedPriceValidationReason =
  | "EXPECTED_CURRENCY_INVALID"
  | "ITEM_PRICE_MISSING"
  | "SHIPPING_PRICE_MISSING"
  | "TAX_PRICE_MISSING"
  | "MANDATORY_FEES_MISSING"
  | "DECLARED_LANDED_TOTAL_MISSING"
  | "MONEY_VALUE_INVALID"
  | "PRICE_CURRENCY_CONFLICT"
  | "LANDED_TOTAL_OVERFLOW"
  | "LANDED_TOTAL_ARITHMETIC_MISMATCH";

export interface LandedPriceValidation {
  state: "complete" | "incomplete" | "invalid" | "inconsistent";
  expected_currency: string;
  calculated_landed_total: Money | null;
  reason_codes: LandedPriceValidationReason[];
}

export interface CommerceCheckoutVerification {
  status: "verified" | "review_required" | "rejected" | "operational_failure";
  resolver: CommerceCheckoutResolverDescriptor | null;
  request_digest: `sha256:${string}`;
  observation: CommerceCheckoutObservation | null;
  landed_price_validation: LandedPriceValidation;
  action: {
    state: "REVIEW";
    action_authorized: false;
    reason_codes: string[];
  };
  actual_cost_micro_usd: number;
  version_receipt: string | null;
  operational_error_code:
    | "UPSTREAM_UNAVAILABLE"
    | "DESTINATION_UNSUPPORTED"
    | "MALFORMED_RESPONSE"
    | "RIGHTS_REVOKED"
    | "CANCELLED"
    | null;
}

export interface CommercePlannedSource {
  source_id: string;
  family: CommerceSourceFamily;
  call_kind: "search" | "fetch";
  independence_group: string;
  estimated_cost_micro_usd: number;
  field_guarantees: string[];
  health_state: "healthy" | "degraded";
  concurrency_limit: number;
  supports_cancellation: boolean;
  role: "structured_acquisition" | "origin_verification" | "discovery_tail";
  winner_must_be_origin_verified: boolean;
}

export interface CommerceSourcePlan {
  schema_revision: number;
  request_id: string;
  request_digest: `sha256:${string}`;
  supplier_registry_schema_revision: number;
  supplier_registry_digest: `sha256:${string}`;
  waves: Array<{
    wave: number;
    purpose:
      | "structured_authoritative"
      | "retailer_origin"
      | "unresolved_identity_and_coverage";
    sources: CommercePlannedSource[];
  }>;
  receipt: {
    schema_revision: number;
    request_id: string;
    coverage_claim: "bounded_not_comprehensive";
    name_only_target: boolean;
    minimum_independent_families_required: number;
    planned_independent_families: CommerceSourceFamily[];
    planned_independence_groups: string[];
    independence_requirement_met: boolean;
    origin_verification_required: true;
    origin_verification_planned: boolean;
    origin_verification_source_ids: string[];
    eligible_supplier_count_before_budget: number;
    total_planned_cost_micro_usd: number;
    total_planned_search_calls: number;
    total_planned_fetches: number;
    exclusions: Array<{
      source_id: string;
      family: CommerceSourceFamily;
      call_kind: "search" | "fetch";
      estimated_cost_micro_usd: number;
      reason: string;
    }>;
  };
}

export interface CommerceAcquisitionSourceLedgerEntry {
  source_id: string;
  family: CommerceSourceFamily;
  disposition:
    | "succeeded"
    | "failed"
    | "cancelled"
    | "prohibited"
    | "deferred"
    | "unsearched";
  reason_code: string;
}

export interface CommerceAcquisitionRunReport {
  schema_revision: 1;
  request_digest: `sha256:${string}`;
  plan: CommerceSourcePlan;
  /** Full planner state is retained for audit/replay and may add fields within schema revision 1. */
  state: Readonly<Record<string, unknown>>;
  stop: {
    reason: Exclude<OfferSearchStopReason, "sufficient_offers">;
    explanation: string;
  };
  calls: Array<Readonly<Record<string, unknown>>>;
  records: Array<Readonly<Record<string, unknown>>>;
  source_ledger: CommerceAcquisitionSourceLedgerEntry[];
  coverage: {
    claim: "bounded_not_comprehensive";
    attempted_source_families: CommerceSourceFamily[];
    unique_candidate_keys: number;
    unique_sellers: number;
    unsearched_source_count: number;
    prohibited_source_count: number;
    failed_source_count: number;
  };
  deduplication: {
    source_records: number;
    unique_urls: number;
    unique_variants: number;
    unique_sellers: number;
    unique_listings: number;
    unique_offers: number;
    independent_information_origins: number;
  };
  replay_digest: `sha256:${string}`;
}

export interface LiveOfferSearchAcquisitionTrace {
  coverage_claim: "bounded_not_comprehensive";
  plan: CommerceSourcePlan;
  plan_digest: `sha256:${string}`;
  source_ledger: CommerceAcquisitionSourceLedgerEntry[];
  adapter_run?: CommerceAcquisitionRunReport;
}

/** Digests that bind one persisted evidence generation to one exact downstream action slot. */
export interface CommerceActionBinding {
  action_slot_key: string;
  action_input_digest: `sha256:${string}`;
  action_consequence_digest: `sha256:${string}`;
}

export type CommerceActionTimeGateState =
  | "current_review_only"
  | "not_found"
  | "stale_generation"
  | "binding_mismatch"
  | "expired"
  | "invalidated"
  | "refresh_required"
  | "source_revoked"
  | "retention_unavailable"
  | "integrity_failed"
  | "operational_failure";

/** Exact body accepted by POST /v1/search-offers/gate. Tenant identity is server-derived. */
export interface CommerceActionTimeGateInput {
  dependency_id: string;
  generation_id: string;
  generation_number: number;
  generation_digest: `sha256:${string}`;
  action_binding: CommerceActionBinding;
}

/**
 * A final-fence read of one persisted offer generation. Commerce remains review-only: even a
 * current generation returns REVIEW with permission withheld.
 */
export interface CommerceActionTimeGateResult {
  state: CommerceActionTimeGateState;
  disposition: "REVIEW";
  permission: "withheld";
  reason_codes: string[];
  checked_at: string;
  final_fence_checked: boolean;
  generation_id?: string;
  generation_number?: number;
  generation_digest?: `sha256:${string}`;
  expires_at?: string;
}

export type CommerceOfferSearchLifecycle =
  | {
      persistence: "persisted";
      dependency_id: string;
      generation_id: string;
      generation_number: number;
      generation_digest: `sha256:${string}`;
      selected_candidate_id: `sha256:${string}`;
      expires_at: string;
      action_binding: CommerceActionBinding;
      action_time_gate: CommerceActionTimeGateResult;
    }
  | {
      persistence: "not_created";
      reason_codes: string[];
      action_time_gate: Pick<
        CommerceActionTimeGateResult,
        | "disposition"
        | "permission"
        | "reason_codes"
        | "checked_at"
        | "final_fence_checked"
      > & { state: "not_found" };
    };

export type CommerceSourceAttemptErrorCode =
  | "INVALID_DISCOVERY_URL"
  | "DISCOVERY_IDENTIFIER_MISMATCH"
  | "ORIGIN_BLOCKED"
  | "ORIGIN_HTTP_ERROR"
  | "ORIGIN_JSONLD_INVALID"
  | "ORIGIN_TIMEOUT"
  | "ORIGIN_UNAVAILABLE"
  | "SEARCH_UNAVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "DEADLINE_REACHED"
  | "CANCELLED"
  | "COVERAGE_SATISFIED";

export interface CommerceLiveSourceAttempt {
  sequence: number;
  kind: "search" | "origin_fetch";
  call_attempted: boolean;
  source_id: string;
  provider: string | null;
  query: string | null;
  url: string | null;
  outcome:
    "succeeded" | "empty" | "failed" | "blocked" | "skipped" | "cancelled";
  error_code: CommerceSourceAttemptErrorCode | null;
  latency_ms: number;
  cost_micro_usd: number;
  reuse: "executed" | "tenant_private_cache";
  avoided_cost_micro_usd: number;
  result_count: number | null;
  http_status: number | null;
  bytes_received: number | null;
}

export type OfferSearchStopReason =
  | "coverage_satisfied"
  | "sufficient_offers"
  | "source_exhausted"
  | "budget_exhausted"
  | "deadline_reached"
  | "cancelled"
  | "upstream_unavailable"
  | "policy_blocked";

export interface LiveOfferSearchResult {
  schema_revision: 2;
  request_id: string;
  request_digest: `sha256:${string}`;
  /** Digest after verified catalog resolution enriches a sparse target. */
  effective_request_digest?: `sha256:${string}`;
  status: "complete" | "partial" | "failed";
  /** Offer Search is shadow-only and cannot authorize a quote or purchase. */
  action: {
    state: "NEEDS_REVIEW" | "NO_RELIABLE_OFFER";
    reason_codes: string[];
  };
  stop_reason: OfferSearchStopReason;
  query: string | null;
  candidates: LiveOfferSearchCandidate[];
  /** Rejected observations remain explainable but never enter contender ranking. */
  rejected_explanations?: LiveOfferSearchRejectedExplanation[];
  source_attempts: CommerceLiveSourceAttempt[];
  receipt: {
    search_calls: number;
    fetch_calls: number;
    providers_configured: number;
    providers_succeeded: number;
    cost_micro_usd: number;
    cost_basis: "reserved_ceiling";
    provider_estimated_cost_micro_usd: number | null;
    provider_estimated_cost_reported_search_calls: number;
    discovery_cache_hits: number;
    cost_avoided_micro_usd: number;
    elapsed_ms: number;
  };
  started_at: string;
  completed_at: string;
  /** Auditable rights, coverage, and attempted-source trace. */
  acquisition?: LiveOfferSearchAcquisitionTrace;
  /** Verified structured-catalog resolution, when the resolver was evaluated. */
  identity_resolution?: ProductCatalogIdentityResolution;
  /** Present only when the hosted server has a configured durable commerce lifecycle. */
  lifecycle?: CommerceOfferSearchLifecycle;
}

export type OfferSearchProgressStage =
  | "accepted"
  | "acquisition"
  | "verification"
  | "coverage"
  | "candidate_provisional"
  | "candidate"
  | "warning";

interface OfferSearchProgressEventBase {
  sequence: number;
  at: string;
  request_id: string;
  message: string;
  authority: "research_only";
  action_state: "REVIEW";
  details: Readonly<Record<string, unknown>>;
}

export interface OfferSearchStageEvent extends OfferSearchProgressEventBase {
  type: Exclude<OfferSearchProgressStage, "candidate_provisional">;
}

/** Origin-verified research observed before final selection and lifecycle persistence. */
export interface OfferSearchProvisionalCandidateEvent extends OfferSearchProgressEventBase {
  type: "candidate_provisional";
  details: Readonly<{
    request_digest: `sha256:${string}`;
    origin_sequence: number;
    publication_state: "provisional";
    durable: false;
    actionable: false;
    permission: "withheld";
    final_inclusion: "not_yet_determined";
    candidate: LiveOfferSearchCandidate;
  }>;
}

export type OfferSearchProgressEvent =
  OfferSearchStageEvent | OfferSearchProvisionalCandidateEvent;

/** A same-key completed-operation replay performs no new provider work. */
export interface OfferSearchReplayEvent {
  type: "replay";
  sequence: number;
  replayed_at: string;
  request_id: string;
  request_digest: `sha256:${string}`;
  authority: "research_only";
  action_state: "REVIEW";
}

export type OfferSearchStreamEvent =
  | OfferSearchProgressEvent
  | OfferSearchReplayEvent
  | { type: "final"; sequence: number; result: LiveOfferSearchResult };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const COMMERCE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ACTION_TIME_GATE_STATES = new Set<CommerceActionTimeGateState>([
  "current_review_only",
  "not_found",
  "stale_generation",
  "binding_mismatch",
  "expired",
  "invalidated",
  "refresh_required",
  "source_revoked",
  "retention_unavailable",
  "integrity_failed",
  "operational_failure",
]);

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && COMMERCE_DIGEST.test(value);
}

function actionBinding(value: unknown): value is CommerceActionBinding {
  const binding = record(value);
  return (
    typeof binding?.["action_slot_key"] === "string" &&
    binding["action_slot_key"].length > 0 &&
    digest(binding["action_input_digest"]) &&
    digest(binding["action_consequence_digest"]) &&
    binding["action_input_digest"] !== binding["action_consequence_digest"]
  );
}

/** Detect permission-shaped fields anywhere in a commerce response, including future extensions. */
function containsCommerceAuthority(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCommerceAuthority);
  const current = record(value);
  if (!current) return false;

  for (const [key, nested] of Object.entries(current)) {
    const authorityToken =
      typeof nested === "string" ? nested.toUpperCase() : undefined;
    if (
      ((key === "safe_to_quote" ||
        key === "action_authorized" ||
        key === "execution_allowed" ||
        key === "executionAllowed" ||
        key === "act") &&
        nested === true) ||
      (key === "permission" && nested !== "withheld") ||
      ((key === "decision" || key === "disposition" || key === "state") &&
        (authorityToken === "ALLOW" ||
          authorityToken === "BLOCK" ||
          authorityToken === "SAFE_TO_QUOTE")) ||
      containsCommerceAuthority(nested)
    ) {
      return true;
    }
  }
  return false;
}

const OFFER_SEARCH_PROGRESS_STAGES = new Set<OfferSearchProgressStage>([
  "accepted",
  "acquisition",
  "verification",
  "coverage",
  "candidate_provisional",
  "candidate",
  "warning",
]);

/** Validate a public progressive event before exposing it to an agent. */
export function reviewOnlyOfferSearchProgressEvent(
  value: unknown,
): OfferSearchProgressEvent {
  const event = record(value);
  if (
    !event ||
    !OFFER_SEARCH_PROGRESS_STAGES.has(
      event["type"] as OfferSearchProgressStage,
    ) ||
    !Number.isInteger(event["sequence"]) ||
    (event["sequence"] as number) < 0 ||
    typeof event["at"] !== "string" ||
    typeof event["request_id"] !== "string" ||
    typeof event["message"] !== "string" ||
    event["authority"] !== "research_only" ||
    event["action_state"] !== "REVIEW" ||
    record(event["details"]) === null ||
    containsCommerceAuthority(event)
  ) {
    throw new TypeError(
      "Offer Search stream returned an invalid or authority-bearing progress event",
    );
  }
  if (event["type"] === "candidate_provisional") {
    const details = record(event["details"]);
    const candidate = record(details?.["candidate"]);
    if (
      !details ||
      !digest(details["request_digest"]) ||
      !Number.isInteger(details["origin_sequence"]) ||
      (details["origin_sequence"] as number) < 0 ||
      details["publication_state"] !== "provisional" ||
      details["durable"] !== false ||
      details["actionable"] !== false ||
      details["permission"] !== "withheld" ||
      details["final_inclusion"] !== "not_yet_determined" ||
      !candidate ||
      !digest(candidate["candidate_id"]) ||
      typeof candidate["origin_url"] !== "string" ||
      typeof candidate["source_id"] !== "string" ||
      (candidate["disposition"] !== "review" &&
        candidate["disposition"] !== "rejected")
    ) {
      throw new TypeError(
        "Offer Search stream returned an invalid provisional candidate event",
      );
    }
  }
  return value as OfferSearchProgressEvent;
}

/** Validate the content-free event emitted for a durable same-key replay. */
export function reviewOnlyOfferSearchReplayEvent(
  value: unknown,
  expectedRequestId?: string,
): OfferSearchReplayEvent {
  const event = record(value);
  if (
    !event ||
    event["type"] !== "replay" ||
    !Number.isInteger(event["sequence"]) ||
    (event["sequence"] as number) < 0 ||
    typeof event["replayed_at"] !== "string" ||
    typeof event["request_id"] !== "string" ||
    event["request_id"].length === 0 ||
    !digest(event["request_digest"]) ||
    (expectedRequestId !== undefined &&
      event["request_id"] !== expectedRequestId) ||
    event["authority"] !== "research_only" ||
    event["action_state"] !== "REVIEW" ||
    containsCommerceAuthority(event)
  ) {
    throw new TypeError(
      "Offer Search stream returned an invalid or authority-bearing replay event",
    );
  }
  return value as OfferSearchReplayEvent;
}

/** Reject authority drift and validate the exact public action-time commerce gate response. */
export function reviewOnlyCommerceActionTimeGateResult(
  value: unknown,
  expectedGeneration?: Pick<
    CommerceActionTimeGateInput,
    "generation_id" | "generation_number" | "generation_digest"
  >,
): CommerceActionTimeGateResult {
  const gate = record(value);
  if (
    !gate ||
    !ACTION_TIME_GATE_STATES.has(
      gate["state"] as CommerceActionTimeGateState,
    ) ||
    gate["disposition"] !== "REVIEW" ||
    gate["permission"] !== "withheld" ||
    !stringArray(gate["reason_codes"]) ||
    typeof gate["checked_at"] !== "string" ||
    typeof gate["final_fence_checked"] !== "boolean" ||
    (gate["generation_id"] !== undefined &&
      typeof gate["generation_id"] !== "string") ||
    (gate["generation_number"] !== undefined &&
      (!Number.isInteger(gate["generation_number"]) ||
        (gate["generation_number"] as number) <= 0)) ||
    (gate["generation_digest"] !== undefined &&
      !digest(gate["generation_digest"])) ||
    (gate["expires_at"] !== undefined &&
      typeof gate["expires_at"] !== "string") ||
    containsCommerceAuthority(gate)
  ) {
    throw new TypeError(
      "Offer Search action-time gate returned an invalid or authority-bearing response; commerce permission must remain withheld",
    );
  }
  if (
    gate["state"] === "current_review_only" &&
    (gate["final_fence_checked"] !== true ||
      typeof gate["generation_id"] !== "string" ||
      gate["generation_id"].length === 0 ||
      !Number.isInteger(gate["generation_number"]) ||
      (gate["generation_number"] as number) <= 0 ||
      !digest(gate["generation_digest"]) ||
      (expectedGeneration !== undefined &&
        (gate["generation_id"] !== expectedGeneration.generation_id ||
          gate["generation_number"] !== expectedGeneration.generation_number ||
          gate["generation_digest"] !== expectedGeneration.generation_digest)))
  ) {
    throw new TypeError(
      "Offer Search action-time gate returned an invalid or authority-bearing response; commerce permission must remain withheld",
    );
  }
  return value as CommerceActionTimeGateResult;
}

function commerceLifecycle(
  value: unknown,
  candidates: unknown[],
): CommerceOfferSearchLifecycle {
  const lifecycle = record(value);
  if (lifecycle?.["persistence"] === "persisted") {
    if (
      typeof lifecycle["dependency_id"] !== "string" ||
      typeof lifecycle["generation_id"] !== "string" ||
      !Number.isInteger(lifecycle["generation_number"]) ||
      (lifecycle["generation_number"] as number) <= 0 ||
      !digest(lifecycle["generation_digest"]) ||
      !digest(lifecycle["selected_candidate_id"]) ||
      typeof lifecycle["expires_at"] !== "string" ||
      !actionBinding(lifecycle["action_binding"])
    ) {
      throw new TypeError("Offer Search returned invalid lifecycle metadata");
    }
    const selectedCandidateMatches = candidates.filter(
      (candidate) =>
        record(candidate)?.["candidate_id"] ===
        lifecycle["selected_candidate_id"],
    ).length;
    if (selectedCandidateMatches !== 1) {
      throw new TypeError("Offer Search returned invalid lifecycle metadata");
    }
    const expectedGeneration = {
      generation_id: lifecycle["generation_id"],
      generation_number: lifecycle["generation_number"],
      generation_digest: lifecycle["generation_digest"],
    } as Pick<
      CommerceActionTimeGateInput,
      "generation_id" | "generation_number" | "generation_digest"
    >;
    const gate = reviewOnlyCommerceActionTimeGateResult(
      lifecycle["action_time_gate"],
      expectedGeneration,
    );
    if (
      (gate.generation_id !== undefined &&
        gate.generation_id !== expectedGeneration.generation_id) ||
      (gate.generation_number !== undefined &&
        gate.generation_number !== expectedGeneration.generation_number) ||
      (gate.generation_digest !== undefined &&
        gate.generation_digest !== expectedGeneration.generation_digest)
    ) {
      throw new TypeError("Offer Search returned invalid lifecycle metadata");
    }
    return value as CommerceOfferSearchLifecycle;
  }

  if (
    lifecycle?.["persistence"] === "not_created" &&
    stringArray(lifecycle["reason_codes"])
  ) {
    const gate = reviewOnlyCommerceActionTimeGateResult(
      lifecycle["action_time_gate"],
    );
    if (gate.state === "not_found") {
      return value as CommerceOfferSearchLifecycle;
    }
  }
  throw new TypeError("Offer Search returned invalid lifecycle metadata");
}

/** Reject a drifted commerce response before a caller can mistake shadow research for permission. */
export function reviewOnlyOfferSearchResult(
  value: unknown,
  expectedRequestId?: string,
): LiveOfferSearchResult {
  const result = record(value);
  if (
    typeof result?.["request_id"] !== "string" ||
    result["request_id"].length === 0 ||
    !digest(result["request_digest"])
  ) {
    throw new TypeError(
      "Offer Search returned an invalid request ID or digest binding",
    );
  }
  if (
    expectedRequestId !== undefined &&
    result["request_id"] !== expectedRequestId
  ) {
    throw new TypeError("Offer Search result is bound to another request");
  }
  const action = record(result?.["action"]);
  const candidates = result?.["candidates"];
  if (
    result?.["schema_revision"] !== 2 ||
    result?.["decision"] === "ALLOW" ||
    result?.["safe_to_quote"] === true ||
    (action?.["state"] !== "NEEDS_REVIEW" &&
      action?.["state"] !== "NO_RELIABLE_OFFER") ||
    action?.["decision"] === "ALLOW" ||
    action?.["safe_to_quote"] === true ||
    containsCommerceAuthority(result) ||
    !Array.isArray(candidates) ||
    candidates.some((candidate) => {
      const candidateRecord = record(candidate);
      const disposition = candidateRecord?.["disposition"];
      return (
        (disposition !== "review" && disposition !== "rejected") ||
        candidateRecord?.["safe_to_quote"] === true
      );
    })
  ) {
    throw new TypeError(
      "Offer Search returned a non-review-only response; shadow results cannot authorize an action",
    );
  }
  if (result["lifecycle"] !== undefined) {
    commerceLifecycle(result["lifecycle"], candidates);
  }
  return value as LiveOfferSearchResult;
}
