"""Exact TypedDict models for Kaval's public proof protocol JSON."""

from __future__ import annotations

from typing import Any, Literal, TypeAlias

try:  # Python 3.11+
    from typing import NotRequired, TypedDict
except ImportError:  # pragma: no cover - Python 3.10 uses the declared backport dependency
    from typing_extensions import NotRequired, TypedDict

IsoTimestamp: TypeAlias = str
ContentDigest: TypeAlias = str
ScalarValue: TypeAlias = str | int | float | bool | None
Materiality: TypeAlias = Literal["low", "medium", "high", "critical"]
ActionReversibility: TypeAlias = Literal[
    "reversible", "partially_reversible", "irreversible", "unknown"
]
ActionDisposition: TypeAlias = Literal["ALLOW", "BLOCK", "REVIEW"]
SystemState: TypeAlias = Literal["complete", "degraded", "source_unavailable"]


class RecordRef(TypedDict):
    system: str
    id: str
    table: NotRequired[str]


class ActionContext(TypedDict):
    description: str
    materiality: Materiality
    reversibility: ActionReversibility
    false_allow_cost_usd: NotRequired[float]
    false_block_cost_usd: NotRequired[float]
    wait_cost_usd: NotRequired[float]


class DecisionThreshold(TypedDict):
    policy_id: str
    policy_version: str
    materiality: Materiality
    maximum_false_allow_risk: float
    minimum_evidence_coverage: float


class HumanActionOverride(TypedDict):
    override_id: str
    review_case_id: str
    action_key: str
    action_context_sha256: str
    approved_by: str
    reason: str
    original_decision: ActionDisposition
    created_at: IsoTimestamp
    expires_at: IsoTimestamp


class CalibratedRisk(TypedDict):
    kind: Literal["calibrated"]
    point_estimate: float
    upper_bound: float
    calibration_version: str
    confidence_level: float


class UnavailableRisk(TypedDict):
    kind: Literal["unavailable"]
    reason: str
    evidence_strength: Literal["weak", "moderate", "strong", "decisive"]


RiskEstimate: TypeAlias = CalibratedRisk | UnavailableRisk


class ActionDecision(TypedDict):
    action_decision_id: str
    proof_id: str
    decision: ActionDisposition
    system_state: SystemState
    material_claim_ids: list[str]
    risk: RiskEstimate
    threshold: DecisionThreshold
    reason_codes: list[str]
    summary: str
    unresolved_gap_ids: list[str]
    human_override: NotRequired[HumanActionOverride]
    decided_at: IsoTimestamp
    expires_at: IsoTimestamp


class EntityRef(TypedDict):
    name: str
    id: NotRequired[str]
    type: NotRequired[str]


TemporalInterval = TypedDict(
    "TemporalInterval",
    {"from": NotRequired[IsoTimestamp], "to": NotRequired[IsoTimestamp]},
)


CanonicalClaimType: TypeAlias = Literal[
    "identity",
    "relationship",
    "numeric",
    "temporal",
    "quote",
    "existence",
    "policy",
    "legal",
    "scientific",
    "causal",
    "comparison",
    "media_authenticity",
    "generic",
]
ClaimModality: TypeAlias = Literal[
    "asserted", "scheduled", "forecast", "conditional", "opinion", "alleged", "estimated"
]


class CanonicalClaim(TypedDict):
    id: str
    text: str
    subject: EntityRef
    predicate: str
    object: NotRequired[EntityRef | ScalarValue]
    claim_type: CanonicalClaimType
    negated: bool
    modality: ClaimModality
    as_of: IsoTimestamp
    valid_time: NotRequired[TemporalInterval]
    jurisdiction: NotRequired[str]
    geography: NotRequired[str]
    units: NotRequired[str]
    denominator: NotRequired[str]
    definition: NotRequired[str]
    materiality: Materiality
    dependencies: list[str]


class ClaimDependency(TypedDict):
    claim_id: str
    depends_on_claim_id: str
    requirement: Literal["required", "supporting"]
    rationale: NotRequired[str]


class ClaimDag(TypedDict):
    schema_version: str
    claims: list[CanonicalClaim]
    roots: list[str]
    dependency_edges: list[ClaimDependency]


SourceClass: TypeAlias = Literal[
    "system_of_record",
    "regulator",
    "official_registry",
    "filing",
    "audited_report",
    "primary_document",
    "first_party",
    "peer_reviewed",
    "dataset",
    "archive",
    "expert_analysis",
    "reputable_secondary",
    "aggregator",
    "user_supplied",
    "web",
]
ArtifactKind: TypeAlias = Literal[
    "html",
    "json",
    "xml",
    "pdf",
    "text",
    "database_row",
    "api_response",
    "image",
    "audio",
    "video",
    "other",
]
LegacyAuthority: TypeAlias = Literal["primary", "secondary", "aggregator"]
SourceProximity: TypeAlias = Literal[
    "direct_record",
    "direct_measurement",
    "participant",
    "primary_analysis",
    "secondary_analysis",
    "hearsay",
]


class ProofAdmissibility(TypedDict):
    allowed_source_classes: list[SourceClass]
    forbidden_source_classes: list[SourceClass]
    allowed_artifact_kinds: list[ArtifactKind]
    required_structured_fields: list[str]
    require_raw_artifact: bool
    allow_user_supplied_as_decisive: bool


class ProofAuthorityRule(TypedDict):
    minimum_legacy_authority: LegacyAuthority
    minimum_proximity: SourceProximity
    must_include_any_source_class: list[SourceClass]
    require_authenticity: bool
    require_claim_specific_fitness: bool
    claim_specific_rule: str


class IndependenceRule(TypedDict):
    minimum_evidence_families: int
    minimum_publishers: int
    maximum_members_per_family_counted: int
    require_lineage_resolution: bool
    require_source_family_removal_test: bool
    maximum_family_removal_delta: float


class TemporalProofRule(TypedDict):
    maximum_evidence_age_s: int
    require_valid_time_overlap: bool
    require_published_by_as_of: bool
    require_known_by_as_of: bool
    allow_future_effective_evidence: bool
    future_effective_grace_s: int
    archive_requirement: Literal["never", "when_historical", "always"]


ChallengeStrategy: TypeAlias = Literal[
    "explicit_counter_hypothesis",
    "negated_search",
    "current_holder_search",
    "primary_source_recovery",
    "correction_retraction_search",
    "source_family_removal",
    "evidence_order_perturbation",
    "adversarial_near_miss",
]


class ChallengeRule(TypedDict):
    required: bool
    strategies: list[ChallengeStrategy]
    minimum_counterevidence_queries: int
    require_strongest_opposing_interpretation: bool
    require_stopping_reason: bool


InvalidationTrigger: TypeAlias = Literal[
    "source_changed",
    "source_retracted",
    "source_unavailable",
    "newer_authoritative_evidence",
    "entity_resolution_changed",
    "policy_changed",
    "calibration_changed",
    "valid_time_boundary",
    "manual_correction",
]


class PolicyExpiryRule(TypedDict):
    ttl_s: int
    recheck_before_expiry_s: int
    invalidation_triggers: list[InvalidationTrigger]


class ActionThreshold(TypedDict):
    materiality: Materiality
    maximum_false_allow_risk: float
    minimum_evidence_coverage: float
    minimum_support_probability: float
    on_uncalibrated: Literal["BLOCK", "REVIEW"]
    on_degraded: Literal["BLOCK", "REVIEW"]


class ProofPolicy(TypedDict):
    policy_id: str
    version: str
    effective_from: IsoTimestamp
    superseded_at: NotRequired[IsoTimestamp]
    claim_types: list[CanonicalClaimType]
    semantics: Literal["open_world", "closed_world"]
    admissibility: ProofAdmissibility
    authority: ProofAuthorityRule
    independence: IndependenceRule
    temporal: TemporalProofRule
    challenge: ChallengeRule
    conflict_resolution: list[str]
    force_review_conditions: list[str]
    expiry: PolicyExpiryRule
    action_thresholds: list[ActionThreshold]


class ArtifactEncryption(TypedDict):
    scheme: str
    key_reference: str


class RawArtifactMetadata(TypedDict):
    artifact_id: str
    storage_ref: str
    kind: ArtifactKind
    media_type: str
    byte_length: int
    content_hash: ContentDigest
    captured_at: IsoTimestamp
    compression: Literal["none", "gzip", "br", "zstd", "other"]
    encryption: NotRequired[ArtifactEncryption]
    redaction_state: Literal["none", "metadata_only", "redacted", "sealed"]


class HttpArtifactMetadata(TypedDict):
    status: int
    etag: NotRequired[str]
    last_modified: NotRequired[str]
    content_type: NotRequired[str]
    requested_url: NotRequired[str]
    final_url: NotRequired[str]


class SourceVersion(TypedDict):
    source_version_id: str
    source_id: str
    source_signature: str
    source_class: SourceClass
    legacy_authority: LegacyAuthority
    canonical_url: NotRequired[str]
    raw_artifact: RawArtifactMetadata
    http: NotRequired[HttpArtifactMetadata]
    version_state: Literal["active", "superseded", "corrected", "retracted", "unavailable"]
    published_at: NotRequired[IsoTimestamp]
    modified_at: NotRequired[IsoTimestamp]
    observed_at: IsoTimestamp
    known_at: NotRequired[IsoTimestamp]
    valid_time: NotRequired[TemporalInterval]
    publisher_id: NotRequired[str]
    author_id: NotRequired[str]
    owner_id: NotRequired[str]
    discovery_providers: list[str]
    acquisition_activity_id: str
    supersedes_source_version_id: NotRequired[str]
    correction_notice_source_version_id: NotRequired[str]


class TextLocator(TypedDict):
    kind: Literal["text_offsets"]
    start: int
    end: int


class JsonLocator(TypedDict):
    kind: Literal["json_pointer"]
    pointer: str


class HtmlLocator(TypedDict):
    kind: Literal["html_selector"]
    selector: str
    text_start: NotRequired[int]
    text_end: NotRequired[int]


class PdfLocator(TypedDict):
    kind: Literal["pdf_region"]
    page: int
    bounding_box: list[float]


class TableLocator(TypedDict):
    kind: Literal["table_cell"]
    table: str
    row: str | int
    column: str | int


class RecordLocator(TypedDict):
    kind: Literal["record_field"]
    system: str
    table: str
    record_id: str
    field: str


class MediaLocator(TypedDict):
    kind: Literal["media_time"]
    start_ms: int
    end_ms: int


EvidenceLocator: TypeAlias = (
    TextLocator | JsonLocator | HtmlLocator | PdfLocator | TableLocator | RecordLocator | MediaLocator
)


class EvidenceSpan(TypedDict):
    evidence_span_id: str
    source_version_id: str
    locator: EvidenceLocator
    quote: NotRequired[str]
    structured_value: NotRequired[ScalarValue]
    span_hash: ContentDigest
    language: NotRequired[str]
    extracted_at: IsoTimestamp
    visibility: Literal["public", "tenant_private", "restricted"]
    quarantined: bool
    injection_detected: bool


class LineageEdge(TypedDict):
    lineage_edge_id: str
    from_source_version_id: str
    to_source_version_id: str
    relationship: Literal[
        "derived_from",
        "copied_from",
        "syndicated_from",
        "quotes",
        "cites",
        "updates",
        "supersedes",
        "corrects",
        "retracts",
    ]
    confidence: float
    explicit_attribution: bool
    evidence_span_ids: list[str]


class EvidenceFamily(TypedDict):
    evidence_family_id: str
    label: str
    member_source_version_ids: list[str]
    origin_source_version_ids: list[str]
    lineage_edge_ids: list[str]
    methods: list[
        Literal[
            "explicit_attribution",
            "exact_text",
            "near_duplicate",
            "shared_origin",
            "publisher_ownership",
            "manual",
        ]
    ]
    publisher_group_id: NotRequired[str]
    upstream_dataset_id: NotRequired[str]
    confidence: float
    independence_rationale: str


class StanceProbabilities(TypedDict):
    support: float
    refute: float
    neutral: float


class EntityFit(TypedDict):
    state: Literal["match", "partial", "mismatch", "unknown"]
    score: float
    rationale: str


class ScopeFit(TypedDict):
    state: Literal["exact", "partial", "mismatch", "unknown"]
    score: float
    rationale: str


class TemporalFit(TypedDict):
    state: Literal["applicable", "partial", "inapplicable", "unknown"]
    score: float
    rationale: str


class EvidenceAssessment(TypedDict):
    evidence_assessment_id: str
    claim_id: str
    evidence_span_id: str
    evidence_family_id: str
    stance: StanceProbabilities
    entity_match: EntityFit
    scope_fit: ScopeFit
    temporal_fit: TemporalFit
    extraction_confidence: float
    source_fitness: float
    support_mode: Literal["direct", "inferential"]
    admissible: bool
    exclusion_reason: NotRequired[str]


AssessmentGapKind: TypeAlias = Literal[
    "missing_authority",
    "missing_independence",
    "missing_counterevidence_search",
    "entity_ambiguity",
    "scope_mismatch",
    "temporal_ambiguity",
    "source_unavailable",
    "conflict_unresolved",
    "calibration_unavailable",
    "policy_incomplete",
    "other",
]


class AssessmentGap(TypedDict):
    gap_id: str
    kind: AssessmentGapKind
    severity: Literal["informational", "material", "blocking"]
    description: str
    resolvable: bool
    required_evidence: list[str]


class CalibratedSupport(TypedDict):
    probability: float
    calibration_version: str


class CalibrationSupportIdentity(TypedDict):
    """Exact server-derived cohort identity used to issue this claim assessment."""

    feature_schema_version: str
    feature_schema_hash: ContentDigest
    support_fingerprint: ContentDigest
    feature_vector: dict[str, Any]


class ClaimAssessment(TypedDict):
    claim_assessment_id: str
    claim_id: str
    claim_state: Literal["supported", "refuted", "mixed", "unresolved", "unverifiable"]
    temporal_state: Literal["current", "superseded", "future", "expired", "unknown"]
    system_state: SystemState
    stance: StanceProbabilities
    evidence_coverage: float
    calibrated_support: NotRequired[CalibratedSupport]
    calibration_support: CalibrationSupportIdentity
    risk_upper_bound: NotRequired[float]
    evidence_assessments: list[EvidenceAssessment]
    decisive_evidence_span_ids: list[str]
    counterevidence_span_ids: list[str]
    unresolved_gaps: list[AssessmentGap]
    what_would_change_this: list[str]
    assessed_at: IsoTimestamp


class ProtocolManifest(TypedDict):
    protocol: Literal["kaval-proof"]
    protocol_version: str
    schema_version: str
    compiler_version: str
    planner_version: str
    adjudicator_version: str
    model_versions: dict[str, str]
    tool_versions: dict[str, str]
    parser_versions: dict[str, str]


class PolicyBinding(TypedDict):
    claim_id: str
    policy_id: str
    policy_version: str
    policy_hash: ContentDigest


class CalibrationMetrics(TypedDict):
    brier_score: float
    log_loss: float
    expected_calibration_error: float
    sample_size: int


class AvailableCalibration(TypedDict):
    status: Literal["calibrated"]
    version: str
    protocol_version: str
    training_dataset_hash: ContentDigest
    evaluation_dataset_hash: ContentDigest
    feature_schema_version: str
    feature_schema_hash: ContentDigest
    method: str
    trained_through: IsoTimestamp
    applicable_claim_types: list[str]
    applicable_domains: list[str]
    metrics: CalibrationMetrics


class WithheldCalibration(TypedDict):
    status: Literal["withheld"]
    reason: str
    evidence_strength_scale_version: str


CalibrationManifest: TypeAlias = AvailableCalibration | WithheldCalibration
ProvenanceActivityKind: TypeAlias = Literal[
    "compile",
    "plan",
    "search",
    "fetch",
    "render",
    "parse",
    "extract",
    "entity_resolve",
    "lineage_cluster",
    "adjudicate",
    "challenge",
    "calibrate",
    "decide",
]


class ProvenanceActivity(TypedDict):
    activity_id: str
    kind: ProvenanceActivityKind
    parent_activity_ids: list[str]
    status: Literal["completed", "failed", "cancelled", "timed_out"]
    provider: NotRequired[str]
    tool_version: NotRequired[str]
    model_version: NotRequired[str]
    parser_version: NotRequired[str]
    parameters_hash: ContentDigest
    input_hashes: list[ContentDigest]
    output_hashes: list[ContentDigest]
    started_at: IsoTimestamp
    completed_at: IsoTimestamp
    error_code: NotRequired[str]


class ResearchContract(TypedDict):
    held_belief: str
    as_of: IsoTimestamp
    action: ActionContext
    domain: NotRequired[str]
    subject_hint: NotRequired[str]
    jurisdiction: NotRequired[str]
    geography: NotRequired[str]
    units: NotRequired[str]


class ProofProvenance(TypedDict):
    activities: list[ProvenanceActivity]
    root_activity_ids: list[str]
    research_stopping_reason: str


class ProofExpiry(TypedDict):
    issued_at: IsoTimestamp
    expires_at: IsoTimestamp
    recheck_at: IsoTimestamp
    invalidation_triggers: list[InvalidationTrigger]
    monitor_id: NotRequired[str]


class PacketSignature(TypedDict):
    algorithm: str
    key_id: str
    signature: str


class ProofPacket(TypedDict):
    proof_id: str
    created_at: IsoTimestamp
    research_contract: ResearchContract
    protocol: ProtocolManifest
    claim_dag: ClaimDag
    policies: list[ProofPolicy]
    policy_bindings: list[PolicyBinding]
    source_versions: list[SourceVersion]
    evidence_spans: list[EvidenceSpan]
    evidence_families: list[EvidenceFamily]
    lineage_edges: list[LineageEdge]
    claim_assessments: list[ClaimAssessment]
    action_decision: ActionDecision
    calibration: CalibrationManifest
    provenance: ProofProvenance
    expiry: ProofExpiry
    signature: NotRequired[PacketSignature]


class AuditInput(TypedDict):
    text: str
    as_of: IsoTimestamp
    materiality: NotRequired[Materiality]
    intended_action: NotRequired[str]
    reversibility: NotRequired[ActionReversibility]
    false_allow_cost_usd: NotRequired[float]
    false_block_cost_usd: NotRequired[float]
    wait_cost_usd: NotRequired[float]
    domain: NotRequired[str]
    subject_hint: NotRequired[str]
    jurisdiction: NotRequired[str]
    geography: NotRequired[str]
    units: NotRequired[str]
    context: NotRequired[str]
    aliases: NotRequired[list[str]]
    origin_urls: NotRequired[list[str]]
    record: NotRequired[RecordRef]
    record_field: NotRequired[str]


class ProofGateInputBase(TypedDict):
    expected_dependency_versions: NotRequired[dict[str, str]]
    material_claim_ids: list[str]
    threshold: DecisionThreshold
    action: ActionContext


class ProofGateByIdInput(ProofGateInputBase):
    proof_id: str


class ProofGateByKeyInput(ProofGateInputBase):
    proof_key: str


ProofGateInput: TypeAlias = ProofGateByIdInput | ProofGateByKeyInput
ProofGateState: TypeAlias = Literal[
    "current",
    "expired",
    "not_yet_valid",
    "invalidated",
    "dependency_changed",
    "integrity_failed",
    "policy_mismatch",
    "not_found",
    "operational_failure",
]
ProofBillingClass: TypeAlias = Literal[
    "action_gate", "direct_refresh", "web_refresh", "deep_refresh", "operational_failure"
]


class ProofEnforcementResult(TypedDict):
    mode: Literal["shadow", "block_only", "bounded"]
    controlApplied: bool
    executionAllowed: bool | None
    wouldAllow: bool
    reason: str


class ProofGateResult(TypedDict):
    proofId: str
    state: ProofGateState
    decision: ActionDecision
    billingClass: ProofBillingClass
    proofReused: bool
    researchPerformed: Literal[False]
    humanOverrideApplied: NotRequired[Literal[True]]
    latencyMs: float
    reason: NotRequired[str]
    enforcement: NotRequired[ProofEnforcementResult]


# Offer Search is intentionally a separate review-only result family. It preserves the hosted
# commerce contract without widening ActionDisposition: the current endpoint cannot emit ALLOW or
# SAFE_TO_QUOTE.
ProductIdentifierScheme: TypeAlias = Literal[
    "gtin", "upc", "ean", "isbn", "mpn", "manufacturer_sku", "model"
]
ProductCondition: TypeAlias = Literal[
    "new",
    "open_box",
    "refurbished",
    "used_like_new",
    "used_good",
    "used_acceptable",
    "unknown",
]
SellerKind: TypeAlias = Literal[
    "brand_direct", "authorized_retailer", "marketplace", "independent_retailer", "unknown"
]


class ProductIdentifier(TypedDict):
    scheme: ProductIdentifierScheme
    value: str
    issuer: NotRequired[str]


class ProductAttribute(TypedDict):
    key: str
    value: str | int | float | bool
    unit: NotRequired[str]


class PackSpec(TypedDict):
    count: int
    units_per_item: NotRequired[int | float]
    unit: NotRequired[str]


class ProductFamilyHint(TypedDict):
    brand: NotRequired[str]
    name: NotRequired[str]
    category: NotRequired[str]


class ProductTarget(TypedDict):
    schema_revision: int
    family: NotRequired[ProductFamilyHint]
    name: NotRequired[str]
    identifiers: list[ProductIdentifier]
    attributes: list[ProductAttribute]
    pack: NotRequired[PackSpec]


class ProductFamily(TypedDict):
    schema_revision: int
    family_id: str
    brand: str
    name: str
    category: NotRequired[str]
    identifiers: list[ProductIdentifier]


class ProductVariant(TypedDict):
    schema_revision: int
    variant_id: str
    family: ProductFamily
    name: str
    identifiers: list[ProductIdentifier]
    attributes: list[ProductAttribute]
    pack: PackSpec


class AttributeSubstitution(TypedDict):
    rule_id: str
    rationale: str
    maximum_materiality: Materiality
    kind: Literal["attribute"]
    key: str
    requested_value: str | int | float | bool
    permitted_value: str | int | float | bool
    requested_unit: NotRequired[str]
    permitted_unit: NotRequired[str]


class PackSubstitution(TypedDict):
    rule_id: str
    rationale: str
    maximum_materiality: Materiality
    kind: Literal["pack"]
    requested: PackSpec
    permitted: PackSpec


class ConditionSubstitution(TypedDict):
    rule_id: str
    rationale: str
    maximum_materiality: Materiality
    kind: Literal["condition"]
    requested: ProductCondition
    permitted: ProductCondition


class VariantSubstitution(TypedDict):
    rule_id: str
    rationale: str
    maximum_materiality: Materiality
    kind: Literal["variant"]
    requested_identifiers: list[ProductIdentifier]
    permitted_variant_id: str
    permitted_identifiers: list[ProductIdentifier]


PermittedSubstitution: TypeAlias = (
    AttributeSubstitution | PackSubstitution | ConditionSubstitution | VariantSubstitution
)


class OfferDestination(TypedDict):
    country_code: str
    region: NotRequired[str]
    postal_code: NotRequired[str]


class OfferMatchPolicy(TypedDict):
    identity_requirement: Literal["shared_identifier", "shared_identifier_or_complete_attributes"]
    required_identifier_schemes: list[ProductIdentifierScheme]
    required_attribute_keys: list[str]
    permitted_substitutions: list[PermittedSubstitution]


class OfferSellerPolicy(TypedDict):
    allowed_seller_ids: list[str]
    blocked_seller_ids: list[str]
    allowed_kinds: list[SellerKind]
    require_authorized: bool


class OfferDestinationPolicy(TypedDict):
    require_eligible: bool
    require_exact_region: bool
    require_exact_postal_code: bool


class OfferPricePolicy(TypedDict):
    currency: str
    maximum_landed_total_minor: NotRequired[int]
    require_complete_landed_total: bool
    allow_estimated_components: bool
    allow_member_price: bool
    allow_subscription_price: bool
    allow_coupon_price: bool
    allow_installment_display: bool
    allow_trade_in_price: bool


class OfferSourcePolicy(TypedDict):
    allowed_source_ids: list[str]
    blocked_source_ids: list[str]
    require_origin_evidence: bool


class OfferIntendedAction(TypedDict):
    description: str
    materiality: Materiality
    reversibility: Literal["reversible", "partially_reversible", "irreversible"]


class OfferSearchInput(TypedDict):
    schema_revision: int
    request_id: str
    raw_description: str
    target: ProductTarget
    requested_condition: ProductCondition
    destination: OfferDestination
    match_policy: OfferMatchPolicy
    seller_policy: OfferSellerPolicy
    destination_policy: OfferDestinationPolicy
    price_policy: OfferPricePolicy
    source_policy: OfferSourcePolicy
    intended_action: OfferIntendedAction
    freshness_maximum_age_ms: int
    max_results: int
    minimum_unique_sellers: int
    deadline_ms: int
    maximum_cost_micro_usd: int
    maximum_search_calls: int
    maximum_fetches: int


class Money(TypedDict):
    amount_minor: int
    currency: str


CommerceSourceFamily: TypeAlias = Literal[
    "catalog",
    "merchant_feed",
    "retailer_origin",
    "shopping_search",
    "open_web",
]


class CommerceCheckoutResolverDescriptor(TypedDict):
    schema_revision: Literal[1]
    source_id: str
    adapter_revision: str
    execution_mode: Literal["recorded_fixture", "live"]
    estimated_cost_micro_usd: int


class CommerceCheckoutObservation(TypedDict):
    destination_eligibility: Literal["eligible", "ineligible", "unknown"]
    availability: Literal["in_stock", "out_of_stock", "preorder", "unknown"]
    seller_authorized: bool | None
    item_price: Money | None
    shipping_price: Money | None
    tax_price: Money | None
    mandatory_fees: Money | None
    declared_landed_total: Money | None
    quote_id: str | None
    evidence_digest: ContentDigest
    observed_at: IsoTimestamp
    expires_at: IsoTimestamp


LandedPriceValidationReason: TypeAlias = Literal[
    "EXPECTED_CURRENCY_INVALID",
    "ITEM_PRICE_MISSING",
    "SHIPPING_PRICE_MISSING",
    "TAX_PRICE_MISSING",
    "MANDATORY_FEES_MISSING",
    "DECLARED_LANDED_TOTAL_MISSING",
    "MONEY_VALUE_INVALID",
    "PRICE_CURRENCY_CONFLICT",
    "LANDED_TOTAL_OVERFLOW",
    "LANDED_TOTAL_ARITHMETIC_MISMATCH",
]


class LandedPriceValidation(TypedDict):
    state: Literal["complete", "incomplete", "invalid", "inconsistent"]
    expected_currency: str
    calculated_landed_total: Money | None
    reason_codes: list[LandedPriceValidationReason]


class CommerceCheckoutAction(TypedDict):
    state: Literal["REVIEW"]
    action_authorized: Literal[False]
    reason_codes: list[str]


CheckoutOperationalErrorCode: TypeAlias = Literal[
    "UPSTREAM_UNAVAILABLE",
    "DESTINATION_UNSUPPORTED",
    "MALFORMED_RESPONSE",
    "RIGHTS_REVOKED",
    "CANCELLED",
]


class CommerceCheckoutVerification(TypedDict):
    status: Literal["verified", "review_required", "rejected", "operational_failure"]
    resolver: CommerceCheckoutResolverDescriptor | None
    request_digest: ContentDigest
    observation: CommerceCheckoutObservation | None
    landed_price_validation: LandedPriceValidation
    action: CommerceCheckoutAction
    actual_cost_micro_usd: int
    version_receipt: str | None
    operational_error_code: CheckoutOperationalErrorCode | None


class ExtractedOriginOffer(TypedDict):
    evidence_kind: Literal["json_ld", "embedded_product_json", "product_meta"]
    source_block_index: int
    jsonld_product_index: int
    jsonld_offer_index: int | None
    variant: ProductVariant
    title: str
    purchase_url: str
    seller_name: str | None
    condition: ProductCondition
    availability: Literal["in_stock", "out_of_stock", "preorder", "unknown"]
    item_price: Money | None
    destination_eligibility: Literal["unknown"]
    landed_price_complete: Literal[False]
    extraction_gaps: list[str]


OfferConflictCode: TypeAlias = Literal[
    "FAMILY_BRAND_CONFLICT",
    "FAMILY_NAME_CONFLICT",
    "IDENTIFIER_CONFLICT",
    "IDENTIFIER_AMBIGUOUS",
    "IDENTIFIER_MISSING",
    "ATTRIBUTE_CONFLICT",
    "ATTRIBUTE_MISSING",
    "PACK_CONFLICT",
    "PACK_INCOMPLETE",
    "CONDITION_CONFLICT",
    "SELLER_BLOCKED",
    "SELLER_NOT_ALLOWED",
    "SELLER_KIND_NOT_ALLOWED",
    "SELLER_AUTHORIZATION_REQUIRED",
    "DESTINATION_CONFLICT",
    "DESTINATION_INELIGIBLE",
    "DESTINATION_UNKNOWN",
    "CURRENCY_CONFLICT",
    "PRICE_LIMIT_EXCEEDED",
    "PRICE_INCOMPLETE",
    "MATERIAL_EVIDENCE_MISSING",
    "OBSERVATION_EXPIRED",
]


class OfferMatchAssessment(TypedDict):
    state: Literal["exact", "permitted_substitute", "ambiguous", "conflict", "insufficient_identity"]
    conflict_codes: list[OfferConflictCode]
    matched_identifier_schemes: list[ProductIdentifierScheme]
    matched_attribute_keys: list[str]
    applied_substitutions: list[PermittedSubstitution]
    explanation: str


class OfferDiscoveryMetadata(TypedDict):
    provider: str
    title: str | None


class OfferOriginEvidence(TypedDict):
    kind: Literal["json_ld", "embedded_product_json", "product_meta"]
    content_digest: ContentDigest
    source_block_index: int
    jsonld_product_index: int
    jsonld_offer_index: int | None


class LiveOfferSearchCandidate(TypedDict):
    candidate_id: ContentDigest
    origin_url: str
    source_id: str
    discovered_by: list[str]
    discovery_metadata: list[OfferDiscoveryMetadata]
    origin_evidence: OfferOriginEvidence
    origin_offer: ExtractedOriginOffer
    identity: OfferMatchAssessment
    disposition: Literal["review", "rejected"]
    gaps: list[str]
    reason_codes: list[str]
    checkout: NotRequired[CommerceCheckoutVerification]


class CommercePlannedSource(TypedDict):
    source_id: str
    family: CommerceSourceFamily
    call_kind: Literal["search", "fetch"]
    independence_group: str
    estimated_cost_micro_usd: int
    field_guarantees: list[str]
    health_state: Literal["healthy", "degraded"]
    concurrency_limit: int
    supports_cancellation: bool
    role: Literal["structured_acquisition", "origin_verification", "discovery_tail"]
    winner_must_be_origin_verified: Literal[True]


class CommerceSourcePlanWave(TypedDict):
    wave: int
    purpose: Literal[
        "structured_authoritative",
        "retailer_origin",
        "unresolved_identity_and_coverage",
    ]
    sources: list[CommercePlannedSource]


class CommerceSourcePlanExclusion(TypedDict):
    source_id: str
    family: CommerceSourceFamily
    call_kind: Literal["search", "fetch"]
    estimated_cost_micro_usd: int
    reason: str


class CommerceSourcePlanReceipt(TypedDict):
    schema_revision: int
    request_id: str
    coverage_claim: Literal["bounded_not_comprehensive"]
    name_only_target: bool
    minimum_independent_families_required: int
    planned_independent_families: list[CommerceSourceFamily]
    planned_independence_groups: list[str]
    independence_requirement_met: bool
    origin_verification_required: Literal[True]
    origin_verification_planned: bool
    origin_verification_source_ids: list[str]
    eligible_supplier_count_before_budget: int
    total_planned_cost_micro_usd: int
    total_planned_search_calls: int
    total_planned_fetches: int
    exclusions: list[CommerceSourcePlanExclusion]


class CommerceSourcePlan(TypedDict):
    schema_revision: int
    request_id: str
    request_digest: ContentDigest
    supplier_registry_schema_revision: int
    supplier_registry_digest: ContentDigest
    waves: list[CommerceSourcePlanWave]
    receipt: CommerceSourcePlanReceipt


class CommerceAcquisitionSourceLedgerEntry(TypedDict):
    source_id: str
    family: CommerceSourceFamily
    disposition: Literal[
        "succeeded",
        "failed",
        "cancelled",
        "prohibited",
        "deferred",
        "unsearched",
    ]
    reason_code: str


class CommerceAcquisitionCoverage(TypedDict):
    claim: Literal["bounded_not_comprehensive"]
    attempted_source_families: list[CommerceSourceFamily]
    unique_candidate_keys: int
    unique_sellers: int
    unsearched_source_count: int
    prohibited_source_count: int
    failed_source_count: int


class CommerceAcquisitionDeduplication(TypedDict):
    source_records: int
    unique_urls: int
    unique_variants: int
    unique_sellers: int
    unique_listings: int
    unique_offers: int
    independent_information_origins: int


class CommerceAcquisitionStop(TypedDict):
    reason: Literal[
        "coverage_satisfied",
        "source_exhausted",
        "budget_exhausted",
        "deadline_reached",
        "cancelled",
        "upstream_unavailable",
        "policy_blocked",
    ]
    explanation: str


class CommerceAcquisitionRunReport(TypedDict):
    schema_revision: Literal[1]
    request_digest: ContentDigest
    plan: CommerceSourcePlan
    state: dict[str, Any]
    stop: CommerceAcquisitionStop
    calls: list[dict[str, Any]]
    records: list[dict[str, Any]]
    source_ledger: list[CommerceAcquisitionSourceLedgerEntry]
    coverage: CommerceAcquisitionCoverage
    deduplication: CommerceAcquisitionDeduplication
    replay_digest: ContentDigest


class LiveOfferSearchAcquisitionTrace(TypedDict):
    coverage_claim: Literal["bounded_not_comprehensive"]
    plan: CommerceSourcePlan
    plan_digest: ContentDigest
    source_ledger: list[CommerceAcquisitionSourceLedgerEntry]
    adapter_run: NotRequired[CommerceAcquisitionRunReport]


class CommerceActionBinding(TypedDict):
    """Digests binding a persisted evidence generation to one exact downstream action slot."""

    action_slot_key: str
    action_input_digest: ContentDigest
    action_consequence_digest: ContentDigest


CommerceActionTimeGateState: TypeAlias = Literal[
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
]


class CommerceActionTimeGateInput(TypedDict):
    """Exact POST /v1/search-offers/gate body; tenant identity is server-derived."""

    dependency_id: str
    generation_id: str
    generation_number: int
    generation_digest: ContentDigest
    action_binding: CommerceActionBinding


class CommerceActionTimeGateResult(TypedDict):
    """Final-fence result. Commerce permission remains withheld even when evidence is current."""

    state: CommerceActionTimeGateState
    disposition: Literal["REVIEW"]
    permission: Literal["withheld"]
    reason_codes: list[str]
    checked_at: IsoTimestamp
    final_fence_checked: bool
    generation_id: NotRequired[str]
    generation_number: NotRequired[int]
    generation_digest: NotRequired[ContentDigest]
    expires_at: NotRequired[IsoTimestamp]


class CommercePersistedOfferSearchLifecycle(TypedDict):
    persistence: Literal["persisted"]
    dependency_id: str
    generation_id: str
    generation_number: int
    generation_digest: ContentDigest
    selected_candidate_id: ContentDigest
    expires_at: IsoTimestamp
    action_binding: CommerceActionBinding
    action_time_gate: CommerceActionTimeGateResult


class CommerceNotCreatedActionTimeGate(TypedDict):
    state: Literal["not_found"]
    disposition: Literal["REVIEW"]
    permission: Literal["withheld"]
    reason_codes: list[str]
    checked_at: IsoTimestamp
    final_fence_checked: bool


class CommerceNotCreatedOfferSearchLifecycle(TypedDict):
    persistence: Literal["not_created"]
    reason_codes: list[str]
    action_time_gate: CommerceNotCreatedActionTimeGate


CommerceOfferSearchLifecycle: TypeAlias = (
    CommercePersistedOfferSearchLifecycle | CommerceNotCreatedOfferSearchLifecycle
)


OfferSourceAttemptErrorCode: TypeAlias = Literal[
    "INVALID_DISCOVERY_URL",
    "DISCOVERY_IDENTIFIER_MISMATCH",
    "ORIGIN_BLOCKED",
    "ORIGIN_HTTP_ERROR",
    "ORIGIN_JSONLD_INVALID",
    "ORIGIN_TIMEOUT",
    "ORIGIN_UNAVAILABLE",
    "SEARCH_UNAVAILABLE",
    "BUDGET_EXHAUSTED",
    "DEADLINE_REACHED",
    "CANCELLED",
    "COVERAGE_SATISFIED",
]


class CommerceLiveSourceAttempt(TypedDict):
    sequence: int
    kind: Literal["search", "origin_fetch"]
    call_attempted: bool
    source_id: str
    provider: str | None
    query: str | None
    url: str | None
    outcome: Literal["succeeded", "empty", "failed", "blocked", "skipped", "cancelled"]
    error_code: OfferSourceAttemptErrorCode | None
    latency_ms: int
    cost_micro_usd: int
    reuse: Literal["executed", "tenant_private_cache"]
    avoided_cost_micro_usd: int
    result_count: int | None
    http_status: int | None
    bytes_received: int | None


OfferSearchStopReason: TypeAlias = Literal[
    "coverage_satisfied",
    "sufficient_offers",
    "source_exhausted",
    "budget_exhausted",
    "deadline_reached",
    "cancelled",
    "upstream_unavailable",
    "policy_blocked",
]


class OfferSearchAction(TypedDict):
    state: Literal["NEEDS_REVIEW", "NO_RELIABLE_OFFER"]
    reason_codes: list[str]


class OfferSearchReceipt(TypedDict):
    search_calls: int
    fetch_calls: int
    providers_configured: int
    providers_succeeded: int
    cost_micro_usd: int
    cost_basis: Literal["reserved_ceiling"]
    provider_estimated_cost_micro_usd: int | None
    provider_estimated_cost_reported_search_calls: int
    discovery_cache_hits: int
    cost_avoided_micro_usd: int
    elapsed_ms: int


class LiveOfferSearchResult(TypedDict):
    schema_revision: Literal[2]
    request_id: str
    request_digest: ContentDigest
    status: Literal["complete", "partial", "failed"]
    action: OfferSearchAction
    stop_reason: OfferSearchStopReason
    query: str | None
    candidates: list[LiveOfferSearchCandidate]
    source_attempts: list[CommerceLiveSourceAttempt]
    receipt: OfferSearchReceipt
    started_at: IsoTimestamp
    completed_at: IsoTimestamp
    # Auditable plan, rights, coverage, and attempted-source trace.
    acquisition: NotRequired[LiveOfferSearchAcquisitionTrace]
    # Present only when the hosted server has a configured durable commerce lifecycle.
    lifecycle: NotRequired[CommerceOfferSearchLifecycle]


OfferSearchProgressStage: TypeAlias = Literal[
    "accepted",
    "acquisition",
    "verification",
    "coverage",
    "candidate_provisional",
    "candidate",
    "warning",
]


class OfferSearchStageEvent(TypedDict):
    type: Literal[
        "accepted",
        "acquisition",
        "verification",
        "coverage",
        "candidate",
        "warning",
    ]
    sequence: int
    at: IsoTimestamp
    request_id: str
    message: str
    authority: Literal["research_only"]
    action_state: Literal["REVIEW"]
    details: dict[str, Any]


class OfferSearchProvisionalCandidateDetails(TypedDict):
    request_digest: ContentDigest
    origin_sequence: int
    publication_state: Literal["provisional"]
    durable: Literal[False]
    actionable: Literal[False]
    permission: Literal["withheld"]
    final_inclusion: Literal["not_yet_determined"]
    candidate: LiveOfferSearchCandidate


class OfferSearchProvisionalCandidateEvent(TypedDict):
    type: Literal["candidate_provisional"]
    sequence: int
    at: IsoTimestamp
    request_id: str
    message: str
    authority: Literal["research_only"]
    action_state: Literal["REVIEW"]
    details: OfferSearchProvisionalCandidateDetails


OfferSearchProgressEvent: TypeAlias = (
    OfferSearchStageEvent | OfferSearchProvisionalCandidateEvent
)


class OfferSearchReplayEvent(TypedDict):
    type: Literal["replay"]
    sequence: int
    replayed_at: IsoTimestamp
    request_id: str
    request_digest: ContentDigest
    authority: Literal["research_only"]
    action_state: Literal["REVIEW"]


class OfferSearchFinalEvent(TypedDict):
    type: Literal["final"]
    sequence: int
    result: LiveOfferSearchResult


OfferSearchStreamEvent: TypeAlias = (
    OfferSearchProgressEvent | OfferSearchReplayEvent | OfferSearchFinalEvent
)


__all__ = [
    "ActionContext",
    "ActionDecision",
    "ActionDisposition",
    "ActionReversibility",
    "AuditInput",
    "CommerceActionBinding",
    "CommerceActionTimeGateInput",
    "CommerceActionTimeGateResult",
    "CommerceAcquisitionSourceLedgerEntry",
    "CommerceCheckoutVerification",
    "CommerceOfferSearchLifecycle",
    "DecisionThreshold",
    "LiveOfferSearchAcquisitionTrace",
    "Materiality",
    "LiveOfferSearchResult",
    "OfferSearchFinalEvent",
    "OfferSearchInput",
    "OfferSearchProgressEvent",
    "OfferSearchProvisionalCandidateDetails",
    "OfferSearchProvisionalCandidateEvent",
    "OfferSearchReplayEvent",
    "OfferSearchStageEvent",
    "OfferSearchStreamEvent",
    "ProofGateInput",
    "ProofGateResult",
    "ProofPacket",
    "RecordRef",
]
