import { describe, expect, it } from "vitest";
import {
  API_KEY_SCOPES,
  BULLETIN_EXTRACTION_ATTEMPT_STATUSES,
  CONTRACT_EXTRACTION_ISSUE_CODES,
  Kaval,
  KavalError,
  MAX_CONTRACT_PDF_BYTES,
  MAX_FACT_IMPORT_ITEMS,
  MAX_FACT_IMPORT_SOURCE_REFERENCES,
  MAX_INLINE_CONTRACT_BYTES,
  MAX_PORTFOLIO_PAGE_SIZE,
} from "../src/index.js";

interface RequestRecord {
  method: string;
  path: string;
  key: string | null;
  body: unknown;
}

function portfolioApi(): { fetch: typeof fetch; requests: RequestRecord[] } {
  const requests: RequestRecord[] = [];
  const fetch = (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      key: new Headers(init?.headers).get("idempotency-key"),
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    const contractId = "10000000-0000-4000-8000-000000000001";
    const importId = "20000000-0000-4000-8000-000000000001";
    const bulletinId = "30000000-0000-4000-8000-000000000001";
    const bulletinAttemptId = "31000000-0000-4000-8000-000000000001";
    const trainingId = "40000000-0000-4000-8000-000000000001";
    const feedbackId = "90000000-0000-4000-8000-000000000001";
    const workspaceId = "a0000000-0000-4000-8000-000000000001";
    const keyId = "b0000000-0000-4000-8000-000000000001";
    let payload: unknown;
    if (url.pathname === "/v1/contract-uploads") {
      payload = { id: "50000000-0000-4000-8000-000000000001" };
    } else if (url.pathname === "/v1/contracts" && method === "POST") {
      payload = { id: contractId, state: "queued" };
    } else if (url.pathname === `/v1/contracts/${contractId}`) {
      payload = { id: contractId, state: "ready_for_review" };
    } else if (url.pathname === `/v1/contracts/${contractId}/claims`) {
      payload = {
        schema_version: "contract-claim/1.0.0",
        data: [],
        next_cursor: null,
      };
    } else if (
      url.pathname === `/v1/contracts/${contractId}/extraction-issues`
    ) {
      payload = {
        schema_version: "contract-extraction-issue/1.0.0",
        data: [
          {
            schema_version: "contract-extraction-issue/1.0.0",
            id: "71000000-0000-4000-8000-000000000001",
            workspace_id: workspaceId,
            contract_id: contractId,
            issue_code: "prohibited_hostile_instruction_evidence",
            parser_version: "reducto/1.0.0",
            extractor_version: "contract-extractor/1.0.0",
            batch_index: 2,
            candidate_index: 4,
            start_line_id: "line-99",
            end_line_id: "line-99",
            start_line: 99,
            end_line: 99,
            created_at: "2026-08-05T19:59:00.000Z",
          },
        ],
        next_cursor: "next-extraction-issue-page",
      };
    } else if (url.pathname.endsWith("/reviews")) {
      payload = { id: "60000000-0000-4000-8000-000000000001" };
    } else if (url.pathname === "/v1/fact-imports") {
      payload = { id: importId, state: "queued" };
    } else if (url.pathname === `/v1/fact-imports/${importId}`) {
      payload = { id: importId, state: "completed" };
    } else if (url.pathname === "/v1/bulletins") {
      payload = { bulletins: [], next_cursor: null };
    } else if (url.pathname === `/v1/bulletins/${bulletinId}`) {
      payload = { bulletin: { source_version_id: bulletinId } };
    } else if (url.pathname === "/v1/bulletins/extraction-attempts") {
      payload = {
        schema_version: "bulletin-extraction-attempt/1.0.0",
        data: [
          {
            schema_version: "bulletin-extraction-attempt/1.0.0",
            id: bulletinAttemptId,
            workspace_id: workspaceId,
            source_version_id: bulletinAttemptId,
            source_id: "32000000-0000-4000-8000-000000000001",
            status: "failed",
            attempt_count: 4,
            manual_requeue_count: 1,
            requeue_available: true,
            lease_expires_at: null,
            next_attempt_at: null,
            last_error_code: "invalid_bulletin_output",
            started_at: "2026-08-05T19:58:00.000Z",
            finished_at: "2026-08-05T19:59:00.000Z",
            created_at: "2026-08-05T19:58:00.000Z",
            updated_at: "2026-08-05T19:59:00.000Z",
          },
        ],
        next_cursor: "next-bulletin-attempt-page",
      };
    } else if (
      url.pathname === `/v1/bulletins/extraction-attempts/${bulletinAttemptId}`
    ) {
      payload = {
        schema_version: "bulletin-extraction-attempt/1.0.0",
        data: {
          schema_version: "bulletin-extraction-attempt/1.0.0",
          id: bulletinAttemptId,
          workspace_id: workspaceId,
          source_version_id: bulletinAttemptId,
          source_id: "32000000-0000-4000-8000-000000000001",
          status: "succeeded",
          attempt_count: 2,
          manual_requeue_count: 0,
          requeue_available: false,
          lease_expires_at: null,
          next_attempt_at: null,
          last_error_code: null,
          started_at: "2026-08-05T19:58:00.000Z",
          finished_at: "2026-08-05T19:59:00.000Z",
          created_at: "2026-08-05T19:58:00.000Z",
          updated_at: "2026-08-05T19:59:00.000Z",
        },
      };
    } else if (url.pathname === "/v1/training-jobs") {
      payload = { jobs: [], next_cursor: null };
    } else if (url.pathname === `/v1/training-jobs/${trainingId}`) {
      payload = { id: trainingId, status: "insufficient_data" };
    } else if (url.pathname === "/v1/training-feedback") {
      payload = {
        schema_version: "training-feedback-review-list/1.0.0",
        feedback: [
          {
            feedback: {
              schema_version: "training-feedback/1.0.0",
              id: feedbackId,
              workspace_id: workspaceId,
              source_type: "contract_claim_review",
              source_id: "claim-review-001",
              split_group_id: "contract-family-001",
              task: "contract_claim_extraction",
              review_status: "accepted",
              training_use: "withheld",
              split: "training",
              input: { claim_text: "Claims must be filed within 120 days." },
              expected_output: { filing_limit_days: 120 },
              reviewed_by: "reviewer-001",
              reviewed_at: "2026-08-05T20:00:00.000Z",
              demo_only: false,
              content_hash: `sha256:${"a".repeat(64)}`,
            },
            effective_training_use: "withheld",
            latest_consent: null,
          },
        ],
        next_cursor: "next-feedback-page",
      };
    } else if (url.pathname === `/v1/training-feedback/${feedbackId}/consent`) {
      payload = {
        schema_version: "training-feedback-consent/1.0.0",
        id: "c0000000-0000-4000-8000-000000000001",
        workspace_id: workspaceId,
        feedback_id: feedbackId,
        training_use: "approved",
        consent_to_training: true,
        reason: "The operator approved this reviewed example.",
        reviewed_by_api_key_id: keyId,
        created_at: "2026-08-05T20:01:00.000Z",
      };
    } else {
      return new Response(JSON.stringify({ error: { code: "not_found" } }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(payload), {
      status: method === "POST" ? 202 : 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("portfolio client", () => {
  it("pins every public portfolio limit", () => {
    expect(MAX_CONTRACT_PDF_BYTES).toBe(26_214_400);
    expect(MAX_INLINE_CONTRACT_BYTES).toBe(750_000);
    expect(MAX_FACT_IMPORT_ITEMS).toBe(400);
    expect(MAX_FACT_IMPORT_SOURCE_REFERENCES).toBe(20);
    expect(MAX_PORTFOLIO_PAGE_SIZE).toBe(100);
    expect(API_KEY_SCOPES).toEqual([
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
      "policy-update:read",
      "policy-update:manage",
    ]);
    expect(new Set(API_KEY_SCOPES).size).toBe(API_KEY_SCOPES.length);
    expect(CONTRACT_EXTRACTION_ISSUE_CODES).toContain(
      "prohibited_hostile_instruction_evidence",
    );
    expect(BULLETIN_EXTRACTION_ATTEMPT_STATUSES).toEqual([
      "processing",
      "retry",
      "succeeded",
      "failed",
    ]);
  });

  it("forwards the complete contract, import, bulletin, and training workflow", async () => {
    const api = portfolioApi();
    const client = new Kaval({ apiKey: "kv_live_test", fetch: api.fetch });
    const contractId = "10000000-0000-4000-8000-000000000001";
    const claimId = "70000000-0000-4000-8000-000000000001";
    const importId = "20000000-0000-4000-8000-000000000001";
    const bulletinId = "30000000-0000-4000-8000-000000000001";
    const bulletinAttemptId = "31000000-0000-4000-8000-000000000001";
    const trainingId = "40000000-0000-4000-8000-000000000001";
    const feedbackId = "90000000-0000-4000-8000-000000000001";

    await client.createContractUpload(
      {
        filename: "agreement.pdf",
        content_type: "application/pdf",
        size_bytes: 128,
        sha256: "a".repeat(64),
      },
      { idempotencyKey: "upload-operation-001" },
    );
    await client.createContract(
      {
        external_id: "agreement-001",
        title: "Signed agreement",
        document_type: "base_agreement",
        authority_status: "signed",
        contract_family_key: "payer-hospital-001",
        effective_from: "2026-01-01",
        effective_to: null,
        supersedes_contract_id: null,
        source: {
          kind: "canonical_text",
          content: "The filing limit is 120 days.",
        },
      },
      { idempotencyKey: "contract-operation-001" },
    );
    await client.getContract(contractId);
    await client.listContractClaims(contractId, {
      status: "proposed",
      activationState: "inactive",
      cursor: "next-contract-page",
      limit: 100,
    });
    await expect(
      client.listContractExtractionIssues(contractId, {
        issueCode: "prohibited_hostile_instruction_evidence",
        cursor: "next-extraction-issue-page",
        limit: 25,
      }),
    ).resolves.toMatchObject({
      data: [
        {
          contract_id: contractId,
          issue_code: "prohibited_hostile_instruction_evidence",
        },
      ],
      next_cursor: "next-extraction-issue-page",
    });
    await client.reviewContractClaim(
      contractId,
      claimId,
      {
        review_id: "review-001",
        decision: "approve",
        expected_candidate_version: 1,
      },
      { idempotencyKey: "review-operation-001" },
    );
    await client.createFactImport(
      {
        external_batch_id: "batch-001",
        items: [
          {
            item_id: "fact-001",
            claim: {
              subject: "Plan",
              predicate: "filing_limit_days",
              object: 120,
            },
            source_ids: [],
          },
        ],
      },
      { idempotencyKey: "import-operation-001" },
    );
    await client.getFactImport(importId);
    await client.listBulletins({
      payerId: "payer-001",
      publishedFrom: "2026-01-01",
      publishedTo: "2026-08-05",
      limit: 100,
    });
    await client.getBulletin(bulletinId);
    await expect(
      client.listBulletinExtractionAttempts({
        sourceId: "32000000-0000-4000-8000-000000000001",
        status: "failed",
        cursor: "next-bulletin-attempt-page",
        limit: 25,
      }),
    ).resolves.toMatchObject({
      data: [{ source_version_id: bulletinAttemptId, status: "failed" }],
      next_cursor: "next-bulletin-attempt-page",
    });
    await expect(
      client.getBulletinExtractionAttempt(bulletinAttemptId),
    ).resolves.toMatchObject({
      source_version_id: bulletinAttemptId,
      status: "succeeded",
    });
    await client.listTrainingJobs({ demoOnly: false, limit: 100 });
    await client.getTrainingJob(trainingId);
    await expect(
      client.listTrainingFeedback({
        effectiveTrainingUse: "withheld",
        cursor: "next-feedback-page",
        limit: 50,
      }),
    ).resolves.toMatchObject({
      feedback: [
        {
          feedback: { id: feedbackId },
          effective_training_use: "withheld",
          latest_consent: null,
        },
      ],
      next_cursor: "next-feedback-page",
    });
    await expect(
      client.recordTrainingFeedbackConsent(
        feedbackId,
        {
          schema_version: "training-feedback-consent-request/1.0.0",
          training_use: "approved",
          consent_to_training: true,
          reason: "The operator approved this reviewed example.",
        },
        { idempotencyKey: "feedback-consent-operation-001" },
      ),
    ).resolves.toMatchObject({
      feedback_id: feedbackId,
      training_use: "approved",
      consent_to_training: true,
    });

    expect(
      api.requests.map(({ method, path, key }) => ({ method, path, key })),
    ).toEqual([
      {
        method: "POST",
        path: "/v1/contract-uploads",
        key: "upload-operation-001",
      },
      { method: "POST", path: "/v1/contracts", key: "contract-operation-001" },
      { method: "GET", path: `/v1/contracts/${contractId}`, key: null },
      {
        method: "GET",
        path: `/v1/contracts/${contractId}/claims?status=proposed&activation_state=inactive&cursor=next-contract-page&limit=100`,
        key: null,
      },
      {
        method: "GET",
        path: `/v1/contracts/${contractId}/extraction-issues?issue_code=prohibited_hostile_instruction_evidence&cursor=next-extraction-issue-page&limit=25`,
        key: null,
      },
      {
        method: "POST",
        path: `/v1/contracts/${contractId}/claims/${claimId}/reviews`,
        key: "review-operation-001",
      },
      { method: "POST", path: "/v1/fact-imports", key: "import-operation-001" },
      { method: "GET", path: `/v1/fact-imports/${importId}`, key: null },
      {
        method: "GET",
        path: "/v1/bulletins?payer_id=payer-001&published_from=2026-01-01&published_to=2026-08-05&limit=100",
        key: null,
      },
      { method: "GET", path: `/v1/bulletins/${bulletinId}`, key: null },
      {
        method: "GET",
        path: "/v1/bulletins/extraction-attempts?source_id=32000000-0000-4000-8000-000000000001&status=failed&cursor=next-bulletin-attempt-page&limit=25",
        key: null,
      },
      {
        method: "GET",
        path: `/v1/bulletins/extraction-attempts/${bulletinAttemptId}`,
        key: null,
      },
      {
        method: "GET",
        path: "/v1/training-jobs?demo_only=false&limit=100",
        key: null,
      },
      { method: "GET", path: `/v1/training-jobs/${trainingId}`, key: null },
      {
        method: "GET",
        path: "/v1/training-feedback?effective_training_use=withheld&cursor=next-feedback-page&limit=50",
        key: null,
      },
      {
        method: "POST",
        path: `/v1/training-feedback/${feedbackId}/consent`,
        key: "feedback-consent-operation-001",
      },
    ]);
  });

  it("rejects frozen-limit and cross-field violations before network access", async () => {
    const api = portfolioApi();
    const client = new Kaval({ apiKey: "kv_live_test", fetch: api.fetch });
    const contractId = "10000000-0000-4000-8000-000000000001";
    const claimId = "70000000-0000-4000-8000-000000000001";

    expect(() => client.listBulletins({ limit: 101 })).toThrow(
      /1 through 100/u,
    );
    expect(() => client.listTrainingJobs({ limit: 0 })).toThrow(
      /1 through 100/u,
    );
    expect(() => client.listTrainingFeedback({ limit: 101 })).toThrow(
      /1 through 100/u,
    );
    expect(() =>
      client.listContractExtractionIssues(contractId, { limit: 0 }),
    ).toThrow(/1 through 100/u);
    expect(() => client.listBulletinExtractionAttempts({ limit: 101 })).toThrow(
      /1 through 100/u,
    );
    expect(() => client.listContractClaims(contractId, { limit: 1.5 })).toThrow(
      /1 through 100/u,
    );
    expect(() =>
      client.createContractUpload({
        filename: "bad.pdf",
        content_type: "application/pdf",
        size_bytes: MAX_CONTRACT_PDF_BYTES + 1,
        sha256: "a".repeat(64),
      }),
    ).toThrow(/upload metadata/u);
    expect(() =>
      client.createContract({
        external_id: "agreement-002",
        title: "Bad date range",
        document_type: "base_agreement",
        authority_status: "signed",
        contract_family_key: "payer-hospital-001",
        effective_from: "2026-12-31",
        effective_to: "2026-01-01",
        supersedes_contract_id: null,
        source: { kind: "canonical_text", content: "Text" },
      }),
    ).toThrow(/effective_to/u);
    expect(() =>
      client.reviewContractClaim(contractId, claimId, {
        review_id: "review-002",
        decision: "correct",
        expected_candidate_version: 1,
      }),
    ).toThrow(/corrected_claim/u);
    expect(() =>
      client.createFactImport({
        external_batch_id: "batch-002",
        items: [
          {
            item_id: "duplicate",
            claim: { subject: "Plan", predicate: "covers", object: true },
            source_ids: [],
          },
          {
            item_id: "duplicate",
            claim: { subject: "Plan", predicate: "covers", object: false },
            source_ids: [],
          },
        ],
      }),
    ).toThrow(/item_id values must be unique/u);
    expect(() =>
      client.recordTrainingFeedbackConsent(
        "90000000-0000-4000-8000-000000000001",
        {
          schema_version: "training-feedback-consent-request/1.0.0",
          training_use: "approved",
          consent_to_training: false,
        },
      ),
    ).toThrow(/explicit consent/u);
    expect(api.requests).toHaveLength(0);
  });

  it("preserves customer-safe bulletin attempt errors", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "bulletin_attempt_not_found",
            message: "no matching bulletin extraction attempt exists",
          },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;
    const client = new Kaval({ apiKey: "kv_live_test", fetch });

    let failure: unknown;
    try {
      await client.getBulletinExtractionAttempt(
        "31000000-0000-4000-8000-000000000001",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(KavalError);
    expect(failure).toMatchObject({
      status: 404,
      payload: {
        error: {
          code: "bulletin_attempt_not_found",
          message: "no matching bulletin extraction attempt exists",
        },
      },
    });
    expect(JSON.stringify(failure)).not.toMatch(
      /workspace_id|tenant_id|sql|postgres/iu,
    );
  });
});
