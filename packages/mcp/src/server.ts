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
// Mirrors the server's MateyEvidenceReference: a plain http(s) URL string, or a strict
// { url, document_id } pair. A bare object WITHOUT document_id is invalid on the wire — callers
// must send the plain string form instead.
const evidenceReferenceInput = z.union([
  httpUrlInput.describe("a plain http(s) evidence URL"),
  z
    .object({
      url: httpUrlInput,
      document_id: z
        .string()
        .trim()
        .min(1)
        .max(2_000)
        .describe(
          "stable document identity, reusable for later change notifications",
        ),
    })
    .strict(),
]);
const evidenceRefsInput = z
  .array(evidenceReferenceInput)
  .min(1)
  .max(20)
  .superRefine((references, ctx) => {
    const documentIds = references.flatMap((reference) =>
      typeof reference === "string" ? [] : [reference.document_id],
    );
    if (new Set(documentIds).size !== documentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stable document_id values must be unique",
      });
    }
  })
  .describe(
    "1-20 evidence references the conclusion relies on: plain http(s) URL strings, or { url, document_id } objects with unique document_id values",
  );

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function toolError(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

interface TransportOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

function transportOptions(
  idempotencyKey: string | undefined,
  signal: AbortSignal,
): TransportOptions {
  return {
    signal,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

/** The exact wire operations this server drives on the injected `kaval` client, typed structurally
 *  against the live `/v1/*` contract. The MCP zod schemas own request validation; the client owns
 *  transport (auth headers, idempotency keys, bounded ambiguous-outcome retries). `verify` sends
 *  the primary conclusion + evidence_refs body; `verifyBelief` sends the legacy belief-freshness
 *  fallback body — the server disambiguates them on the same /v1/verify route. */
interface WireClient {
  verify(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  verifyBelief(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  check(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  extractAndCheck(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  scanStore(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  monitor(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  audit(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  gate(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  reportOutcome(input: Record<string, unknown>): Promise<unknown>;
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
 *  invalid key, 404 proof_not_found) is surfaced with its status + code/message so the agent can act
 *  on it; anything else collapses to a generic message so internal details never leak. */
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
 * The agent-facing verification server. Before an AI agent acts, Kaval verifies the facts the
 * action relies on and returns a time-bounded signed proof a policy can enforce — ALLOW, REVIEW,
 * or BLOCK. It exposes the primary `verify` conclusion surface, the full `proof_audit` /
 * `proof_gate` lifecycle, the legacy currentness compatibility tools, and outcome reporting.
 * Tool names use underscores for client portability.
 */
export function createMcpServer(client: Kaval): McpServer {
  const server = new McpServer({ name: "kaval", version: "0.5.0" });
  const api = client as unknown as WireClient;

  // The primary compatibility surface for single conclusions: one call in, a signed decision out.
  server.registerTool(
    "verify",
    {
      description:
        "Verify one load-bearing conclusion against its evidence references before an agent acts on it. Kaval independently re-derives the truth and returns status valid | invalidated | could_not_verify plus a signed, time-bounded proof receipt your policy can enforce: receipt.decision is ALLOW, REVIEW, or BLOCK, with the full signed ProofPacket attached. Expiry lives at receipt.packet.action_decision.expires_at. REVIEW is never permission to act. For production actions, build proof with proof_audit and enforce it at act time with proof_gate.",
      inputSchema: {
        conclusion: z
          .string()
          .min(1)
          .max(10_000)
          .describe(
            "the exact assertable proposition the downstream workflow intends to rely on",
          ),
        evidence_refs: evidenceRefsInput,
        as_of: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("RFC 3339 cutoff for what the conclusion may rely on"),
        materiality: materialityInput.optional(),
        intended_action: z.string().trim().min(1).max(10_000).optional(),
        reversibility: reversibilityInput.optional(),
        jurisdiction: z.string().trim().min(1).max(256).optional(),
        context: z.string().trim().min(1).max(4_000).optional(),
        idempotency_key: idempotencyKeyInput,
      },
    },
    async ({ idempotency_key, ...args }, { signal }) =>
      safe(() => api.verify(args, transportOptions(idempotency_key, signal))),
  );

  server.registerTool(
    "proof_audit",
    {
      description:
        "Build the complete action-bound Kaval ProofPacket (the expensive path): compile atomic claims, run support and falsification research, preserve exact evidence and lineage, adjudicate scope/time/conflicts, and return ALLOW, REVIEW, or BLOCK with an Ed25519-signed receipt. Apply the result at act time through proof_gate so the configured rollout policy remains authoritative.",
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
      safe(() => api.audit(args, transportOptions(idempotency_key, signal))),
  );

  server.registerTool(
    "proof_gate",
    {
      description:
        "Apply an existing durable proof to the exact action at act time — no search, parsing, or model call is repeated. Supply exactly one of proof_id or proof_key. Returns the proof state plus the full ActionDecision (ALLOW, REVIEW, or BLOCK). Only when enforcement.controlApplied is true may Kaval control execution; then honor executionAllowed exactly. controlApplied false is shadow telemetry and must not control the customer's action. If enforcement is absent, fail closed unless state is current and decision.decision is ALLOW. A missing proof surfaces as a typed proof_not_found error.",
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
        api.gate(args, transportOptions(idempotency_key, signal)),
      );
    },
  );

  // Legacy compatibility for the original held-belief API. These POST the legacy belief body to the
  // same live routes; the server accepts it as a fallback alongside the primary conclusion shape.
  server.registerTool(
    "currentness_verify",
    {
      description:
        "LEGACY HELD-BELIEF COMPATIBILITY — call this before acting on a cached fact, stored field, retrieved RAG chunk, or prior answer. It independently re-derives the truth and returns `act` (boolean) + a typed verdict + the proof. If `act` is false, DO NOT proceed; re-research first. Pass any provenance you kept (source URL, held_at, content hash) so silent drift is caught. Prefer the `verify` tool for the primary conclusion + evidence_refs surface.",
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
        api.verifyBelief(args, transportOptions(idempotency_key, signal)),
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
      safe(() => api.check(args, transportOptions(idempotency_key, signal))),
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
        api.extractAndCheck(args, transportOptions(idempotency_key, signal)),
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
        api.scanStore(args, transportOptions(idempotency_key, signal)),
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
      safe(() => api.monitor(args, transportOptions(idempotency_key, signal))),
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
    async (args) => safe(() => api.reportOutcome(args)),
  );

  return server;
}
