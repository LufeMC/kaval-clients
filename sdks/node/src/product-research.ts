/** Canonical public types and fail-closed guards for product-only research. */

import type {
  Money,
  PackSpec,
  ProductAttribute,
  ProductCondition,
  ProductIdentifier,
} from "./offer-search.js";

export type ProductResearchListingKind = "purchase" | "rental" | "quote_only";
export type ProductResearchObservedListingKind =
  ProductResearchListingKind | "unknown";
export type ProductResearchRelationship =
  | "primary_product"
  | "substitute"
  | "accessory"
  | "replacement_part"
  | "consumable"
  | "unknown";
export type ProductResearchMatchStatus = "exact" | "possible" | "conflicting";
export type ProductResearchVerificationTier =
  "origin_verified" | "structured_source_verified" | "discovered_unverified";
export type ProductResearchSourceFamily =
  | "catalog"
  | "merchant_feed"
  | "retailer_origin"
  | "shopping_search"
  | "open_web";

export interface ProductResearchInput {
  query: string;
  vertical?: string;
  market?: { country_code: string; preferred_currency: string };
  destination?: {
    country_code: string;
    region?: string;
    postal_code?: string;
  };
  filters?: {
    condition?: ProductCondition;
    pack?: PackSpec;
    brand?: string;
    model?: string;
    merchant_policy?: {
      allowed_domains: string[];
      blocked_domains: string[];
      marketplace_policy: "allow" | "exclude";
    };
    listing_kinds?: ProductResearchListingKind[];
    price?: {
      currency: string;
      minimum_amount_minor?: number;
      maximum_amount_minor?: number;
    };
  };
}

export type ProductResearchRequest = ProductResearchInput;

export type ProductResearchQueryClass =
  | "exact_identifier"
  | "brand_model_description"
  | "descriptive_product"
  | "commodity_local"
  | "rental_or_quote"
  | "ambiguous";

export interface ProductResearchClue {
  clue_id: string;
  kind:
    | "brand"
    | "manufacturer"
    | "family"
    | "model_like"
    | "identifier"
    | "dimension"
    | "gauge"
    | "thread"
    | "voltage"
    | "power_source"
    | "capacity"
    | "performance_rating"
    | "material"
    | "color"
    | "compatibility"
    | "included_component"
    | "pack"
    | "condition"
    | "purchase_intent"
    | "rental_intent"
    | "quote_intent"
    | "accessory_intent"
    | "location_sensitive"
    | "search_phrase";
  value: string;
  normalized_value: string;
  unit?: string;
  identifier?: ProductIdentifier;
  authority: "asserted" | "retrieval_only";
  provenance: {
    source: "query_text" | "request_filter" | "model_proposal";
    field: string;
    span?: {
      encoding: "utf16_code_unit";
      start: number;
      end: number;
      text: string;
    };
  };
}

export interface ProductResearchPlannedQuery {
  query_id: `sha256:${string}`;
  kind:
    | "literal"
    | "normalized"
    | "exact_identifier"
    | "brand_model"
    | "attribute"
    | "commercial"
    | "construction_expansion"
    | "rental"
    | "quote";
  text: string;
  rationale_codes: string[];
  authority: "discovery_only";
}

export interface ProductResearchQueryInterpretation {
  schema_revision: 1;
  interpreter_version: string;
  original_query: string;
  normalized_query: string;
  query_class: ProductResearchQueryClass;
  identity_state: "asserted_identifier" | "candidate_only" | "ambiguous";
  listing_intent: ProductResearchListingKind[];
  location_sensitive: boolean;
  accessory_ambiguous: boolean;
  clues: ProductResearchClue[];
  query_bundle: {
    version: "product-research-query/v1";
    queries: ProductResearchPlannedQuery[];
  };
}

export type ProductResearchPriceBasis =
  | { kind: "per_orderable_item" }
  | { kind: "per_pack"; pack_count: number }
  | { kind: "per_unit"; quantity: number; unit: string }
  | {
      kind: "rental_period";
      duration: number;
      unit: "hour" | "day" | "week" | "month";
    };

export type ProductResearchPriceQualifier =
  | "unknown"
  | "standard"
  | "list"
  | "sale"
  | "member"
  | "subscription"
  | "coupon"
  | "trade_in"
  | "installment"
  | "estimated";

export interface ProductResearchPrice {
  amount: Money;
  basis: ProductResearchPriceBasis;
  qualifiers: ProductResearchPriceQualifier[];
  shipping_included: boolean | null;
  tax_included: boolean | null;
}

export interface ProductResearchDeliveryPromise {
  certainty: "guaranteed" | "estimated";
  earliest_at: string;
  latest_at: string;
}

export interface ProductResearchDeliveryEvidence {
  checkout_status: "verified" | "review_required" | "rejected";
  research_request_digest: `sha256:${string}`;
  request_digest: `sha256:${string}`;
  origin_url: string;
  source_id: string;
  adapter_revision: string;
  execution_mode: "live" | "recorded_fixture";
  version_receipt: string;
  destination_eligibility: "eligible" | "ineligible" | "unknown";
  availability: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  seller_authorized: boolean | null;
  delivery_promise: ProductResearchDeliveryPromise | null;
  item_price: Money | null;
  shipping_price: Money | null;
  tax_price: Money | null;
  mandatory_fees: Money | null;
  declared_landed_total: Money | null;
  calculated_landed_total: Money | null;
  landed_price_state: "complete" | "incomplete" | "invalid" | "inconsistent";
  quote_id: string | null;
  evidence_digest: `sha256:${string}`;
  observed_at: string;
  expires_at: string;
}

export interface ProductResearchMerchant {
  display_name: string | null;
  origin_domain: string;
  seller_id?: string;
}

export interface ProductResearchOriginSourceValueLocator {
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

export interface ProductResearchOriginFieldLocator {
  field_path: string;
  source_values: ProductResearchOriginSourceValueLocator[];
  transformations: Array<
    | "trim_text"
    | "canonicalize_identifier"
    | "construct_product_variant"
    | "normalize_pack"
    | "resolve_public_url"
    | "decimal_currency_to_minor_units"
    | "normalize_availability"
    | "normalize_attribute"
    | "normalize_condition"
    | "normalize_seller_name"
  >;
  observed_value_digest: `sha256:${string}`;
}

export interface ProductResearchOriginReceipt {
  artifact: "static_http_body" | "rendered_page";
  structure: "json_ld" | "embedded_product_json" | "product_meta";
  source_block_index: number;
  product_index: number;
  offer_index: number | null;
  content_digest: `sha256:${string}`;
  version_receipt: string | null;
}

export type ProductResearchFieldEvidenceBinding =
  | {
      kind: "origin";
      receipt: ProductResearchOriginReceipt;
      locators: ProductResearchOriginFieldLocator[];
    }
  | {
      kind: "structured";
      field_references: Array<{
        material_field:
          | "variant_identity"
          | "seller_identity"
          | "condition"
          | "pack"
          | "item_price"
          | "shipping_price"
          | "tax_price"
          | "mandatory_fees"
          | "price_semantics"
          | "total_price"
          | "availability"
          | "destination_eligibility"
          | "purchase_url";
        source_version_id: string;
        evidence_span_ids: string[];
      }>;
      assessment_bundle_digest: `sha256:${string}`;
      assessment_digest: `sha256:${string}`;
      observation_digest: `sha256:${string}`;
      source_context_digest: `sha256:${string}`;
      record_digest: `sha256:${string}`;
      call_outcome_digest: `sha256:${string}`;
      call_version_receipt: string;
      field_receipt_digest: `sha256:${string}`;
    };

export type ProductResearchFieldDerivation =
  | "publish_title"
  | "publish_family"
  | "publish_identity"
  | "publish_attribute"
  | "publish_pack"
  | "publish_condition"
  | "publish_origin_url"
  | "derive_merchant_origin"
  | "publish_seller_name"
  | "classify_listing_kind"
  | "classify_relationship"
  | "publish_item_price"
  | "derive_price_basis"
  | "derive_price_qualifiers"
  | "publish_availability";

export interface ProductResearchFieldEvidence {
  field: string;
  verification_tier: ProductResearchVerificationTier;
  source_id: string;
  source_url: string;
  observed_at: string;
  evidence_digest: `sha256:${string}` | null;
  version_receipt: string | null;
  evidence_binding: ProductResearchFieldEvidenceBinding;
  derivations: ProductResearchFieldDerivation[];
}

export interface ProductResearchCatalogSupportRecord {
  record_digest: `sha256:${string}`;
  source_id: string;
  source_version_id: string;
  independence_group: string;
  authority:
    "manufacturer_catalog" | "authorized_registry" | "merchant_catalog";
  content_digest: `sha256:${string}`;
  identity_binding_key: string;
}

export type ProductResearchIdentityEvidence =
  | { basis: "descriptive" }
  | { basis: "hard_identifier"; identifier: ProductIdentifier }
  | {
      basis: "catalog_corroboration";
      identifier: ProductIdentifier;
      resolution_digest: `sha256:${string}`;
      resolved_target_digest: `sha256:${string}`;
      independent_source_ids: string[];
      resolution_supporting_records: ProductResearchCatalogSupportRecord[];
      authoritative_source_id: string;
    };

export interface NormalizedProductResearchCandidate {
  candidate_id: `sha256:${string}`;
  candidate_state: "offer" | "discovery";
  product_name: string;
  family?: { brand?: string; name?: string; category?: string };
  identifiers: ProductIdentifier[];
  attributes: ProductAttribute[];
  pack: PackSpec | null;
  condition: ProductCondition;
  listing_kind: ProductResearchObservedListingKind;
  relationship: ProductResearchRelationship;
  price: ProductResearchPrice | null;
  delivery: ProductResearchDeliveryEvidence | null;
  availability: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  merchant: ProductResearchMerchant;
  origin_url: string;
  observed_at: string;
  expires_at: string;
  verification_tier: ProductResearchVerificationTier;
  field_evidence: ProductResearchFieldEvidence[];
  identity_evidence: ProductResearchIdentityEvidence;
  conflict_codes: string[];
  discovered_by: string[];
}

export interface ProductResearchOffer {
  offer_id: `sha256:${string}`;
  rank: number;
  match_status: ProductResearchMatchStatus;
  title: string;
  origin_url: string;
  merchant: ProductResearchMerchant;
  listing_kind: ProductResearchListingKind;
  relationship: ProductResearchRelationship;
  condition: ProductCondition;
  pack: PackSpec | null;
  price: ProductResearchPrice | null;
  delivery: ProductResearchDeliveryEvidence | null;
  availability: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  verification_tier: "origin_verified" | "structured_source_verified";
  observed_at: string;
  expires_at: string;
  field_evidence: ProductResearchFieldEvidence[];
  comparison_key: `sha256:${string}` | null;
  price_label: "lowest_comparable" | null;
  warning_codes: string[];
}

export interface ProductResearchProductGroup {
  group_id: `sha256:${string}`;
  rank: number;
  match_status: ProductResearchMatchStatus;
  identity_basis:
    "hard_identifier" | "catalog_corroboration" | "descriptive" | "conflict";
  identity_receipt_digest: `sha256:${string}` | null;
  product_name: string;
  family?: { brand?: string; name?: string; category?: string };
  identifiers: ProductIdentifier[];
  attributes: ProductAttribute[];
  pack: PackSpec | null;
  condition: ProductCondition;
  listing_kind: ProductResearchListingKind;
  relationship: ProductResearchRelationship;
  offers: ProductResearchOffer[];
  conflict_codes: string[];
  refinement_codes: string[];
}

export interface ProductResearchUnverifiedDiscovery {
  discovery_id: `sha256:${string}`;
  title: "Unverified web result";
  origin_url: string;
  merchant_domain: string;
  listing_kind: ProductResearchObservedListingKind;
  relationship: "unknown";
  discovered_price: ProductResearchPrice | null;
  observed_at: string;
  discovered_by: string[];
  verification_tier: "discovered_unverified";
  possible_group_id: `sha256:${string}` | null;
  warning_codes: string[];
}

export interface ProductResearchSourceLedgerEntry {
  source_id: string;
  family: ProductResearchSourceFamily;
  origin_domain: string | null;
  disposition:
    | "succeeded"
    | "empty"
    | "failed"
    | "blocked"
    | "cancelled"
    | "deferred"
    | "unsearched";
  reason_code: string;
  reason_codes: string[];
  calls: number;
  outcome_counts: {
    succeeded: number;
    empty: number;
    failed: number;
    blocked: number;
    cancelled: number;
    deferred: number;
    unsearched: number;
  };
  candidates_discovered: number;
  verified_offers: number;
  cost_micro_usd: number;
  avoided_cost_micro_usd: number;
}

export interface ProductResearchExecutionReceipt {
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
  /** Serialized-DOM browser fallbacks actually invoked; absent on legacy recordings. */
  browser_attempt_count?: number;
  first_useful_candidate_ms: number | null;
  elapsed_ms: number;
}

export interface ProductResearchCoverage {
  claim: "bounded_not_comprehensive";
  state: "bounded" | "bounded_with_known_gaps" | "partial";
  source_ledger: ProductResearchSourceLedgerEntry[];
  execution_receipt: ProductResearchExecutionReceipt;
  source_families_attempted: ProductResearchSourceFamily[];
  merchant_origins_attempted: number;
  merchant_origins_succeeded: number;
  verified_offer_count: number;
  unverified_discovery_count: number;
  product_group_count: number;
  gap_codes: string[];
  stop_reason:
    | "coverage_satisfied"
    | "source_exhausted"
    | "budget_exhausted"
    | "deadline_reached"
    | "cancelled"
    | "upstream_unavailable";
}

export interface ProductResearchResult {
  schema_revision: 1;
  research_id: string;
  request_digest: `sha256:${string}`;
  operational_state: "complete" | "partial" | "failed" | "cancelled";
  research_state:
    | "offers_found"
    | "refinement_required"
    | "no_verified_offers"
    | "not_completed";
  authority: {
    mode: "review_only";
    action_authorized: false;
    permission: "withheld";
  };
  interpretation: ProductResearchQueryInterpretation;
  groups: ProductResearchProductGroup[];
  unverified_discoveries: ProductResearchUnverifiedDiscovery[];
  coverage: ProductResearchCoverage;
  warnings: Array<{
    code: string;
    message: string;
    scope: "request" | "coverage" | "group" | "offer" | "source";
    subject_id: string | null;
  }>;
  requested_refinements: Array<{
    field:
      | "brand"
      | "model"
      | "identifier"
      | "size"
      | "pack"
      | "condition"
      | "location"
      | "selection";
    reason_code: string;
    prompt: string;
    required_for:
      | "better_matches"
      | "price_comparison"
      | "delivered_price"
      | "exact_handoff";
    options: string[];
  }>;
  started_at: string;
  completed_at: string;
  expires_at: string;
}

interface ProductResearchProgressCommon {
  research_id: string;
  request_digest: `sha256:${string}`;
  sequence: number;
  observed_at: string;
}

export type ProductResearchProgressEvent =
  | (ProductResearchProgressCommon & { type: "accepted"; query: string })
  | (ProductResearchProgressCommon & {
      type: "interpreted";
      interpretation: ProductResearchQueryInterpretation;
    })
  | (ProductResearchProgressCommon & {
      type: "source_progress";
      source_id: string;
      family: ProductResearchSourceFamily;
      state:
        "started" | "succeeded" | "empty" | "failed" | "blocked" | "cancelled";
      reason_code: string | null;
    })
  | (ProductResearchProgressCommon & {
      type: "candidate_observed";
      candidate: NormalizedProductResearchCandidate;
    })
  | (ProductResearchProgressCommon & {
      type: "group_updated";
      group: ProductResearchProductGroup;
    })
  | (ProductResearchProgressCommon & {
      type: "completed";
      result: ProductResearchResult;
    })
  | (ProductResearchProgressCommon & {
      type: "failed";
      error_code: string;
      message: string;
      result: ProductResearchResult;
    })
  | (ProductResearchProgressCommon & {
      type: "cancelled";
      reason_code: string;
      result: ProductResearchResult;
    });

/** Transport-only marker for a same-key durable replay. */
export interface ProductResearchReplayEvent {
  type: "replay";
  sequence: number;
  replayed_at: string;
  research_id: string;
  request_digest: `sha256:${string}`;
  authority: {
    mode: "review_only";
    action_authorized: false;
    permission: "withheld";
  };
}

export type ProductResearchStreamEvent =
  ProductResearchProgressEvent | ProductResearchReplayEvent;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown> | null,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (!value || required.some((key) => !(key in value))) return false;
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key));
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REASON = /^[A-Z][A-Z0-9_.:-]*$/u;
const OPERATIONAL_STATES = new Set([
  "complete",
  "partial",
  "failed",
  "cancelled",
]);
const RESEARCH_STATES = new Set([
  "offers_found",
  "refinement_required",
  "no_verified_offers",
  "not_completed",
]);
const LISTING_KINDS = new Set<ProductResearchListingKind>([
  "purchase",
  "rental",
  "quote_only",
]);
const OBSERVED_LISTING_KINDS = new Set<ProductResearchObservedListingKind>([
  ...LISTING_KINDS,
  "unknown",
]);
const RELATIONSHIPS = new Set<ProductResearchRelationship>([
  "primary_product",
  "substitute",
  "accessory",
  "replacement_part",
  "consumable",
  "unknown",
]);
const MATCH_STATES = new Set<ProductResearchMatchStatus>([
  "exact",
  "possible",
  "conflicting",
]);
const SOURCE_FAMILIES = new Set<ProductResearchSourceFamily>([
  "catalog",
  "merchant_feed",
  "retailer_origin",
  "shopping_search",
  "open_web",
]);

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && DIGEST.test(value);
}

const OFFSET_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

function offsetTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    OFFSET_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function timestamp(value: unknown): value is string {
  return offsetTimestamp(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function reason(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && REASON.test(value);
}

function validMerchantDomain(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 253 ||
    value.trim() !== value ||
    value !== value.toLocaleLowerCase("en-US")
  ) {
    return false;
  }
  try {
    return new URL(`https://${value}`).hostname === value;
  } catch {
    return false;
  }
}

/** Detect action permission in canonical fields or unknown future extensions. */
function containsCommerceAuthority(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCommerceAuthority);
  const current = record(value);
  if (!current) return false;
  for (const [key, nested] of Object.entries(current)) {
    const token = typeof nested === "string" ? nested.toUpperCase() : undefined;
    if (
      ([
        "safe_to_quote",
        "action_authorized",
        "execution_allowed",
        "executionAllowed",
        "act",
      ].includes(key) &&
        nested === true) ||
      (key === "permission" && nested !== "withheld") ||
      (["decision", "disposition", "state"].includes(key) &&
        (token === "ALLOW" ||
          token === "BLOCK" ||
          token === "SAFE_TO_QUOTE")) ||
      containsCommerceAuthority(nested)
    ) {
      return true;
    }
  }
  return false;
}

function unique(values: unknown[]): boolean {
  return new Set(values).size === values.length;
}

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

function publicResearchUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const fragment = fragmentParameters(url.hash);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) =>
        SECRET_URL_PARAMETER.test(key),
      ) ||
      (fragment !== null &&
        [...fragment.keys()].some((key) => SECRET_URL_PARAMETER.test(key)))
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function validUrl(value: unknown): boolean {
  return publicResearchUrl(value) !== null;
}

function validNumericIdentifier(scheme: unknown, value: unknown): boolean {
  const lengths: Record<string, readonly number[]> = {
    gtin: [8, 12, 13, 14],
    upc: [12],
    ean: [8, 13],
  };
  const supported = lengths[String(scheme)];
  if (supported === undefined) return true;
  if (
    typeof value !== "string" ||
    !/^\d+$/u.test(value) ||
    !supported.includes(value.length)
  ) {
    return false;
  }
  const digits = [...value].map(Number);
  const checkDigit = digits.pop();
  const sum = digits
    .reverse()
    .reduce(
      (total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1),
      0,
    );
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function validIdentifier(value: unknown): boolean {
  const identifier = record(value);
  return (
    exactKeys(identifier, ["scheme", "value"], ["issuer"]) &&
    ["gtin", "upc", "ean", "isbn", "mpn", "manufacturer_sku", "model"].includes(
      String(identifier?.["scheme"]),
    ) &&
    typeof identifier?.["value"] === "string" &&
    identifier["value"].length > 0 &&
    identifier["value"].length <= 256 &&
    identifier["value"].trim() === identifier["value"] &&
    validNumericIdentifier(identifier["scheme"], identifier["value"]) &&
    (identifier["issuer"] === undefined ||
      trimmedBoundedString(identifier["issuer"], 256))
  );
}

function validAttribute(value: unknown): boolean {
  const attribute = record(value);
  return (
    exactKeys(attribute, ["key", "value"], ["unit"]) &&
    typeof attribute?.["key"] === "string" &&
    /^[a-z][a-z0-9_.-]*$/u.test(attribute["key"]) &&
    ((typeof attribute["value"] === "string" &&
      trimmedBoundedString(attribute["value"], 1_000)) ||
      (typeof attribute["value"] === "number" &&
        Number.isFinite(attribute["value"])) ||
      typeof attribute["value"] === "boolean") &&
    (attribute["unit"] === undefined ||
      trimmedBoundedString(attribute["unit"], 64))
  );
}

function validPack(value: unknown): boolean {
  const pack = record(value);
  return (
    exactKeys(pack, ["count"], ["units_per_item", "unit"]) &&
    positiveInteger(pack?.["count"]) &&
    (pack["units_per_item"] === undefined ||
      (typeof pack["units_per_item"] === "number" &&
        Number.isFinite(pack["units_per_item"]) &&
        pack["units_per_item"] > 0)) &&
    (pack["unit"] === undefined || trimmedBoundedString(pack["unit"], 64)) &&
    (pack["units_per_item"] === undefined) === (pack["unit"] === undefined)
  );
}

function samePack(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  const leftPack = record(left);
  const rightPack = record(right);
  return (
    leftPack !== null &&
    rightPack !== null &&
    leftPack["count"] === rightPack["count"] &&
    leftPack["units_per_item"] === rightPack["units_per_item"] &&
    leftPack["unit"] === rightPack["unit"]
  );
}

function compatiblePack(offerPack: unknown, groupPack: unknown): boolean {
  if (groupPack === null) return offerPack === null;
  return offerPack === null || samePack(offerPack, groupPack);
}

function compatibleCondition(
  offerCondition: unknown,
  groupCondition: unknown,
): boolean {
  if (groupCondition === "unknown") return offerCondition === "unknown";
  return offerCondition === "unknown" || offerCondition === groupCondition;
}

function validFamily(value: unknown): boolean {
  if (value === undefined) return true;
  const family = record(value);
  return (
    exactKeys(family, [], ["brand", "name", "category"]) &&
    (family?.["brand"] === undefined ||
      trimmedBoundedString(family["brand"], 256)) &&
    (family?.["name"] === undefined ||
      trimmedBoundedString(family["name"], 1_000)) &&
    (family?.["category"] === undefined ||
      trimmedBoundedString(family["category"], 512))
  );
}

function validClue(value: unknown): boolean {
  const clue = record(value);
  const provenance = record(clue?.["provenance"]);
  const span = record(provenance?.["span"]);
  const queryText = provenance?.["source"] === "query_text";
  const validSpan =
    span !== null &&
    exactKeys(span, ["encoding", "start", "end", "text"]) &&
    span["encoding"] === "utf16_code_unit" &&
    nonnegativeInteger(span["start"]) &&
    positiveInteger(span["end"]) &&
    span["end"] > span["start"] &&
    typeof span["text"] === "string" &&
    span["text"].length > 0 &&
    span["text"].length <= 1_000;
  const identifier = clue?.["identifier"];
  return (
    clue !== null &&
    exactKeys(
      clue,
      [
        "clue_id",
        "kind",
        "value",
        "normalized_value",
        "authority",
        "provenance",
      ],
      ["unit", "identifier"],
    ) &&
    trimmedBoundedString(clue?.["clue_id"], 256) &&
    [
      "brand",
      "manufacturer",
      "family",
      "model_like",
      "identifier",
      "dimension",
      "gauge",
      "thread",
      "voltage",
      "power_source",
      "capacity",
      "performance_rating",
      "material",
      "color",
      "compatibility",
      "included_component",
      "pack",
      "condition",
      "purchase_intent",
      "rental_intent",
      "quote_intent",
      "accessory_intent",
      "location_sensitive",
      "search_phrase",
    ].includes(String(clue["kind"])) &&
    trimmedBoundedString(clue["value"], 1_000) &&
    trimmedBoundedString(clue["normalized_value"], 1_000) &&
    (clue["unit"] === undefined || trimmedBoundedString(clue["unit"], 64)) &&
    ((clue["kind"] === "identifier" && validIdentifier(identifier)) ||
      (clue["kind"] !== "identifier" && identifier === undefined)) &&
    (clue["authority"] === "asserted" ||
      clue["authority"] === "retrieval_only") &&
    !(
      clue["authority"] === "asserted" &&
      (clue["kind"] !== "identifier" ||
        provenance?.["source"] === "model_proposal")
    ) &&
    provenance !== null &&
    exactKeys(provenance, ["source", "field"], ["span"]) &&
    ["query_text", "request_filter", "model_proposal"].includes(
      String(provenance["source"]),
    ) &&
    trimmedBoundedString(provenance["field"], 128) &&
    ((queryText && validSpan) ||
      (!queryText && provenance["span"] === undefined))
  );
}

function validInterpretation(value: unknown, expectedQuery?: string): boolean {
  const interpretation = record(value);
  const bundle = record(interpretation?.["query_bundle"]);
  const queries = bundle?.["queries"];
  const listingIntent = interpretation?.["listing_intent"];
  const clues = interpretation?.["clues"];
  return (
    exactKeys(interpretation, [
      "schema_revision",
      "interpreter_version",
      "original_query",
      "normalized_query",
      "query_class",
      "identity_state",
      "listing_intent",
      "location_sensitive",
      "accessory_ambiguous",
      "clues",
      "query_bundle",
    ]) &&
    interpretation?.["schema_revision"] === 1 &&
    trimmedBoundedString(interpretation["interpreter_version"], 128) &&
    trimmedBoundedString(interpretation["original_query"], 1_000) &&
    interpretation["original_query"].length >= 2 &&
    (expectedQuery === undefined ||
      interpretation["original_query"] === expectedQuery) &&
    trimmedBoundedString(interpretation["normalized_query"], 1_000) &&
    interpretation["normalized_query"].length >= 2 &&
    [
      "exact_identifier",
      "brand_model_description",
      "descriptive_product",
      "commodity_local",
      "rental_or_quote",
      "ambiguous",
    ].includes(String(interpretation["query_class"])) &&
    ["asserted_identifier", "candidate_only", "ambiguous"].includes(
      String(interpretation["identity_state"]),
    ) &&
    Array.isArray(listingIntent) &&
    listingIntent.length >= 1 &&
    listingIntent.length <= 3 &&
    unique(listingIntent) &&
    listingIntent.every((kind) =>
      LISTING_KINDS.has(kind as ProductResearchListingKind),
    ) &&
    typeof interpretation["location_sensitive"] === "boolean" &&
    typeof interpretation["accessory_ambiguous"] === "boolean" &&
    Array.isArray(clues) &&
    clues.length <= 256 &&
    unique(clues.map((clue) => record(clue)?.["clue_id"])) &&
    clues.every(validClue) &&
    (interpretation["identity_state"] !== "asserted_identifier" ||
      clues.some((clue) => {
        const current = record(clue);
        return (
          current?.["kind"] === "identifier" &&
          current["authority"] === "asserted"
        );
      })) &&
    (interpretation["query_class"] !== "exact_identifier" ||
      interpretation["identity_state"] === "asserted_identifier") &&
    (interpretation["query_class"] !== "rental_or_quote" ||
      listingIntent.some(
        (kind) => kind === "rental" || kind === "quote_only",
      )) &&
    exactKeys(bundle, ["version", "queries"]) &&
    bundle?.["version"] === "product-research-query/v1" &&
    Array.isArray(queries) &&
    queries.length >= 1 &&
    queries.length <= 12 &&
    record(queries[0])?.["kind"] === "literal" &&
    unique(queries.map((query) => record(query)?.["query_id"])) &&
    unique(
      queries.map((query) =>
        String(record(query)?.["text"]).toLocaleLowerCase("en-US"),
      ),
    ) &&
    queries.every((query) => {
      const planned = record(query);
      const rationaleCodes = planned?.["rationale_codes"];
      return (
        exactKeys(planned, [
          "query_id",
          "kind",
          "text",
          "rationale_codes",
          "authority",
        ]) &&
        digest(planned?.["query_id"]) &&
        [
          "literal",
          "normalized",
          "exact_identifier",
          "brand_model",
          "attribute",
          "commercial",
          "construction_expansion",
          "rental",
          "quote",
        ].includes(String(planned["kind"])) &&
        trimmedBoundedString(planned["text"], 1_000) &&
        planned["text"].length >= 2 &&
        Array.isArray(rationaleCodes) &&
        rationaleCodes.length >= 1 &&
        rationaleCodes.length <= 16 &&
        unique(rationaleCodes) &&
        rationaleCodes.every(reason) &&
        planned["authority"] === "discovery_only"
      );
    })
  );
}

function validPrice(value: unknown): boolean {
  if (value === null) return true;
  const price = record(value);
  const money = record(price?.["amount"]);
  const basis = record(price?.["basis"]);
  const qualifiers = price?.["qualifiers"];
  const kind = basis?.["kind"];
  const validBasis =
    basis !== null &&
    ((kind === "per_orderable_item" && exactKeys(basis, ["kind"])) ||
      (kind === "per_pack" &&
        exactKeys(basis, ["kind", "pack_count"]) &&
        positiveInteger(basis["pack_count"])) ||
      (kind === "per_unit" &&
        exactKeys(basis, ["kind", "quantity", "unit"]) &&
        typeof basis["quantity"] === "number" &&
        Number.isFinite(basis["quantity"]) &&
        basis["quantity"] > 0 &&
        trimmedBoundedString(basis["unit"], 64)) ||
      (kind === "rental_period" &&
        exactKeys(basis, ["kind", "duration", "unit"]) &&
        typeof basis["duration"] === "number" &&
        Number.isFinite(basis["duration"]) &&
        basis["duration"] > 0 &&
        ["hour", "day", "week", "month"].includes(String(basis["unit"]))));
  return (
    exactKeys(price, [
      "amount",
      "basis",
      "qualifiers",
      "shipping_included",
      "tax_included",
    ]) &&
    exactKeys(money, ["amount_minor", "currency"]) &&
    nonnegativeInteger(money?.["amount_minor"]) &&
    typeof money["currency"] === "string" &&
    /^[A-Z]{3}$/u.test(money["currency"]) &&
    validBasis &&
    Array.isArray(qualifiers) &&
    qualifiers.length >= 1 &&
    qualifiers.length <= 9 &&
    unique(qualifiers) &&
    qualifiers.every((qualifier) =>
      [
        "unknown",
        "standard",
        "list",
        "sale",
        "member",
        "subscription",
        "coupon",
        "trade_in",
        "installment",
        "estimated",
      ].includes(String(qualifier)),
    ) &&
    !(
      qualifiers.length > 1 &&
      (qualifiers.includes("unknown") || qualifiers.includes("standard"))
    ) &&
    (typeof price?.["shipping_included"] === "boolean" ||
      price?.["shipping_included"] === null) &&
    (typeof price?.["tax_included"] === "boolean" ||
      price?.["tax_included"] === null)
  );
}

function canonicalResearchUrl(value: unknown): string | null {
  const parsed = publicResearchUrl(value);
  if (parsed === null) return null;
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLocaleLowerCase("en-US");
  parsed.searchParams.sort();
  return parsed.toString();
}

function validDeliveryMoney(value: unknown): boolean {
  const money = record(value);
  return (
    exactKeys(money, ["amount_minor", "currency"]) &&
    nonnegativeInteger(money?.["amount_minor"]) &&
    typeof money["currency"] === "string" &&
    /^[A-Z]{3}$/u.test(money["currency"])
  );
}

function trimmedBoundedString(
  value: unknown,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value
  );
}

function validDeliveryPromise(value: unknown): boolean {
  if (value === null) return true;
  const promise = record(value);
  if (promise === null) return false;
  return (
    exactKeys(promise, ["certainty", "earliest_at", "latest_at"]) &&
    ["guaranteed", "estimated"].includes(String(promise?.["certainty"])) &&
    offsetTimestamp(promise["earliest_at"]) &&
    offsetTimestamp(promise["latest_at"]) &&
    Date.parse(promise["latest_at"] as string) >=
      Date.parse(promise["earliest_at"] as string)
  );
}

function validDelivery(value: unknown): boolean {
  if (value === null) return true;
  const delivery = record(value);
  if (delivery === null) return false;
  if (
    !exactKeys(delivery, [
      "checkout_status",
      "research_request_digest",
      "request_digest",
      "origin_url",
      "source_id",
      "adapter_revision",
      "execution_mode",
      "version_receipt",
      "destination_eligibility",
      "availability",
      "seller_authorized",
      "delivery_promise",
      "item_price",
      "shipping_price",
      "tax_price",
      "mandatory_fees",
      "declared_landed_total",
      "calculated_landed_total",
      "landed_price_state",
      "quote_id",
      "evidence_digest",
      "observed_at",
      "expires_at",
    ]) ||
    !["verified", "review_required", "rejected"].includes(
      String(delivery?.["checkout_status"]),
    ) ||
    !digest(delivery["research_request_digest"]) ||
    !digest(delivery["request_digest"]) ||
    canonicalResearchUrl(delivery["origin_url"]) === null ||
    !trimmedBoundedString(delivery["source_id"], 256) ||
    !trimmedBoundedString(delivery["adapter_revision"], 512) ||
    !["live", "recorded_fixture"].includes(
      String(delivery["execution_mode"]),
    ) ||
    !trimmedBoundedString(delivery["version_receipt"], 512) ||
    !delivery["version_receipt"].startsWith(
      `${delivery["adapter_revision"]}:`,
    ) ||
    !["eligible", "ineligible", "unknown"].includes(
      String(delivery["destination_eligibility"]),
    ) ||
    !["in_stock", "out_of_stock", "preorder", "unknown"].includes(
      String(delivery["availability"]),
    ) ||
    !(
      typeof delivery["seller_authorized"] === "boolean" ||
      delivery["seller_authorized"] === null
    ) ||
    !validDeliveryPromise(delivery["delivery_promise"]) ||
    !["complete", "incomplete", "invalid", "inconsistent"].includes(
      String(delivery["landed_price_state"]),
    ) ||
    !(
      delivery["quote_id"] === null ||
      trimmedBoundedString(delivery["quote_id"], 512)
    ) ||
    !digest(delivery["evidence_digest"]) ||
    !offsetTimestamp(delivery["observed_at"]) ||
    !offsetTimestamp(delivery["expires_at"]) ||
    Date.parse(delivery["expires_at"] as string) <=
      Date.parse(delivery["observed_at"] as string)
  ) {
    return false;
  }
  const promise = record(delivery["delivery_promise"]);
  if (
    promise !== null &&
    Date.parse(promise["earliest_at"] as string) <
      Date.parse(delivery["observed_at"] as string)
  ) {
    return false;
  }
  const moneyKeys = [
    "item_price",
    "shipping_price",
    "tax_price",
    "mandatory_fees",
    "declared_landed_total",
    "calculated_landed_total",
  ] as const;
  if (
    !moneyKeys.every(
      (key) => delivery[key] === null || validDeliveryMoney(delivery[key]),
    )
  ) {
    return false;
  }
  const currencies = new Set(
    moneyKeys.flatMap((key) => {
      const money = record(delivery[key]);
      return money === null ? [] : [money["currency"]];
    }),
  );
  if (currencies.size > 1) return false;
  if (delivery["landed_price_state"] === "complete") {
    if (moneyKeys.some((key) => delivery[key] === null)) return false;
    const amount = (key: (typeof moneyKeys)[number]): number =>
      record(delivery[key])!["amount_minor"] as number;
    const expected =
      amount("item_price") +
      amount("shipping_price") +
      amount("tax_price") +
      amount("mandatory_fees");
    if (
      !Number.isSafeInteger(expected) ||
      expected !== amount("declared_landed_total") ||
      expected !== amount("calculated_landed_total")
    ) {
      return false;
    }
  }
  return !(
    delivery["checkout_status"] === "verified" &&
    (delivery["destination_eligibility"] !== "eligible" ||
      delivery["availability"] !== "in_stock" ||
      delivery["seller_authorized"] !== true ||
      delivery["landed_price_state"] !== "complete")
  );
}

function validMerchant(value: unknown): boolean {
  const merchant = record(value);
  if (
    merchant === null ||
    !exactKeys(merchant, ["display_name", "origin_domain"], ["seller_id"])
  ) {
    return false;
  }
  return (
    (merchant["display_name"] === null ||
      trimmedBoundedString(merchant["display_name"], 512)) &&
    validMerchantDomain(merchant["origin_domain"]) &&
    (merchant["seller_id"] === undefined ||
      trimmedBoundedString(merchant["seller_id"], 256))
  );
}

const MATERIAL_OFFER_FIELDS = new Set([
  "variant_identity",
  "seller_identity",
  "condition",
  "pack",
  "item_price",
  "shipping_price",
  "tax_price",
  "mandatory_fees",
  "price_semantics",
  "total_price",
  "availability",
  "destination_eligibility",
  "purchase_url",
]);

const FIELD_DERIVATIONS = new Set([
  "publish_title",
  "publish_family",
  "publish_identity",
  "publish_attribute",
  "publish_pack",
  "publish_condition",
  "publish_origin_url",
  "derive_merchant_origin",
  "publish_seller_name",
  "classify_listing_kind",
  "classify_relationship",
  "publish_item_price",
  "derive_price_basis",
  "derive_price_qualifiers",
  "publish_availability",
]);

function validOriginSourceValue(value: unknown): boolean {
  const locator = record(value);
  return (
    exactKeys(locator, ["object_role", "path", "raw_value_digest"]) &&
    [
      "product",
      "variant_parent",
      "offer",
      "embedded_product",
      "product_meta",
      "artifact_origin",
    ].includes(String(locator?.["object_role"])) &&
    trimmedBoundedString(locator?.["path"], 4_096) &&
    digest(locator?.["raw_value_digest"])
  );
}

function validOriginFieldLocator(value: unknown): boolean {
  const locator = record(value);
  const sourceValues = locator?.["source_values"];
  const transformations = locator?.["transformations"];
  return (
    exactKeys(locator, [
      "field_path",
      "source_values",
      "transformations",
      "observed_value_digest",
    ]) &&
    trimmedBoundedString(locator?.["field_path"], 4_096) &&
    Array.isArray(sourceValues) &&
    sourceValues.length >= 1 &&
    sourceValues.length <= 256 &&
    sourceValues.every(validOriginSourceValue) &&
    Array.isArray(transformations) &&
    transformations.length >= 1 &&
    transformations.length <= 64 &&
    transformations.every((transformation) =>
      [
        "trim_text",
        "canonicalize_identifier",
        "construct_product_variant",
        "normalize_pack",
        "resolve_public_url",
        "decimal_currency_to_minor_units",
        "normalize_availability",
        "normalize_attribute",
        "normalize_condition",
        "normalize_seller_name",
      ].includes(String(transformation)),
    ) &&
    digest(locator?.["observed_value_digest"])
  );
}

function validOriginReceipt(value: unknown): boolean {
  const receipt = record(value);
  return (
    exactKeys(receipt, [
      "artifact",
      "structure",
      "source_block_index",
      "product_index",
      "offer_index",
      "content_digest",
      "version_receipt",
    ]) &&
    ["static_http_body", "rendered_page"].includes(
      String(receipt?.["artifact"]),
    ) &&
    ["json_ld", "embedded_product_json", "product_meta"].includes(
      String(receipt?.["structure"]),
    ) &&
    nonnegativeInteger(receipt?.["source_block_index"]) &&
    nonnegativeInteger(receipt?.["product_index"]) &&
    (receipt?.["offer_index"] === null ||
      nonnegativeInteger(receipt?.["offer_index"])) &&
    digest(receipt?.["content_digest"]) &&
    (receipt?.["version_receipt"] === null ||
      trimmedBoundedString(receipt?.["version_receipt"], 512))
  );
}

function validFieldEvidenceBinding(value: unknown): boolean {
  const binding = record(value);
  if (binding?.["kind"] === "origin") {
    const locators = binding["locators"];
    return (
      exactKeys(binding, ["kind", "receipt", "locators"]) &&
      validOriginReceipt(binding["receipt"]) &&
      Array.isArray(locators) &&
      locators.length >= 1 &&
      locators.length <= 64 &&
      locators.every(validOriginFieldLocator) &&
      unique(locators.map((locator) => record(locator)?.["field_path"]))
    );
  }
  if (binding?.["kind"] !== "structured") return false;
  const references = binding["field_references"];
  return (
    exactKeys(binding, [
      "kind",
      "field_references",
      "assessment_bundle_digest",
      "assessment_digest",
      "observation_digest",
      "source_context_digest",
      "record_digest",
      "call_outcome_digest",
      "call_version_receipt",
      "field_receipt_digest",
    ]) &&
    Array.isArray(references) &&
    references.length >= 1 &&
    references.length <= 16 &&
    unique(
      references.map((reference) => record(reference)?.["material_field"]),
    ) &&
    references.every((reference) => {
      const current = record(reference);
      const spanIds = current?.["evidence_span_ids"];
      return (
        exactKeys(current, [
          "material_field",
          "source_version_id",
          "evidence_span_ids",
        ]) &&
        MATERIAL_OFFER_FIELDS.has(String(current?.["material_field"])) &&
        trimmedBoundedString(current?.["source_version_id"], 256) &&
        Array.isArray(spanIds) &&
        spanIds.length >= 1 &&
        spanIds.length <= 32 &&
        unique(spanIds) &&
        spanIds.every((spanId) => trimmedBoundedString(spanId, 256))
      );
    }) &&
    [
      "assessment_bundle_digest",
      "assessment_digest",
      "observation_digest",
      "source_context_digest",
      "record_digest",
      "call_outcome_digest",
      "field_receipt_digest",
    ].every((key) => digest(binding[key])) &&
    trimmedBoundedString(binding["call_version_receipt"], 512)
  );
}

function validFieldEvidence(value: unknown): boolean {
  const evidence = record(value);
  const tier = evidence?.["verification_tier"];
  const binding = record(evidence?.["evidence_binding"]);
  const derivations = evidence?.["derivations"];
  if (
    !exactKeys(evidence, [
      "field",
      "verification_tier",
      "source_id",
      "source_url",
      "observed_at",
      "evidence_digest",
      "version_receipt",
      "evidence_binding",
      "derivations",
    ]) ||
    typeof evidence?.["field"] !== "string" ||
    !/^[a-z][a-z0-9_.-]*$/u.test(evidence["field"])
  ) {
    return false;
  }
  const valid =
    [
      "origin_verified",
      "structured_source_verified",
      "discovered_unverified",
    ].includes(String(tier)) &&
    trimmedBoundedString(evidence["source_id"], 256) &&
    validUrl(evidence["source_url"]) &&
    timestamp(evidence["observed_at"]) &&
    (evidence["evidence_digest"] === null ||
      digest(evidence["evidence_digest"])) &&
    (tier === "discovered_unverified" ||
      evidence["evidence_digest"] !== null) &&
    (evidence["version_receipt"] === null ||
      trimmedBoundedString(evidence["version_receipt"], 512)) &&
    (tier !== "structured_source_verified" ||
      (typeof evidence["version_receipt"] === "string" &&
        evidence["version_receipt"].length > 0)) &&
    validFieldEvidenceBinding(binding) &&
    Array.isArray(derivations) &&
    derivations.length >= 1 &&
    derivations.length <= 16 &&
    unique(derivations) &&
    derivations.every((derivation) =>
      FIELD_DERIVATIONS.has(String(derivation)),
    );
  if (!valid || binding === null) return false;
  if (binding["kind"] === "origin") {
    const receipt = record(binding["receipt"]);
    return (
      receipt !== null &&
      (evidence["evidence_digest"] === null ||
        evidence["evidence_digest"] === receipt["content_digest"]) &&
      evidence["version_receipt"] === receipt["version_receipt"]
    );
  }
  return (
    evidence["evidence_digest"] === binding["field_receipt_digest"] &&
    evidence["version_receipt"] === binding["call_version_receipt"]
  );
}

function validIdentityEvidence(value: unknown): boolean {
  const evidence = record(value);
  if (evidence?.["basis"] === "descriptive") {
    return exactKeys(evidence, ["basis"]);
  }
  if (
    evidence?.["basis"] === "hard_identifier" &&
    exactKeys(evidence, ["basis", "identifier"]) &&
    validIdentifier(evidence["identifier"])
  )
    return true;
  const sources = evidence?.["independent_source_ids"];
  const support = evidence?.["resolution_supporting_records"];
  return (
    evidence?.["basis"] === "catalog_corroboration" &&
    exactKeys(evidence, [
      "basis",
      "identifier",
      "resolution_digest",
      "resolved_target_digest",
      "independent_source_ids",
      "resolution_supporting_records",
      "authoritative_source_id",
    ]) &&
    validIdentifier(evidence["identifier"]) &&
    digest(evidence["resolution_digest"]) &&
    digest(evidence["resolved_target_digest"]) &&
    Array.isArray(sources) &&
    sources.length >= 2 &&
    sources.length <= 64 &&
    unique(sources) &&
    sources.every((source) => trimmedBoundedString(source, 256)) &&
    [...sources]
      .sort((left, right) => String(left).localeCompare(String(right)))
      .every((source, index) => source === sources[index]) &&
    Array.isArray(support) &&
    support.length >= 2 &&
    support.length <= 64 &&
    support.every((item) => {
      const current = record(item);
      return (
        exactKeys(current, [
          "record_digest",
          "source_id",
          "source_version_id",
          "independence_group",
          "authority",
          "content_digest",
          "identity_binding_key",
        ]) &&
        digest(current?.["record_digest"]) &&
        trimmedBoundedString(current?.["source_id"], 256) &&
        trimmedBoundedString(current?.["source_version_id"], 256) &&
        trimmedBoundedString(current?.["independence_group"], 256) &&
        [
          "manufacturer_catalog",
          "authorized_registry",
          "merchant_catalog",
        ].includes(String(current?.["authority"])) &&
        digest(current?.["content_digest"]) &&
        trimmedBoundedString(current?.["identity_binding_key"], 1_000)
      );
    }) &&
    unique(support.map((item) => record(item)?.["record_digest"])) &&
    [...support]
      .sort((left, right) =>
        String(record(left)?.["record_digest"]).localeCompare(
          String(record(right)?.["record_digest"]),
        ),
      )
      .every((item, index) => item === support[index]) &&
    [...new Set(support.map((item) => record(item)?.["source_id"]))]
      .sort((left, right) => String(left).localeCompare(String(right)))
      .every((source, index) => source === sources[index]) &&
    new Set(support.map((item) => record(item)?.["source_id"])).size ===
      sources.length &&
    new Set(support.map((item) => record(item)?.["independence_group"])).size >=
      2 &&
    new Set(support.map((item) => record(item)?.["content_digest"])).size >=
      2 &&
    new Set(support.map((item) => record(item)?.["identity_binding_key"]))
      .size === 1 &&
    support.every((item, index, records) => {
      const current = record(item);
      if (current === null) return false;
      return records.every((other, otherIndex) => {
        if (index === otherIndex) return true;
        const compared = record(other);
        return (
          compared === null ||
          compared["source_id"] !== current["source_id"] ||
          (compared["independence_group"] === current["independence_group"] &&
            compared["authority"] === current["authority"])
        );
      });
    }) &&
    trimmedBoundedString(evidence["authoritative_source_id"], 256) &&
    sources.includes(evidence["authoritative_source_id"]) &&
    support.some((item) => {
      const current = record(item);
      return (
        current !== null &&
        current?.["source_id"] === evidence["authoritative_source_id"] &&
        ["manufacturer_catalog", "authorized_registry"].includes(
          String(current["authority"]),
        )
      );
    })
  );
}

function originHostname(value: unknown): string | null {
  const canonical = canonicalResearchUrl(value);
  if (canonical === null) return null;
  return new URL(canonical).hostname.toLocaleLowerCase("en-US");
}

function validListingEvidenceBindings(
  listing: Record<string, unknown>,
): boolean {
  const merchant = record(listing["merchant"]);
  const evidence = listing["field_evidence"];
  const tier = listing["verification_tier"];
  const canonicalOrigin = canonicalResearchUrl(listing["origin_url"]);
  if (
    merchant === null ||
    merchant["origin_domain"] !== originHostname(listing["origin_url"]) ||
    !Array.isArray(evidence) ||
    evidence.length > 256
  ) {
    return false;
  }
  if (tier === "discovered_unverified") return evidence.length === 0;
  if (
    evidence.length === 0 ||
    !unique(evidence.map((item) => record(item)?.["field"])) ||
    !evidence.every((item) => {
      const current = record(item);
      return (
        current !== null &&
        validFieldEvidence(current) &&
        current?.["verification_tier"] === tier &&
        canonicalResearchUrl(current["source_url"]) === canonicalOrigin &&
        current["observed_at"] === listing["observed_at"]
      );
    })
  ) {
    return false;
  }
  const required = new Set([
    "title",
    "origin_url",
    "merchant_origin",
    "listing_kind",
  ]);
  if (merchant["display_name"] !== null) required.add("seller_name");
  if (listing["relationship"] !== "unknown") required.add("relationship");
  if (listing["condition"] !== "unknown") required.add("condition");
  if (listing["pack"] !== null) required.add("pack");
  if (listing["availability"] !== "unknown") required.add("availability");
  const identifiers = listing["identifiers"];
  if (Array.isArray(identifiers) && identifiers.length > 0) {
    required.add("product_identity");
  }
  const family = record(listing["family"]);
  if (family?.["brand"] !== undefined) required.add("family.brand");
  if (family?.["name"] !== undefined) required.add("family.name");
  if (family?.["category"] !== undefined) required.add("family.category");
  const attributes = listing["attributes"];
  if (Array.isArray(attributes)) {
    for (const attribute of attributes) {
      const key = record(attribute)?.["key"];
      if (typeof key === "string") required.add(`variant.attributes.${key}`);
    }
  }
  if (listing["price"] !== null) {
    required.add("item_price");
    required.add("price_basis");
    required.add("price_qualifiers");
  }
  const fields = new Set(
    evidence.map((item) => String(record(item)?.["field"])),
  );
  return [...required].every((field) => fields.has(field));
}

function validOffer(value: unknown, group?: Record<string, unknown>): boolean {
  const offer = record(value);
  const fieldEvidence = offer?.["field_evidence"];
  const price = offer?.["price"];
  const delivery = offer?.["delivery"];
  const priceBasis = record(record(price)?.["basis"])?.["kind"];
  return (
    exactKeys(offer, [
      "offer_id",
      "rank",
      "match_status",
      "title",
      "origin_url",
      "merchant",
      "listing_kind",
      "relationship",
      "condition",
      "pack",
      "price",
      "delivery",
      "availability",
      "verification_tier",
      "observed_at",
      "expires_at",
      "field_evidence",
      "comparison_key",
      "price_label",
      "warning_codes",
    ]) &&
    digest(offer?.["offer_id"]) &&
    positiveInteger(offer["rank"]) &&
    MATCH_STATES.has(offer["match_status"] as ProductResearchMatchStatus) &&
    (group === undefined || offer["match_status"] === group["match_status"]) &&
    trimmedBoundedString(offer["title"], 2_000) &&
    validUrl(offer["origin_url"]) &&
    validMerchant(offer["merchant"]) &&
    LISTING_KINDS.has(offer["listing_kind"] as ProductResearchListingKind) &&
    RELATIONSHIPS.has(offer["relationship"] as ProductResearchRelationship) &&
    (group === undefined ||
      (offer["listing_kind"] === group["listing_kind"] &&
        compatibleCondition(offer["condition"], group["condition"]) &&
        compatiblePack(offer["pack"], group["pack"]))) &&
    [
      "new",
      "open_box",
      "refurbished",
      "used_like_new",
      "used_good",
      "used_acceptable",
      "unknown",
    ].includes(String(offer["condition"])) &&
    (offer["pack"] === null || validPack(offer["pack"])) &&
    validPrice(price) &&
    Object.hasOwn(offer, "delivery") &&
    validDelivery(delivery) &&
    (delivery === null ||
      (canonicalResearchUrl(record(delivery)?.["origin_url"]) ===
        canonicalResearchUrl(offer["origin_url"]) &&
        Date.parse(record(delivery)?.["observed_at"] as string) <=
          Date.parse(offer["observed_at"] as string) &&
        Date.parse(offer["expires_at"] as string) <=
          Date.parse(record(delivery)?.["expires_at"] as string))) &&
    ["in_stock", "out_of_stock", "preorder", "unknown"].includes(
      String(offer["availability"]),
    ) &&
    ["origin_verified", "structured_source_verified"].includes(
      String(offer["verification_tier"]),
    ) &&
    timestamp(offer["observed_at"]) &&
    timestamp(offer["expires_at"]) &&
    Date.parse(offer["expires_at"]) > Date.parse(offer["observed_at"]) &&
    Array.isArray(fieldEvidence) &&
    fieldEvidence.every(validFieldEvidence) &&
    validListingEvidenceBindings(offer) &&
    (offer["comparison_key"] === null || digest(offer["comparison_key"])) &&
    (offer["price_label"] === null ||
      offer["price_label"] === "lowest_comparable") &&
    (offer["price_label"] === null || offer["comparison_key"] !== null) &&
    Array.isArray(offer["warning_codes"]) &&
    offer["warning_codes"].length <= 64 &&
    unique(offer["warning_codes"]) &&
    offer["warning_codes"].every(reason) &&
    !(offer["listing_kind"] === "quote_only" && price !== null) &&
    !(
      offer["listing_kind"] === "rental" &&
      price !== null &&
      priceBasis !== "rental_period"
    ) &&
    !(offer["listing_kind"] === "purchase" && priceBasis === "rental_period") &&
    !(
      priceBasis === "per_pack" &&
      (offer["pack"] === null ||
        record(record(price)?.["basis"])?.["pack_count"] !==
          record(offer["pack"])?.["count"])
    ) &&
    !(offer["comparison_key"] !== null && price === null)
  );
}

function validGroup(value: unknown): boolean {
  const group = record(value);
  const offers = group?.["offers"];
  const identifiers = group?.["identifiers"];
  const attributes = group?.["attributes"];
  const conflicts = group?.["conflict_codes"];
  const refinements = group?.["refinement_codes"];
  const exact = group?.["match_status"] === "exact";
  const conflicting = group?.["match_status"] === "conflicting";
  return (
    exactKeys(
      group,
      [
        "group_id",
        "rank",
        "match_status",
        "identity_basis",
        "identity_receipt_digest",
        "product_name",
        "identifiers",
        "attributes",
        "pack",
        "condition",
        "listing_kind",
        "relationship",
        "offers",
        "conflict_codes",
        "refinement_codes",
      ],
      ["family"],
    ) &&
    digest(group?.["group_id"]) &&
    positiveInteger(group["rank"]) &&
    MATCH_STATES.has(group["match_status"] as ProductResearchMatchStatus) &&
    [
      "hard_identifier",
      "catalog_corroboration",
      "descriptive",
      "conflict",
    ].includes(String(group["identity_basis"])) &&
    (group["identity_receipt_digest"] === null ||
      digest(group["identity_receipt_digest"])) &&
    trimmedBoundedString(group["product_name"], 2_000) &&
    validFamily(group["family"]) &&
    Array.isArray(identifiers) &&
    identifiers.length <= 32 &&
    identifiers.every(validIdentifier) &&
    Array.isArray(attributes) &&
    attributes.length <= 64 &&
    attributes.every(validAttribute) &&
    (group["pack"] === null || validPack(group["pack"])) &&
    [
      "new",
      "open_box",
      "refurbished",
      "used_like_new",
      "used_good",
      "used_acceptable",
      "unknown",
    ].includes(String(group["condition"])) &&
    LISTING_KINDS.has(group["listing_kind"] as ProductResearchListingKind) &&
    RELATIONSHIPS.has(group["relationship"] as ProductResearchRelationship) &&
    Array.isArray(offers) &&
    offers.length >= 1 &&
    offers.length <= 100 &&
    unique(offers.map((offer) => record(offer)?.["offer_id"])) &&
    unique(offers.map((offer) => record(offer)?.["rank"])) &&
    offers.every(
      (offer) =>
        validOffer(offer, group) &&
        record(offer)?.["relationship"] === group["relationship"],
    ) &&
    Array.isArray(conflicts) &&
    conflicts.length <= 64 &&
    unique(conflicts) &&
    conflicts.every(reason) &&
    Array.isArray(refinements) &&
    refinements.length <= 64 &&
    unique(refinements) &&
    refinements.every(reason) &&
    (!exact ||
      (["hard_identifier", "catalog_corroboration"].includes(
        String(group["identity_basis"]),
      ) &&
        identifiers.length > 0 &&
        digest(group["identity_receipt_digest"]) &&
        conflicts.length === 0)) &&
    (!conflicting ||
      (group["identity_basis"] === "conflict" && conflicts.length > 0)) &&
    (conflicting ||
      (group["identity_basis"] !== "conflict" && conflicts.length === 0)) &&
    (exact ||
      offers.every((offer) => {
        const current = record(offer);
        return (
          current?.["comparison_key"] === null &&
          current["price_label"] === null
        );
      }))
  );
}

function validCandidate(value: unknown): boolean {
  const candidate = record(value);
  const identifiers = candidate?.["identifiers"];
  const attributes = candidate?.["attributes"];
  const evidence = candidate?.["field_evidence"];
  const state = candidate?.["candidate_state"];
  const tier = candidate?.["verification_tier"];
  const price = candidate?.["price"];
  const delivery = candidate?.["delivery"];
  const priceBasis = record(record(price)?.["basis"])?.["kind"];
  return (
    exactKeys(
      candidate,
      [
        "candidate_id",
        "candidate_state",
        "product_name",
        "identifiers",
        "attributes",
        "pack",
        "condition",
        "listing_kind",
        "relationship",
        "price",
        "delivery",
        "availability",
        "merchant",
        "origin_url",
        "observed_at",
        "expires_at",
        "verification_tier",
        "field_evidence",
        "identity_evidence",
        "conflict_codes",
        "discovered_by",
      ],
      ["family"],
    ) &&
    digest(candidate?.["candidate_id"]) &&
    (state === "offer" || state === "discovery") &&
    trimmedBoundedString(candidate["product_name"], 2_000) &&
    validFamily(candidate["family"]) &&
    Array.isArray(identifiers) &&
    identifiers.length <= 32 &&
    identifiers.every(validIdentifier) &&
    unique(
      identifiers.map((identifier) => {
        const current = record(identifier);
        return `${String(current?.["scheme"])}\u0000${String(
          current?.["issuer"] ?? "",
        )}\u0000${String(current?.["value"])}`;
      }),
    ) &&
    Array.isArray(attributes) &&
    attributes.length <= 64 &&
    attributes.every(validAttribute) &&
    unique(attributes.map((attribute) => record(attribute)?.["key"])) &&
    (candidate["pack"] === null || validPack(candidate["pack"])) &&
    [
      "new",
      "open_box",
      "refurbished",
      "used_like_new",
      "used_good",
      "used_acceptable",
      "unknown",
    ].includes(String(candidate["condition"])) &&
    OBSERVED_LISTING_KINDS.has(
      candidate["listing_kind"] as ProductResearchObservedListingKind,
    ) &&
    RELATIONSHIPS.has(
      candidate["relationship"] as ProductResearchRelationship,
    ) &&
    validPrice(price) &&
    Object.hasOwn(candidate, "delivery") &&
    validDelivery(delivery) &&
    (delivery === null ||
      (canonicalResearchUrl(record(delivery)?.["origin_url"]) ===
        canonicalResearchUrl(candidate["origin_url"]) &&
        Date.parse(record(delivery)?.["observed_at"] as string) <=
          Date.parse(candidate["observed_at"] as string) &&
        Date.parse(candidate["expires_at"] as string) <=
          Date.parse(record(delivery)?.["expires_at"] as string))) &&
    ["in_stock", "out_of_stock", "preorder", "unknown"].includes(
      String(candidate["availability"]),
    ) &&
    validMerchant(candidate["merchant"]) &&
    validUrl(candidate["origin_url"]) &&
    timestamp(candidate["observed_at"]) &&
    timestamp(candidate["expires_at"]) &&
    Date.parse(candidate["expires_at"]) >
      Date.parse(candidate["observed_at"]) &&
    [
      "origin_verified",
      "structured_source_verified",
      "discovered_unverified",
    ].includes(String(tier)) &&
    ((state === "discovery" && tier === "discovered_unverified") ||
      (state === "offer" && tier !== "discovered_unverified")) &&
    (state !== "discovery" ||
      (candidate["product_name"] === "Unverified web result" &&
        candidate["listing_kind"] === "unknown" &&
        candidate["relationship"] === "unknown")) &&
    (state !== "offer" || candidate["listing_kind"] !== "unknown") &&
    Array.isArray(evidence) &&
    evidence.every(validFieldEvidence) &&
    validListingEvidenceBindings(candidate) &&
    validIdentityEvidence(candidate["identity_evidence"]) &&
    Array.isArray(candidate["conflict_codes"]) &&
    candidate["conflict_codes"].length <= 64 &&
    unique(candidate["conflict_codes"]) &&
    candidate["conflict_codes"].every(reason) &&
    Array.isArray(candidate["discovered_by"]) &&
    candidate["discovered_by"].length >= 1 &&
    candidate["discovered_by"].length <= 64 &&
    unique(candidate["discovered_by"]) &&
    candidate["discovered_by"].every((source) =>
      trimmedBoundedString(source, 256),
    ) &&
    !(
      candidate["listing_kind"] === "quote_only" && candidate["price"] !== null
    ) &&
    !(
      candidate["listing_kind"] === "rental" &&
      price !== null &&
      priceBasis !== "rental_period"
    ) &&
    !(
      candidate["listing_kind"] === "purchase" && priceBasis === "rental_period"
    ) &&
    !(
      priceBasis === "per_pack" &&
      (candidate["pack"] === null ||
        record(record(price)?.["basis"])?.["pack_count"] !==
          record(candidate["pack"])?.["count"])
    ) &&
    (record(candidate["identity_evidence"])?.["basis"] === "descriptive" ||
      (() => {
        const expected = record(
          record(candidate["identity_evidence"])?.["identifier"],
        );
        return (
          expected !== null &&
          identifiers.some((identifier) => {
            const current = record(identifier);
            return (
              current !== null &&
              current?.["scheme"] === expected["scheme"] &&
              current["value"] === expected["value"] &&
              current["issuer"] === expected["issuer"]
            );
          })
        );
      })())
  );
}

function validCoverage(
  value: unknown,
  groups: unknown[],
  discoveries: unknown[],
): boolean {
  const coverage = record(value);
  const ledger = coverage?.["source_ledger"];
  const receipt = record(coverage?.["execution_receipt"]);
  const families = coverage?.["source_families_attempted"];
  const gaps = coverage?.["gap_codes"];
  const verifiedOfferCount = groups.reduce<number>(
    (total, group) =>
      total +
      (Array.isArray(record(group)?.["offers"])
        ? (record(group)?.["offers"] as unknown[]).length
        : 0),
    0,
  );
  const outcomeKeys = [
    "succeeded",
    "empty",
    "failed",
    "blocked",
    "cancelled",
    "deferred",
    "unsearched",
  ] as const;
  const receiptIntegerKeys = [
    "search_calls",
    "fetch_calls",
    "providers_configured",
    "providers_succeeded",
    "cost_micro_usd",
    "provider_estimated_cost_reported_search_calls",
    "discovery_cache_hits",
    "cost_avoided_micro_usd",
    "elapsed_ms",
  ] as const;
  const receiptValid =
    exactKeys(
      receipt,
      [
        ...receiptIntegerKeys,
        "cost_basis",
        "provider_estimated_cost_micro_usd",
        "first_useful_candidate_ms",
      ],
      ["browser_attempt_count"],
    ) &&
    receiptIntegerKeys.every((key) => nonnegativeInteger(receipt?.[key])) &&
    receipt?.["cost_basis"] === "reserved_ceiling" &&
    (receipt["provider_estimated_cost_micro_usd"] === null ||
      nonnegativeInteger(receipt["provider_estimated_cost_micro_usd"])) &&
    (receipt["browser_attempt_count"] === undefined ||
      nonnegativeInteger(receipt["browser_attempt_count"])) &&
    (receipt["first_useful_candidate_ms"] === null ||
      nonnegativeInteger(receipt["first_useful_candidate_ms"]));
  if (!receiptValid || receipt === null) return false;
  const searchCalls = receipt["search_calls"] as number;
  const fetchCalls = receipt["fetch_calls"] as number;
  const providersConfigured = receipt["providers_configured"] as number;
  const providersSucceeded = receipt["providers_succeeded"] as number;
  const reportedEstimateCalls = receipt[
    "provider_estimated_cost_reported_search_calls"
  ] as number;
  const providerEstimate = receipt["provider_estimated_cost_micro_usd"];
  const firstUseful = receipt["first_useful_candidate_ms"];
  const elapsed = receipt["elapsed_ms"] as number;
  if (
    providersSucceeded > providersConfigured ||
    reportedEstimateCalls > searchCalls ||
    (providerEstimate !== null && reportedEstimateCalls !== searchCalls) ||
    (providerEstimate === null &&
      searchCalls > 0 &&
      reportedEstimateCalls === searchCalls) ||
    (receipt["browser_attempt_count"] !== undefined &&
      (receipt["browser_attempt_count"] as number) > fetchCalls) ||
    (firstUseful !== null && (firstUseful as number) > elapsed) ||
    verifiedOfferCount > 0 !== (firstUseful !== null)
  ) {
    return false;
  }
  return (
    exactKeys(coverage, [
      "claim",
      "state",
      "source_ledger",
      "execution_receipt",
      "source_families_attempted",
      "merchant_origins_attempted",
      "merchant_origins_succeeded",
      "verified_offer_count",
      "unverified_discovery_count",
      "product_group_count",
      "gap_codes",
      "stop_reason",
    ]) &&
    coverage?.["claim"] === "bounded_not_comprehensive" &&
    ["bounded", "bounded_with_known_gaps", "partial"].includes(
      String(coverage["state"]),
    ) &&
    Array.isArray(ledger) &&
    ledger.length <= 10_000 &&
    unique(ledger.map((item) => record(item)?.["source_id"])) &&
    ledger.every((item) => {
      const entry = record(item);
      const disposition = entry?.["disposition"];
      const reasons = entry?.["reason_codes"];
      const outcomes = record(entry?.["outcome_counts"]);
      const validOutcomes =
        exactKeys(outcomes, outcomeKeys) &&
        outcomeKeys.every((key) => nonnegativeInteger(outcomes?.[key]));
      if (!validOutcomes || outcomes === null) return false;
      const attemptedOutcomes = (
        ["succeeded", "empty", "failed", "cancelled"] as const
      ).reduce((total, key) => total + (outcomes[key] as number), 0);
      return (
        exactKeys(entry, [
          "source_id",
          "family",
          "origin_domain",
          "disposition",
          "reason_code",
          "reason_codes",
          "calls",
          "outcome_counts",
          "candidates_discovered",
          "verified_offers",
          "cost_micro_usd",
          "avoided_cost_micro_usd",
        ]) &&
        trimmedBoundedString(entry?.["source_id"], 256) &&
        SOURCE_FAMILIES.has(entry["family"] as ProductResearchSourceFamily) &&
        (entry["origin_domain"] === null ||
          validMerchantDomain(entry["origin_domain"])) &&
        [
          "succeeded",
          "empty",
          "failed",
          "blocked",
          "cancelled",
          "deferred",
          "unsearched",
        ].includes(String(disposition)) &&
        reason(entry["reason_code"]) &&
        Array.isArray(reasons) &&
        reasons.length >= 1 &&
        reasons.length <= 128 &&
        unique(reasons) &&
        reasons.every(reason) &&
        reasons.includes(entry["reason_code"]) &&
        nonnegativeInteger(entry["calls"]) &&
        (entry["calls"] as number) >= attemptedOutcomes &&
        (entry["calls"] as number) <=
          attemptedOutcomes + (outcomes["blocked"] as number) &&
        (!["succeeded", "empty", "failed"].includes(String(disposition)) ||
          entry["calls"] > 0) &&
        nonnegativeInteger(entry["candidates_discovered"]) &&
        nonnegativeInteger(entry["verified_offers"]) &&
        nonnegativeInteger(entry["cost_micro_usd"]) &&
        nonnegativeInteger(entry["avoided_cost_micro_usd"])
      );
    }) &&
    ledger.reduce(
      (total, item) => total + (record(item)?.["calls"] as number),
      0,
    ) <=
      searchCalls + fetchCalls &&
    ledger.reduce(
      (total, item) => total + (record(item)?.["cost_micro_usd"] as number),
      0,
    ) <= (receipt["cost_micro_usd"] as number) &&
    ledger.reduce(
      (total, item) =>
        total + (record(item)?.["avoided_cost_micro_usd"] as number),
      0,
    ) <= (receipt["cost_avoided_micro_usd"] as number) &&
    Array.isArray(families) &&
    families.length <= 5 &&
    unique(families) &&
    families.every((family) =>
      SOURCE_FAMILIES.has(family as ProductResearchSourceFamily),
    ) &&
    nonnegativeInteger(coverage["merchant_origins_attempted"]) &&
    nonnegativeInteger(coverage["merchant_origins_succeeded"]) &&
    coverage["merchant_origins_succeeded"] <=
      coverage["merchant_origins_attempted"] &&
    nonnegativeInteger(coverage["verified_offer_count"]) &&
    nonnegativeInteger(coverage["unverified_discovery_count"]) &&
    nonnegativeInteger(coverage["product_group_count"]) &&
    coverage["product_group_count"] === groups.length &&
    coverage["unverified_discovery_count"] === discoveries.length &&
    coverage["verified_offer_count"] === verifiedOfferCount &&
    Array.isArray(gaps) &&
    gaps.length <= 128 &&
    unique(gaps) &&
    gaps.every(reason) &&
    [
      "coverage_satisfied",
      "source_exhausted",
      "budget_exhausted",
      "deadline_reached",
      "cancelled",
      "upstream_unavailable",
    ].includes(String(coverage["stop_reason"]))
  );
}

function validDiscovery(value: unknown): boolean {
  const discovery = record(value);
  const discoveredBy = discovery?.["discovered_by"];
  const warnings = discovery?.["warning_codes"];
  return (
    exactKeys(discovery, [
      "discovery_id",
      "title",
      "origin_url",
      "merchant_domain",
      "listing_kind",
      "relationship",
      "discovered_price",
      "observed_at",
      "discovered_by",
      "verification_tier",
      "possible_group_id",
      "warning_codes",
    ]) &&
    digest(discovery?.["discovery_id"]) &&
    discovery["title"] === "Unverified web result" &&
    validUrl(discovery["origin_url"]) &&
    validMerchantDomain(discovery["merchant_domain"]) &&
    discovery["merchant_domain"] === originHostname(discovery["origin_url"]) &&
    OBSERVED_LISTING_KINDS.has(
      discovery["listing_kind"] as ProductResearchObservedListingKind,
    ) &&
    discovery["relationship"] === "unknown" &&
    validPrice(discovery["discovered_price"]) &&
    !(
      discovery["listing_kind"] === "quote_only" &&
      discovery["discovered_price"] !== null
    ) &&
    timestamp(discovery["observed_at"]) &&
    Array.isArray(discoveredBy) &&
    discoveredBy.length >= 1 &&
    discoveredBy.length <= 64 &&
    unique(discoveredBy) &&
    discoveredBy.every((source) => trimmedBoundedString(source, 256)) &&
    discovery["verification_tier"] === "discovered_unverified" &&
    (discovery["possible_group_id"] === null ||
      digest(discovery["possible_group_id"])) &&
    Array.isArray(warnings) &&
    warnings.length >= 1 &&
    warnings.length <= 64 &&
    unique(warnings) &&
    warnings.every(reason)
  );
}

function validWarning(value: unknown): boolean {
  const warning = record(value);
  return (
    warning !== null &&
    exactKeys(warning, ["code", "message", "scope", "subject_id"]) &&
    reason(warning?.["code"]) &&
    trimmedBoundedString(warning["message"], 1_000) &&
    ["request", "coverage", "group", "offer", "source"].includes(
      String(warning["scope"]),
    ) &&
    (warning["subject_id"] === null ||
      trimmedBoundedString(warning["subject_id"], 256))
  );
}

function validRefinement(value: unknown): boolean {
  const refinement = record(value);
  const options = refinement?.["options"];
  return (
    refinement !== null &&
    exactKeys(refinement, [
      "field",
      "reason_code",
      "prompt",
      "required_for",
      "options",
    ]) &&
    [
      "brand",
      "model",
      "identifier",
      "size",
      "pack",
      "condition",
      "location",
      "selection",
    ].includes(String(refinement?.["field"])) &&
    reason(refinement?.["reason_code"]) &&
    trimmedBoundedString(refinement["prompt"], 1_000) &&
    [
      "better_matches",
      "price_comparison",
      "delivered_price",
      "exact_handoff",
    ].includes(String(refinement["required_for"])) &&
    Array.isArray(options) &&
    options.length <= 32 &&
    unique(options) &&
    options.every((option) => trimmedBoundedString(option, 256))
  );
}

export function reviewOnlyProductResearchResult(
  value: unknown,
  expected?: { research_id?: string; request_digest?: string; query?: string },
): ProductResearchResult {
  const result = record(value);
  const authority = record(result?.["authority"]);
  const groups = result?.["groups"];
  const discoveries = result?.["unverified_discoveries"];
  const warnings = result?.["warnings"];
  const refinements = result?.["requested_refinements"];
  const verifiedOfferCount = Array.isArray(groups)
    ? groups.reduce<number>(
        (count, group) =>
          count +
          (Array.isArray(record(group)?.["offers"])
            ? (record(group)?.["offers"] as unknown[]).length
            : 0),
        0,
      )
    : -1;
  if (
    !exactKeys(result, [
      "schema_revision",
      "research_id",
      "request_digest",
      "operational_state",
      "research_state",
      "authority",
      "interpretation",
      "groups",
      "unverified_discoveries",
      "coverage",
      "warnings",
      "requested_refinements",
      "started_at",
      "completed_at",
      "expires_at",
    ]) ||
    result?.["schema_revision"] !== 1 ||
    !trimmedBoundedString(result["research_id"], 256) ||
    !digest(result["request_digest"]) ||
    (expected?.research_id !== undefined &&
      result["research_id"] !== expected.research_id) ||
    (expected?.request_digest !== undefined &&
      result["request_digest"] !== expected.request_digest) ||
    !OPERATIONAL_STATES.has(String(result["operational_state"])) ||
    !RESEARCH_STATES.has(String(result["research_state"])) ||
    ["failed", "cancelled"].includes(String(result["operational_state"])) !==
      (result["research_state"] === "not_completed") ||
    authority?.["mode"] !== "review_only" ||
    authority["action_authorized"] !== false ||
    authority["permission"] !== "withheld" ||
    !exactKeys(authority, ["mode", "action_authorized", "permission"]) ||
    containsCommerceAuthority(result) ||
    !validInterpretation(result["interpretation"], expected?.query) ||
    !Array.isArray(groups) ||
    groups.length > 100 ||
    !groups.every(validGroup) ||
    !groups.every((group) => {
      const offers = record(group)?.["offers"];
      return (
        Array.isArray(offers) &&
        offers.every((offer) => {
          const delivery = record(record(offer)?.["delivery"]);
          return (
            delivery === null ||
            delivery["research_request_digest"] === result["request_digest"]
          );
        })
      );
    }) ||
    !unique(groups.map((group) => record(group)?.["group_id"])) ||
    !unique(groups.map((group) => record(group)?.["rank"])) ||
    !Array.isArray(discoveries) ||
    discoveries.length > 1_000 ||
    !discoveries.every(validDiscovery) ||
    !unique(
      discoveries.map((discovery) => record(discovery)?.["discovery_id"]),
    ) ||
    !validCoverage(result["coverage"], groups, discoveries) ||
    !Array.isArray(warnings) ||
    warnings.length > 256 ||
    !warnings.every(validWarning) ||
    !Array.isArray(refinements) ||
    refinements.length > 64 ||
    !refinements.every(validRefinement) ||
    (result["research_state"] === "offers_found" && verifiedOfferCount === 0) ||
    (result["research_state"] === "no_verified_offers" &&
      verifiedOfferCount > 0) ||
    !timestamp(result["started_at"]) ||
    !timestamp(result["completed_at"]) ||
    !timestamp(result["expires_at"]) ||
    Date.parse(result["completed_at"]) < Date.parse(result["started_at"]) ||
    Date.parse(result["expires_at"]) <= Date.parse(result["completed_at"]) ||
    !groups.every((group) => {
      const offers = record(group)?.["offers"];
      return (
        Array.isArray(offers) &&
        offers.every((offer) => {
          const current = record(offer);
          return (
            current !== null &&
            Date.parse(current["observed_at"] as string) <=
              Date.parse(result["completed_at"] as string) &&
            Date.parse(result["expires_at"] as string) <=
              Date.parse(current["expires_at"] as string)
          );
        })
      );
    }) ||
    !discoveries.every(
      (discovery) =>
        Date.parse(record(discovery)?.["observed_at"] as string) <=
        Date.parse(result["completed_at"] as string),
    )
  ) {
    throw new TypeError(
      "Product Research returned an invalid or authority-bearing canonical result",
    );
  }
  return value as ProductResearchResult;
}

export function reviewOnlyProductResearchProgressEvent(
  value: unknown,
  expected?: {
    research_id?: string;
    request_digest?: string;
    query?: string;
  },
): ProductResearchProgressEvent {
  const event = record(value);
  const common =
    event &&
    trimmedBoundedString(event["research_id"], 256) &&
    digest(event["request_digest"]) &&
    nonnegativeInteger(event["sequence"]) &&
    timestamp(event["observed_at"]) &&
    (expected?.research_id === undefined ||
      event["research_id"] === expected.research_id) &&
    (expected?.request_digest === undefined ||
      event["request_digest"] === expected.request_digest) &&
    !containsCommerceAuthority(event);
  if (!common) {
    throw new TypeError(
      "Product Research stream returned an invalid or authority-bearing progress event",
    );
  }

  let valid = false;
  const commonKeys = [
    "type",
    "research_id",
    "request_digest",
    "sequence",
    "observed_at",
  ] as const;
  switch (event["type"]) {
    case "accepted":
      valid =
        exactKeys(event, [...commonKeys, "query"]) &&
        trimmedBoundedString(event["query"], 1_000) &&
        event["query"].length >= 2 &&
        (expected?.query === undefined || event["query"] === expected.query);
      break;
    case "interpreted":
      valid =
        exactKeys(event, [...commonKeys, "interpretation"]) &&
        validInterpretation(event["interpretation"], expected?.query);
      break;
    case "source_progress":
      valid =
        exactKeys(event, [
          ...commonKeys,
          "source_id",
          "family",
          "state",
          "reason_code",
        ]) &&
        trimmedBoundedString(event["source_id"], 256) &&
        SOURCE_FAMILIES.has(event["family"] as ProductResearchSourceFamily) &&
        [
          "started",
          "succeeded",
          "empty",
          "failed",
          "blocked",
          "cancelled",
        ].includes(String(event["state"])) &&
        (event["reason_code"] === null || reason(event["reason_code"]));
      break;
    case "candidate_observed":
      valid =
        exactKeys(event, [...commonKeys, "candidate"]) &&
        validCandidate(event["candidate"]);
      break;
    case "group_updated":
      valid =
        exactKeys(event, [...commonKeys, "group"]) &&
        validGroup(event["group"]);
      break;
    case "completed":
      try {
        if (!exactKeys(event, [...commonKeys, "result"]))
          throw new TypeError("invalid completed event shape");
        const result = reviewOnlyProductResearchResult(event["result"], {
          research_id: event["research_id"] as string,
          request_digest: event["request_digest"] as string,
          ...(expected?.query === undefined ? {} : { query: expected.query }),
        });
        valid =
          result.operational_state === "complete" ||
          result.operational_state === "partial";
      } catch {
        valid = false;
      }
      break;
    case "failed":
      try {
        if (
          !exactKeys(event, [
            ...commonKeys,
            "error_code",
            "message",
            "result",
          ]) ||
          !reason(event["error_code"]) ||
          !trimmedBoundedString(event["message"], 1_000)
        ) {
          throw new TypeError("invalid failed event shape");
        }
        const result = reviewOnlyProductResearchResult(event["result"], {
          research_id: event["research_id"] as string,
          request_digest: event["request_digest"] as string,
          ...(expected?.query === undefined ? {} : { query: expected.query }),
        });
        valid = result.operational_state === "failed";
      } catch {
        valid = false;
      }
      break;
    case "cancelled":
      try {
        if (
          !exactKeys(event, [...commonKeys, "reason_code", "result"]) ||
          !reason(event["reason_code"])
        ) {
          throw new TypeError("invalid cancelled event shape");
        }
        const result = reviewOnlyProductResearchResult(event["result"], {
          research_id: event["research_id"] as string,
          request_digest: event["request_digest"] as string,
          ...(expected?.query === undefined ? {} : { query: expected.query }),
        });
        valid = result.operational_state === "cancelled";
      } catch {
        valid = false;
      }
      break;
  }
  if (!valid) {
    throw new TypeError(
      "Product Research stream returned an invalid or authority-bearing progress event",
    );
  }
  return value as ProductResearchProgressEvent;
}

export function reviewOnlyProductResearchReplayEvent(
  value: unknown,
): ProductResearchReplayEvent {
  const event = record(value);
  const authority = record(event?.["authority"]);
  if (
    !exactKeys(event, [
      "type",
      "sequence",
      "replayed_at",
      "research_id",
      "request_digest",
      "authority",
    ]) ||
    event?.["type"] !== "replay" ||
    event["sequence"] !== 0 ||
    !timestamp(event["replayed_at"]) ||
    !trimmedBoundedString(event["research_id"], 256) ||
    !digest(event["request_digest"]) ||
    authority?.["mode"] !== "review_only" ||
    authority["action_authorized"] !== false ||
    authority["permission"] !== "withheld" ||
    !exactKeys(authority, ["mode", "action_authorized", "permission"]) ||
    containsCommerceAuthority(event)
  ) {
    throw new TypeError(
      "Product Research stream returned an invalid or authority-bearing replay event",
    );
  }
  return value as ProductResearchReplayEvent;
}
