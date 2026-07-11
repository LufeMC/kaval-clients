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
    primary_domains: NotRequired[list[str]]
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


__all__ = [
    "ActionContext",
    "ActionDecision",
    "ActionDisposition",
    "ActionReversibility",
    "AuditInput",
    "DecisionThreshold",
    "Materiality",
    "ProofGateInput",
    "ProofGateResult",
    "ProofPacket",
    "RecordRef",
]
