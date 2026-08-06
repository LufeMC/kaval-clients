/** Types for contracts, fact imports, bulletins, training status, feedback, and consent. */

import type { Materiality } from "./proof.js";

/** Frozen portfolio limits from the public API contract. */
export const MAX_CONTRACT_PDF_BYTES = 26_214_400;
export const MAX_INLINE_CONTRACT_BYTES = 750_000;
export const MAX_FACT_IMPORT_ITEMS = 400;
export const MAX_FACT_IMPORT_SOURCE_REFERENCES = 20;
export const MAX_PORTFOLIO_PAGE_SIZE = 100;

/** The closed API-key capability vocabulary. Training review requires an explicit grant. */
export const API_KEY_SCOPES = [
  "verification:execute",
  "proof:invalidate",
  "outcome:submit",
  "training:manage",
  "belief:read",
  "belief:write",
  "evidence:event",
  "evidence:backfill",
  "belief:gate",
  "revalidation:submit",
  "webhook:manage",
  "source:manage",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface PortfolioEntityRef {
  id?: string;
  name: string;
  type?: string;
}

export interface PortfolioClaim {
  subject: string | PortfolioEntityRef;
  predicate: string;
  object?: string | number | boolean | null | PortfolioEntityRef;
  scope?: Record<string, string | number | boolean | null>;
  materiality?: Materiality;
  text?: string;
}

export interface ContractUploadInput {
  filename: string;
  content_type: "application/pdf";
  size_bytes: number;
  sha256: string;
}

export interface ContractUploadResource extends ContractUploadInput {
  schema_version: "contract-upload/1.0.0";
  id: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  state: "pending_upload" | "uploaded" | "consumed" | "expired" | "failed";
  upload_url: string | null;
  expires_at: string;
  failure_code: ContractErrorCode | null;
}

export type ContractErrorCode =
  | "contract_owner_required"
  | "contract_not_found"
  | "contract_upload_not_found"
  | "contract_upload_expired"
  | "contract_upload_incomplete"
  | "contract_digest_mismatch"
  | "unsupported_document"
  | "content_fetch_failed"
  | "content_too_large"
  | "reducto_document_too_large"
  | "reducto_parse_failed"
  | "reducto_submission_ambiguous"
  | "reducto_empty_result"
  | "contract_extraction_failed"
  | "candidate_not_found"
  | "candidate_version_conflict"
  | "candidate_already_reviewed"
  | "amendment_conflict"
  | "contract_ingest_unavailable";

export const CONTRACT_EXTRACTION_REVIEW_STATES = [
  "clear",
  "issues_present",
] as const;
export type ContractExtractionReviewState =
  (typeof CONTRACT_EXTRACTION_REVIEW_STATES)[number];

export const CONTRACT_EXTRACTION_ISSUE_CODES = [
  "invalid_evidence_line_range",
  "evidence_quote_absent",
  "evidence_quote_ambiguous",
  "evidence_quote_not_exact",
  "evidence_outside_ledger",
  "prohibited_signature_evidence",
  "prohibited_watermark_evidence",
  "prohibited_hostile_instruction_evidence",
  "invalid_claim",
  "numeric_evidence_mismatch",
  "duplicate_claim_fingerprint",
  "candidate_limit_exceeded",
] as const;
export type ContractExtractionIssueCode =
  (typeof CONTRACT_EXTRACTION_ISSUE_CODES)[number];

export type ContractSource =
  | { kind: "upload"; upload_id: string }
  | { kind: "content_url"; content_url: string }
  | { kind: "canonical_text"; content: string };

export interface ContractCreateInput {
  external_id: string;
  title: string;
  document_type:
    "base_agreement" | "amendment" | "attachment" | "fee_schedule" | "other";
  authority_status: "signed" | "unsigned" | "unknown";
  contract_family_key: string;
  effective_from: string | null;
  effective_to: string | null;
  supersedes_contract_id: string | null;
  source: ContractSource;
}

export interface ContractResource {
  schema_version: "contract/1.0.0";
  id: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  external_id: string;
  title: string;
  document_type: ContractCreateInput["document_type"];
  authority_status: ContractCreateInput["authority_status"];
  contract_family_key: string;
  effective_from: string | null;
  effective_to: string | null;
  supersedes_contract_id: string | null;
  source:
    | { kind: "upload"; upload_id: string }
    | { kind: "content_url" }
    | { kind: "canonical_text" };
  state:
    | "queued"
    | "processing"
    | "ready_for_review"
    | "active"
    | "failed"
    | "cancelled";
  processing_stage:
    "acquire" | "parse" | "segment" | "extract" | "activate" | null;
  claim_candidate_count: number;
  extraction_issue_count: number;
  extraction_review_state: ContractExtractionReviewState;
  failure_code: ContractErrorCode | null;
  completed_at: string | null;
}

export interface ContractExtractionIssueResource {
  schema_version: "contract-extraction-issue/1.0.0";
  id: string;
  workspace_id: string;
  contract_id: string;
  issue_code: ContractExtractionIssueCode;
  parser_version: string;
  extractor_version: string;
  batch_index: number;
  candidate_index: number;
  start_line_id: string | null;
  end_line_id: string | null;
  start_line: number | null;
  end_line: number | null;
  created_at: string;
}

export interface ContractExtractionIssueListOptions {
  issueCode?: ContractExtractionIssueCode;
  cursor?: string;
  limit?: number;
}

export interface ContractExtractionIssuePage {
  schema_version: "contract-extraction-issue/1.0.0";
  data: ContractExtractionIssueResource[];
  next_cursor: string | null;
}

export interface ContractClaimReviewInput {
  review_id: string;
  decision: "approve" | "correct" | "reject";
  expected_candidate_version: number;
  reason?: string;
  corrected_claim?: PortfolioClaim;
}

export interface ContractClaimReviewResource {
  schema_version: "contract-claim-review/1.0.0";
  id: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  review_id: string;
  contract_id: string;
  candidate_id: string;
  candidate_version: number;
  decision: ContractClaimReviewInput["decision"];
  reason: string | null;
  corrected_candidate_id: string | null;
}

export interface ContractClaimResource {
  schema_version: "contract-claim/1.0.0";
  id: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  contract_id: string;
  candidate_version: number;
  review_state: "proposed" | "approved" | "corrected" | "rejected";
  activation_state: "inactive" | "active" | "conflict" | "superseded";
  claim: PortfolioClaim;
  evidence: {
    quote: string;
    start_offset: number;
    end_offset: number;
    start_line: number;
    end_line: number;
    raw_sha256: string;
    canonical_sha256: string;
  };
  parser_version: string;
  extractor_version: string;
  review: ContractClaimReviewResource | null;
}

export interface ContractClaimPage {
  schema_version: "contract-claim/1.0.0";
  data: ContractClaimResource[];
  next_cursor: string | null;
}

export interface FactImportItemInput {
  item_id: string;
  claim: PortfolioClaim;
  contract_claim_id?: string;
  source_ids: string[];
}

export interface FactImportInput {
  external_batch_id: string;
  items: FactImportItemInput[];
}

export interface FactImportResource {
  schema_version: "fact-import/1.0.0";
  id: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  external_batch_id: string;
  state:
    | "queued"
    | "processing"
    | "completed"
    | "completed_with_errors"
    | "failed"
    | "cancelled";
  items: Array<{
    item_id: string;
    state:
      | "pending"
      | "processing"
      | "seeded"
      | "duplicate"
      | "review"
      | "blocked"
      | "failed";
    fingerprint: string | null;
    receipt_id: string | null;
    error_code: FactImportErrorCode | null;
  }>;
  summary: Record<
    | "total"
    | "pending"
    | "processing"
    | "seeded"
    | "duplicate"
    | "review"
    | "blocked"
    | "failed",
    number
  >;
  failure_code: FactImportErrorCode | null;
  completed_at: string | null;
}

export type FactImportErrorCode =
  | "fact_import_owner_required"
  | "fact_import_not_found"
  | "fact_import_limit_exceeded"
  | "duplicate_item_id"
  | "watched_source_cap_reached"
  | "source_not_found"
  | "contract_claim_not_approved"
  | "fact_import_unavailable";

export interface BulletinListOptions {
  sourceId?: string;
  payerId?: string;
  policyNumber?: string;
  code?: string;
  recordStatus?: "candidate" | "review" | "confirmed";
  publishedFrom?: string;
  publishedTo?: string;
  cursor?: string;
  limit?: number;
}

export type BulletinFieldStatus = "candidate" | "confirmed" | "review" | "none";

export interface BulletinEvidence {
  quote: string;
  start_offset: number;
  end_offset: number;
  start_line: number;
  end_line: number;
}

export interface BulletinField<T> {
  value: T | null;
  status: BulletinFieldStatus;
  review_reason: string | null;
  evidence: BulletinEvidence[];
  source_version_id: string;
  parser_version: string;
  extractor_version: string;
}

export interface BulletinPayerIdentity {
  payer_id: string;
  display_name: string;
}

export interface BulletinCode {
  system: "cpt" | "hcpcs" | "icd_10";
  code: string;
  description: string | null;
}

export interface BulletinCodeOperation {
  operation: "added" | "removed" | "modified" | "unchanged";
  system: BulletinCode["system"];
  code: string;
  replacement_code: string | null;
}

export interface BulletinCoverageStatement {
  classification:
    "covered" | "not_covered" | "conditional" | "limited" | "unknown";
  statement: string;
}

export interface BulletinPriorAuthorizationStatement {
  requirement: "required" | "not_required" | "conditional" | "unknown";
  statement: string;
}

export interface BulletinChangedSection {
  heading: string;
  change_type: "added" | "removed" | "modified";
  summary: string;
}

export interface BulletinDocumentRef {
  source_id: string | null;
  source_version_id: string | null;
  policy_number: string | null;
  title: string | null;
  url: string | null;
}

/** The complete `BulletinRecordV1` read model, including field-level evidence. */
export interface BulletinRecord {
  schema_version: "bulletin-record/1.0.0";
  id: string;
  workspace_id: string;
  source_id: string;
  source_version_id: string;
  created_at: string;
  updated_at: string;
  record_status: "candidate" | "review" | "confirmed";
  payer: BulletinField<BulletinPayerIdentity>;
  policy_number: BulletinField<string>;
  title: BulletinField<string>;
  publisher_status_label: BulletinField<string>;
  publication_date: BulletinField<string>;
  stated_effective_date: BulletinField<string>;
  products: BulletinField<string[]>;
  plans: BulletinField<string[]>;
  states: BulletinField<string[]>;
  funding_types: BulletinField<string[]>;
  codes: BulletinField<BulletinCode[]>;
  code_operations: BulletinField<BulletinCodeOperation[]>;
  coverage_statements: BulletinField<BulletinCoverageStatement[]>;
  prior_authorization_statements: BulletinField<
    BulletinPriorAuthorizationStatement[]
  >;
  changed_sections: BulletinField<BulletinChangedSection[]>;
  related_documents: BulletinField<BulletinDocumentRef[]>;
  replaced_documents: BulletinField<BulletinDocumentRef[]>;
}

export interface BulletinPage {
  bulletins: BulletinRecord[];
  next_cursor: string | null;
}

export const BULLETIN_EXTRACTION_ATTEMPT_STATUSES = [
  "processing",
  "retry",
  "succeeded",
  "failed",
] as const;
export type BulletinExtractionAttemptStatus =
  (typeof BULLETIN_EXTRACTION_ATTEMPT_STATUSES)[number];

export interface BulletinExtractionAttemptResource {
  schema_version: "bulletin-extraction-attempt/1.0.0";
  id: string;
  workspace_id: string;
  source_version_id: string;
  source_id: string;
  status: BulletinExtractionAttemptStatus;
  attempt_count: number;
  manual_requeue_count: number;
  requeue_available: boolean;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  last_error_code: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BulletinExtractionAttemptListOptions {
  sourceId?: string;
  status?: BulletinExtractionAttemptStatus;
  cursor?: string;
  limit?: number;
}

export interface BulletinExtractionAttemptPage {
  schema_version: "bulletin-extraction-attempt/1.0.0";
  data: BulletinExtractionAttemptResource[];
  next_cursor: string | null;
}

export interface BulletinExtractionAttemptDetailResponse {
  schema_version: "bulletin-extraction-attempt/1.0.0";
  data: BulletinExtractionAttemptResource;
}

export type TrainingJobStatus =
  | "queued"
  | "running"
  | "awaiting_promotion"
  | "promoted"
  | "rejected"
  | "failed"
  | "cancelled"
  | "insufficient_data";

export interface TrainingDatasetVersion {
  schema_version: "training-dataset/1.0.0";
  id: string;
  workspace_id: string;
  version: number;
  training_examples: number;
  evaluation_examples: number;
  training_hash: string;
  evaluation_hash: string;
  manifest_hash: string;
  demo_only: boolean;
  created_at: string;
}

export interface TrainingEvaluationMetrics {
  evaluated_examples: number;
  accuracy: number;
  precision: number;
  recall: number;
  false_allow_rate: number;
}

export type TrainingFailureCode =
  | "insufficient_reviewed_labels"
  | "dataset_export_failed"
  | "provider_training_failed"
  | "evaluation_failed"
  | "evaluation_gate_failed"
  | "promotion_failed";

export interface TrainingJob {
  schema_version: "training-job/1.0.0";
  id: string;
  workspace_id: string;
  status: TrainingJobStatus;
  stage: "collecting" | "exporting" | "training" | "evaluating" | null;
  dataset: TrainingDatasetVersion | null;
  training_examples: number;
  evaluation_examples: number;
  provider: string | null;
  provider_job_id: string | null;
  model_id: string | null;
  evaluation_metrics: TrainingEvaluationMetrics | null;
  promotion_decision: "pending" | "approved" | "rejected" | "not_eligible";
  failure_code: TrainingFailureCode | null;
  demo_only: boolean;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export interface TrainingJobPage {
  jobs: TrainingJob[];
  next_cursor: string | null;
}

export type TrainingFeedbackSourceType =
  "contract_claim_review" | "proof_outcome" | "manual_correction";
export type TrainingFeedbackTask =
  | "contract_claim_extraction"
  | "bulletin_extraction"
  | "decision_classification";
export type TrainingFeedbackReviewStatus =
  "accepted" | "corrected" | "rejected";
export type TrainingUse = "approved" | "withheld";

export interface TrainingFeedback {
  schema_version: "training-feedback/1.0.0";
  id: string;
  workspace_id: string;
  source_type: TrainingFeedbackSourceType;
  source_id: string;
  split_group_id: string;
  task: TrainingFeedbackTask;
  review_status: TrainingFeedbackReviewStatus;
  training_use: TrainingUse;
  split: "training" | "evaluation";
  input: Record<string, unknown>;
  expected_output: Record<string, unknown>;
  reviewed_by: string;
  reviewed_at: string;
  demo_only: boolean;
  content_hash: string;
}

export interface TrainingFeedbackConsentInput {
  schema_version: "training-feedback-consent-request/1.0.0";
  training_use: TrainingUse;
  consent_to_training: boolean;
  reason?: string | null;
}

export interface TrainingFeedbackConsent {
  schema_version: "training-feedback-consent/1.0.0";
  id: string;
  workspace_id: string;
  feedback_id: string;
  training_use: TrainingUse;
  consent_to_training: boolean;
  reason: string | null;
  reviewed_by_api_key_id: string;
  created_at: string;
}

export interface TrainingFeedbackReviewItem {
  feedback: TrainingFeedback;
  effective_training_use: TrainingUse;
  latest_consent: TrainingFeedbackConsent | null;
}

export interface TrainingFeedbackListOptions {
  effectiveTrainingUse?: TrainingUse;
  cursor?: string;
  limit?: number;
}

export interface TrainingFeedbackReviewList {
  schema_version: "training-feedback-review-list/1.0.0";
  feedback: TrainingFeedbackReviewItem[];
  next_cursor: string | null;
}
