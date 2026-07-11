/** Public proof-protocol types. Field names intentionally match the hosted REST JSON exactly. */

export type IsoTimestamp = string;
export type ContentDigest = string;
export type ScalarValue = string | number | boolean | null;
export type Materiality = "low" | "medium" | "high" | "critical";
export type ActionReversibility =
  "reversible" | "partially_reversible" | "irreversible" | "unknown";
export type ActionDisposition = "ALLOW" | "BLOCK" | "REVIEW";
export type SystemState = "complete" | "degraded" | "source_unavailable";

export interface RecordRef {
  system: string;
  id: string;
  table?: string;
}

export interface ActionContext {
  description: string;
  materiality: Materiality;
  reversibility: ActionReversibility;
  false_allow_cost_usd?: number;
  false_block_cost_usd?: number;
  wait_cost_usd?: number;
}

export interface DecisionThreshold {
  policy_id: string;
  policy_version: string;
  materiality: Materiality;
  maximum_false_allow_risk: number;
  minimum_evidence_coverage: number;
}

export interface HumanActionOverride {
  override_id: string;
  review_case_id: string;
  action_key: string;
  action_context_sha256: string;
  approved_by: string;
  reason: string;
  original_decision: ActionDisposition;
  created_at: IsoTimestamp;
  expires_at: IsoTimestamp;
}

export interface CalibratedRisk {
  kind: "calibrated";
  point_estimate: number;
  upper_bound: number;
  calibration_version: string;
  confidence_level: number;
}

export interface UnavailableRisk {
  kind: "unavailable";
  reason: string;
  evidence_strength: "weak" | "moderate" | "strong" | "decisive";
}

export type RiskEstimate = CalibratedRisk | UnavailableRisk;

export interface ActionDecision {
  action_decision_id: string;
  proof_id: string;
  decision: ActionDisposition;
  system_state: SystemState;
  material_claim_ids: string[];
  risk: RiskEstimate;
  threshold: DecisionThreshold;
  reason_codes: string[];
  summary: string;
  unresolved_gap_ids: string[];
  human_override?: HumanActionOverride;
  decided_at: IsoTimestamp;
  expires_at: IsoTimestamp;
}

export interface EntityRef {
  name: string;
  id?: string;
  type?: string;
}

export interface TemporalInterval {
  from?: IsoTimestamp;
  to?: IsoTimestamp;
}

export type CanonicalClaimType =
  | "identity"
  | "relationship"
  | "numeric"
  | "temporal"
  | "quote"
  | "existence"
  | "policy"
  | "legal"
  | "scientific"
  | "causal"
  | "comparison"
  | "media_authenticity"
  | "generic";

export type ClaimModality =
  | "asserted"
  | "scheduled"
  | "forecast"
  | "conditional"
  | "opinion"
  | "alleged"
  | "estimated";

export interface CanonicalClaim {
  id: string;
  text: string;
  subject: EntityRef;
  predicate: string;
  object?: EntityRef | ScalarValue;
  claim_type: CanonicalClaimType;
  negated: boolean;
  modality: ClaimModality;
  as_of: IsoTimestamp;
  valid_time?: TemporalInterval;
  jurisdiction?: string;
  geography?: string;
  units?: string;
  denominator?: string;
  definition?: string;
  materiality: Materiality;
  dependencies: string[];
}

export interface ClaimDependency {
  claim_id: string;
  depends_on_claim_id: string;
  requirement: "required" | "supporting";
  rationale?: string;
}

export interface ClaimDag {
  schema_version: string;
  claims: CanonicalClaim[];
  roots: string[];
  dependency_edges: ClaimDependency[];
}

export type SourceClass =
  | "system_of_record"
  | "regulator"
  | "official_registry"
  | "filing"
  | "audited_report"
  | "primary_document"
  | "first_party"
  | "peer_reviewed"
  | "dataset"
  | "archive"
  | "expert_analysis"
  | "reputable_secondary"
  | "aggregator"
  | "user_supplied"
  | "web";
export type ArtifactKind =
  | "html"
  | "json"
  | "xml"
  | "pdf"
  | "text"
  | "database_row"
  | "api_response"
  | "image"
  | "audio"
  | "video"
  | "other";
export type LegacyAuthority = "primary" | "secondary" | "aggregator";
export type SourceProximity =
  | "direct_record"
  | "direct_measurement"
  | "participant"
  | "primary_analysis"
  | "secondary_analysis"
  | "hearsay";

export interface ProofAdmissibility {
  allowed_source_classes: SourceClass[];
  forbidden_source_classes: SourceClass[];
  allowed_artifact_kinds: ArtifactKind[];
  required_structured_fields: string[];
  require_raw_artifact: boolean;
  allow_user_supplied_as_decisive: boolean;
}

export interface ProofAuthorityRule {
  minimum_legacy_authority: LegacyAuthority;
  minimum_proximity: SourceProximity;
  must_include_any_source_class: SourceClass[];
  require_authenticity: boolean;
  require_claim_specific_fitness: boolean;
  claim_specific_rule: string;
}

export interface IndependenceRule {
  minimum_evidence_families: number;
  minimum_publishers: number;
  maximum_members_per_family_counted: number;
  require_lineage_resolution: boolean;
  require_source_family_removal_test: boolean;
  maximum_family_removal_delta: number;
}

export interface TemporalProofRule {
  maximum_evidence_age_s: number;
  require_valid_time_overlap: boolean;
  require_published_by_as_of: boolean;
  require_known_by_as_of: boolean;
  allow_future_effective_evidence: boolean;
  future_effective_grace_s: number;
  archive_requirement: "never" | "when_historical" | "always";
}

export type ChallengeStrategy =
  | "explicit_counter_hypothesis"
  | "negated_search"
  | "current_holder_search"
  | "primary_source_recovery"
  | "correction_retraction_search"
  | "source_family_removal"
  | "evidence_order_perturbation"
  | "adversarial_near_miss";

export interface ChallengeRule {
  required: boolean;
  strategies: ChallengeStrategy[];
  minimum_counterevidence_queries: number;
  require_strongest_opposing_interpretation: boolean;
  require_stopping_reason: boolean;
}

export type InvalidationTrigger =
  | "source_changed"
  | "source_retracted"
  | "source_unavailable"
  | "newer_authoritative_evidence"
  | "entity_resolution_changed"
  | "policy_changed"
  | "calibration_changed"
  | "valid_time_boundary"
  | "manual_correction";

export interface PolicyExpiryRule {
  ttl_s: number;
  recheck_before_expiry_s: number;
  invalidation_triggers: InvalidationTrigger[];
}

export interface ActionThreshold {
  materiality: Materiality;
  maximum_false_allow_risk: number;
  minimum_evidence_coverage: number;
  minimum_support_probability: number;
  on_uncalibrated: "BLOCK" | "REVIEW";
  on_degraded: "BLOCK" | "REVIEW";
}

export interface ProofPolicy {
  policy_id: string;
  version: string;
  effective_from: IsoTimestamp;
  superseded_at?: IsoTimestamp;
  claim_types: CanonicalClaimType[];
  semantics: "open_world" | "closed_world";
  admissibility: ProofAdmissibility;
  authority: ProofAuthorityRule;
  independence: IndependenceRule;
  temporal: TemporalProofRule;
  challenge: ChallengeRule;
  conflict_resolution: string[];
  force_review_conditions: string[];
  expiry: PolicyExpiryRule;
  action_thresholds: ActionThreshold[];
}

export interface RawArtifactMetadata {
  artifact_id: string;
  storage_ref: string;
  kind: ArtifactKind;
  media_type: string;
  byte_length: number;
  content_hash: ContentDigest;
  captured_at: IsoTimestamp;
  compression: "none" | "gzip" | "br" | "zstd" | "other";
  encryption?: { scheme: string; key_reference: string };
  redaction_state: "none" | "metadata_only" | "redacted" | "sealed";
}

export interface HttpArtifactMetadata {
  status: number;
  etag?: string;
  last_modified?: string;
  content_type?: string;
  final_url?: string;
}

export interface SourceVersion {
  source_version_id: string;
  source_id: string;
  source_signature: string;
  source_class: SourceClass;
  legacy_authority: LegacyAuthority;
  canonical_url?: string;
  raw_artifact: RawArtifactMetadata;
  http?: HttpArtifactMetadata;
  version_state:
    "active" | "superseded" | "corrected" | "retracted" | "unavailable";
  published_at?: IsoTimestamp;
  modified_at?: IsoTimestamp;
  observed_at: IsoTimestamp;
  known_at?: IsoTimestamp;
  valid_time?: TemporalInterval;
  publisher_id?: string;
  author_id?: string;
  owner_id?: string;
  discovery_providers: string[];
  acquisition_activity_id: string;
  supersedes_source_version_id?: string;
  correction_notice_source_version_id?: string;
}

export type EvidenceLocator =
  | { kind: "text_offsets"; start: number; end: number }
  | { kind: "json_pointer"; pointer: string }
  | {
      kind: "html_selector";
      selector: string;
      text_start?: number;
      text_end?: number;
    }
  | {
      kind: "pdf_region";
      page: number;
      bounding_box: [number, number, number, number];
    }
  | {
      kind: "table_cell";
      table: string;
      row: string | number;
      column: string | number;
    }
  | {
      kind: "record_field";
      system: string;
      table: string;
      record_id: string;
      field: string;
    }
  | { kind: "media_time"; start_ms: number; end_ms: number };

export interface EvidenceSpan {
  evidence_span_id: string;
  source_version_id: string;
  locator: EvidenceLocator;
  quote?: string;
  structured_value?: ScalarValue;
  span_hash: ContentDigest;
  language?: string;
  extracted_at: IsoTimestamp;
  visibility: "public" | "tenant_private" | "restricted";
  quarantined: boolean;
  injection_detected: boolean;
}

export interface LineageEdge {
  lineage_edge_id: string;
  from_source_version_id: string;
  to_source_version_id: string;
  relationship:
    | "derived_from"
    | "copied_from"
    | "syndicated_from"
    | "quotes"
    | "cites"
    | "updates"
    | "supersedes"
    | "corrects"
    | "retracts";
  confidence: number;
  explicit_attribution: boolean;
  evidence_span_ids: string[];
}

export interface EvidenceFamily {
  evidence_family_id: string;
  label: string;
  member_source_version_ids: string[];
  origin_source_version_ids: string[];
  lineage_edge_ids: string[];
  methods: Array<
    | "explicit_attribution"
    | "exact_text"
    | "near_duplicate"
    | "shared_origin"
    | "publisher_ownership"
    | "manual"
  >;
  publisher_group_id?: string;
  upstream_dataset_id?: string;
  confidence: number;
  independence_rationale: string;
}

export interface StanceProbabilities {
  support: number;
  refute: number;
  neutral: number;
}

export interface EvidenceAssessment {
  evidence_assessment_id: string;
  claim_id: string;
  evidence_span_id: string;
  evidence_family_id: string;
  stance: StanceProbabilities;
  entity_match: {
    state: "match" | "partial" | "mismatch" | "unknown";
    score: number;
    rationale: string;
  };
  scope_fit: {
    state: "exact" | "partial" | "mismatch" | "unknown";
    score: number;
    rationale: string;
  };
  temporal_fit: {
    state: "applicable" | "partial" | "inapplicable" | "unknown";
    score: number;
    rationale: string;
  };
  extraction_confidence: number;
  source_fitness: number;
  support_mode: "direct" | "inferential";
  admissible: boolean;
  exclusion_reason?: string;
}

export type AssessmentGapKind =
  | "missing_authority"
  | "missing_independence"
  | "missing_counterevidence_search"
  | "entity_ambiguity"
  | "scope_mismatch"
  | "temporal_ambiguity"
  | "source_unavailable"
  | "conflict_unresolved"
  | "calibration_unavailable"
  | "policy_incomplete"
  | "other";

export interface AssessmentGap {
  gap_id: string;
  kind: AssessmentGapKind;
  severity: "informational" | "material" | "blocking";
  description: string;
  resolvable: boolean;
  required_evidence: string[];
}

/** Exact server-derived cohort identity used to issue this claim assessment. */
export interface CalibrationSupportIdentity {
  feature_schema_version: string;
  feature_schema_hash: ContentDigest;
  support_fingerprint: ContentDigest;
  feature_vector: Record<string, unknown>;
}

export interface ClaimAssessment {
  claim_assessment_id: string;
  claim_id: string;
  claim_state:
    "supported" | "refuted" | "mixed" | "unresolved" | "unverifiable";
  temporal_state: "current" | "superseded" | "future" | "expired" | "unknown";
  system_state: SystemState;
  stance: StanceProbabilities;
  evidence_coverage: number;
  calibrated_support?: { probability: number; calibration_version: string };
  /** Always present on claim assessments inside an issued ProofPacket. */
  calibration_support: CalibrationSupportIdentity;
  risk_upper_bound?: number;
  evidence_assessments: EvidenceAssessment[];
  decisive_evidence_span_ids: string[];
  counterevidence_span_ids: string[];
  unresolved_gaps: AssessmentGap[];
  what_would_change_this: string[];
  assessed_at: IsoTimestamp;
}

export interface ProtocolManifest {
  protocol: "kaval-proof";
  protocol_version: string;
  schema_version: string;
  compiler_version: string;
  planner_version: string;
  adjudicator_version: string;
  model_versions: Record<string, string>;
  tool_versions: Record<string, string>;
  parser_versions: Record<string, string>;
}

export interface PolicyBinding {
  claim_id: string;
  policy_id: string;
  policy_version: string;
  policy_hash: ContentDigest;
}

export interface CalibrationMetrics {
  brier_score: number;
  log_loss: number;
  expected_calibration_error: number;
  sample_size: number;
}

export type CalibrationManifest =
  | {
      status: "calibrated";
      version: string;
      protocol_version: string;
      training_dataset_hash: ContentDigest;
      evaluation_dataset_hash: ContentDigest;
      feature_schema_version: string;
      feature_schema_hash: ContentDigest;
      method: string;
      trained_through: IsoTimestamp;
      applicable_claim_types: string[];
      applicable_domains: string[];
      metrics: CalibrationMetrics;
    }
  | {
      status: "withheld";
      reason: string;
      evidence_strength_scale_version: string;
    };

export type ProvenanceActivityKind =
  | "compile"
  | "plan"
  | "search"
  | "fetch"
  | "render"
  | "parse"
  | "extract"
  | "entity_resolve"
  | "lineage_cluster"
  | "adjudicate"
  | "challenge"
  | "calibrate"
  | "decide";

export interface ProvenanceActivity {
  activity_id: string;
  kind: ProvenanceActivityKind;
  parent_activity_ids: string[];
  status: "completed" | "failed" | "cancelled" | "timed_out";
  provider?: string;
  tool_version?: string;
  model_version?: string;
  parser_version?: string;
  parameters_hash: ContentDigest;
  input_hashes: ContentDigest[];
  output_hashes: ContentDigest[];
  started_at: IsoTimestamp;
  completed_at: IsoTimestamp;
  error_code?: string;
}

export interface ProofPacket {
  proof_id: string;
  created_at: IsoTimestamp;
  research_contract: {
    held_belief: string;
    as_of: IsoTimestamp;
    action: ActionContext;
    domain?: string;
    subject_hint?: string;
    jurisdiction?: string;
    geography?: string;
    units?: string;
  };
  protocol: ProtocolManifest;
  claim_dag: ClaimDag;
  policies: ProofPolicy[];
  policy_bindings: PolicyBinding[];
  source_versions: SourceVersion[];
  evidence_spans: EvidenceSpan[];
  evidence_families: EvidenceFamily[];
  lineage_edges: LineageEdge[];
  claim_assessments: ClaimAssessment[];
  action_decision: ActionDecision;
  calibration: CalibrationManifest;
  provenance: {
    activities: ProvenanceActivity[];
    root_activity_ids: string[];
    research_stopping_reason: string;
  };
  expiry: {
    issued_at: IsoTimestamp;
    expires_at: IsoTimestamp;
    recheck_at: IsoTimestamp;
    invalidation_triggers: InvalidationTrigger[];
    monitor_id?: string;
  };
  signature?: { algorithm: string; key_id: string; signature: string };
}

/** POST /v1/audit body. `domain` is descriptive metadata; it never expands calibration support. */
export interface AuditInput {
  text: string;
  as_of: IsoTimestamp;
  materiality?: Materiality;
  intended_action?: string;
  reversibility?: ActionReversibility;
  false_allow_cost_usd?: number;
  false_block_cost_usd?: number;
  wait_cost_usd?: number;
  domain?: string;
  subject_hint?: string;
  jurisdiction?: string;
  geography?: string;
  units?: string;
  context?: string;
  aliases?: string[];
  primary_domains?: string[];
  origin_urls?: string[];
  record?: RecordRef;
  record_field?: string;
}

interface ProofGateInputBase {
  expected_dependency_versions?: Record<string, string>;
  material_claim_ids: string[];
  threshold: DecisionThreshold;
  action: ActionContext;
}

/** POST /v1/gate requires exactly one durable proof locator. */
export type ProofGateInput = ProofGateInputBase &
  (
    | { proof_id: string; proof_key?: never }
    | { proof_key: string; proof_id?: never }
  );

export type ProofGateState =
  | "current"
  | "expired"
  | "not_yet_valid"
  | "invalidated"
  | "dependency_changed"
  | "integrity_failed"
  | "policy_mismatch"
  | "not_found"
  | "operational_failure";

export type ProofBillingClass =
  | "action_gate"
  | "direct_refresh"
  | "web_refresh"
  | "deep_refresh"
  | "operational_failure";

export interface ProofEnforcementResult {
  mode: "shadow" | "block_only" | "bounded";
  controlApplied: boolean;
  executionAllowed: boolean | null;
  wouldAllow: boolean;
  reason: string;
}

export interface ProofGateResult {
  proofId: string;
  state: ProofGateState;
  decision: ActionDecision;
  billingClass: ProofBillingClass;
  proofReused: boolean;
  researchPerformed: false;
  humanOverrideApplied?: true;
  latencyMs: number;
  reason?: string;
  enforcement?: ProofEnforcementResult;
}
