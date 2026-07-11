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
 * The agent-facing MCP server. Wraps the thin `kaval` HTTP client and exposes the full proof
 * audit/gate protocol, compatibility currentness tools, and outcome reporting. Tool names use
 * underscores for client portability.
 */
export function createMcpServer(client: Kaval): McpServer {
  const server = new McpServer({ name: "kaval", version: "0.3.0" });

  // THE hero tool: the pre-action gate. Registered first so agents reach for it at the act-moment.
  server.registerTool(
    "currentness_verify",
    {
      description:
        "PRE-ACTION GATE — call this before acting on ANY belief you already hold (a cached fact, a stored field, a retrieved RAG chunk, a prior answer). It independently re-derives the truth and returns `act` (boolean) + a typed verdict + the proof. If `act` is false, DO NOT proceed — the belief is stale/contradicted/unprovable; re-research first. Pass any provenance you kept (the source url, held_at, the content hash you saw at read time) so silent drift (changed-since-read) is caught.",
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
        "Build the complete action-bound Kaval ProofPacket: compile atomic claims, run support and falsification research, preserve exact evidence and lineage, adjudicate scope/time/conflicts, and return ALLOW, BLOCK, or REVIEW. Apply the result through proof_gate so the configured shadow/block-only/bounded rollout policy remains authoritative.",
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
        primary_domains: z.array(z.string().min(1).max(512)).max(20).optional(),
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
