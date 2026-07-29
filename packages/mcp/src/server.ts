import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEFAULT_CHECK_MAX_WAIT_MS,
  KavalError,
  KavalRetiredError,
  MIN_CHECK_MAX_WAIT_MS,
  type Kaval,
} from "@usekaval/kaval";
import { z } from "zod";

/**
 * The live-research budget MCP asks for. Its floor and the API's own default come from the client,
 * which is where the published contract lives — quoting either by hand is how the "defaults to
 * 3000" this tool text used to carry outlived the engine that abandoned it.
 *
 * A cold action check genuinely uses DEFAULT_CHECK_MAX_WAIT_MS, but MCP cannot spend it:
 * `@modelcontextprotocol/sdk` cancels a tool call after DEFAULT_REQUEST_TIMEOUT_MSEC (60s), so a
 * check that silently inherited the server default would be killed by the caller mid-research and
 * the agent would see a cancelled request instead of a verdict. So this server sends a budget
 * explicitly, sized to fit inside the transport deadline in `env.ts` (55s) with room for the
 * round-trip: the timeout, when it comes, fires on our side with a recovery move attached.
 *
 * A caller can still ask for LESS — that is what the bound is for — down to MIN_CHECK_MAX_WAIT_MS,
 * which disables research entirely and is exactly what `mode: "fast"` sets.
 */
const MCP_CHECK_MAX_WAIT_MS = 45_000;

const RECOVERABLE_API_CODES = new Set([
  "idempotency_in_progress",
  "idempotency_resolution_pending",
  "event_persistence_pending",
]);
const idempotencyKeyInput = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7e]+$/)
  .optional()
  .describe(
    "reuse the operation key returned by an ambiguous prior attempt; omit for a new operation",
  );
const materialityInput = z.enum(["low", "medium", "high", "critical"]);
const reversibilityInput = z.enum([
  "reversible",
  "partially_reversible",
  "irreversible",
  "unknown",
]);
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

/** A caller-decomposed fact. Structured claims skip compilation entirely — no model call. */
/** Mirrors the server's `EntityRef`: a named entity, optionally with an id and a type. */
const entityRefInput = z.object({
  name: z.string().min(1),
  id: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
});

/** Mirrors the server's `FactScope`: scalar values, not strings only. */
const scopeValueInput = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const structuredClaimInput = z
  .object({
    subject: z.union([z.string().trim().min(1).max(1_000), entityRefInput]),
    predicate: z.string().trim().min(1).max(1_000),
    object: z
      .union([
        z.string().trim().min(1).max(2_000),
        entityRefInput,
        z.number().finite(),
        z.boolean(),
        z.null(),
      ])
      .optional(),
    scope: z
      .record(scopeValueInput)
      .optional()
      .describe(
        "what the claim is scoped to, e.g. { jurisdiction: 'US', plan: 'HMO' }",
      ),
    materiality: materialityInput.optional(),
    text: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

const claimInput = z.union([
  z.string().trim().min(1).max(2_000).describe("the fact as a plain sentence"),
  structuredClaimInput,
]);

const watchedSourceKindInput = z.enum([
  "url",
  "push",
  "connection",
  "entity",
  "discovered",
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

/**
 * The exact wire operations this server drives on the injected `kaval` client, typed structurally
 * against the live `/v1/*` contract. The MCP zod schemas own request validation; the client owns
 * transport (auth headers, idempotency keys, bounded ambiguous-outcome retries).
 */
interface WireClient {
  check(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  getReceipt(receiptId: string, options?: TransportOptions): Promise<unknown>;
  addSource(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  listSources(
    options?: TransportOptions & { includeInactive?: boolean },
  ): Promise<unknown>;
  deleteSource(sourceId: string, options?: TransportOptions): Promise<unknown>;
  reportOutcome(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
  verify(
    input: Record<string, unknown>,
    options?: TransportOptions,
  ): Promise<unknown>;
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
    // The retired-route body is a FLAT { error: "tool_retired", replacement } — not the envelope.
    if (typeof err === "string") return { code: err };
  }
  return {};
}

/** True when a rejection means the request ran out of time — the MCP caller cancelled, or the
 *  client's own transport deadline fired. The node client aborts with the Error it constructed
 *  rather than a DOMException, so name-sniffing alone would miss its timeout. */
function isTimeout(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    /timed out/i.test(error.message)
  );
}

/** Run a tool body, returning a sanitized error result. An API error (e.g. 402 out-of-credit, 401
 *  invalid key, 410 tool_retired) is surfaced with its status + code/message so the agent can act
 *  on it; a timeout and an unreachable host are named too, because both have a move the agent can
 *  make. Anything else collapses to a generic message so internal details never leak. */
async function safe(fn: () => Promise<unknown>, signal?: AbortSignal) {
  try {
    return json(await fn());
  } catch (e) {
    console.error("[kaval-mcp] tool error:", e);
    // A 410 means this client is older than the server's surface. Name the route that replaced the
    // one it called, read off the error — hard-coding a version number produced the absurdity of
    // telling a 0.6 caller to upgrade to 0.6, and would do it again at 0.7.
    if (e instanceof KavalRetiredError) {
      return toolError({
        error: "tool_retired",
        message: `this capability was folded into ${e.replacement} — call the \`check\` tool with the action you are about to take, or with the claims it depends on.`,
        status: 410,
      });
    }
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
    // A check that outruns the deadline is the single most likely failure on the cold path, and an
    // agent handed the bare words "internal error" has nowhere to go. Both of the remaining shapes
    // have a next move, so say which one happened.
    if (isTimeout(e, signal)) {
      return toolError({
        error: "timeout",
        message:
          "the request did not finish inside the deadline — retry with mode:'fast' (stored state only, no research) or a smaller max_wait_ms",
      });
    }
    // `fetch` rejects with a TypeError when no response was ever produced: an unreachable host, a
    // DNS failure, or a malformed KAVAL_BASE_URL. That last one used to read as an internal fault.
    if (e instanceof TypeError) {
      return toolError({
        error: "network_unreachable",
        message:
          "could not reach the Kaval API — check KAVAL_BASE_URL and network access, then retry",
      });
    }
    return toolError({ error: "internal error" });
  }
}

/**
 * The agent-facing verification server.
 *
 * One tool does the work: `check`. Before an agent acts, it sends the proposed action; Kaval
 * identifies the facts that action depends on, checks them against the sources it watches, and
 * returns ALLOW, REVIEW, or BLOCK with a signed receipt. `get_receipt` fetches the full signed
 * document behind that receipt id, which is what an agent shows when it blocks. `add_source` /
 * `list_sources` / `remove_source` control what Kaval watches; `report_outcome` closes the
 * calibration loop. `verify` is a deprecated alias kept for pilot integrations. Tool names use
 * underscores for client portability.
 */
export function createMcpServer(client: Kaval): McpServer {
  const server = new McpServer({ name: "kaval", version: "0.7.0" });
  const api = client as unknown as WireClient;

  server.registerTool(
    "check",
    {
      description:
        "Verify the facts an action depends on BEFORE acting on it. Describe the action you are about to take (and any context you are relying on), or pass the specific claims, and Kaval re-checks each fact against the sources it watches — returning decision ALLOW, REVIEW, or BLOCK with a signed receipt. ALLOW: every material fact still holds on fresh evidence — proceed. REVIEW: something is unknown, mid-re-evaluation, or changed at low/medium materiality — REVIEW IS NEVER PERMISSION TO ACT; surface it to a human or re-research. BLOCK: a high/critical fact has changed, or a critical fact is unknown — do not proceed. Each returned fact carries its status (holds | changed | unknown) and the sources it rests on, so you can see exactly WHICH belief moved. A fact already backed by a watched source is answered from stored state in ~50ms with no model call and no fetch, so calling it on every consequential action is cheap; a fact Kaval has not seen before has to be researched first and takes seconds. Use this instead of re-researching a fact you already believe.",
      inputSchema: {
        action: z
          .string()
          .trim()
          .min(1)
          .max(10_000)
          .optional()
          .describe(
            "what you are about to do, in plain language, e.g. 'Approve this claim at the 2026 in-network rate'. Kaval extracts the facts it depends on.",
          ),
        context: z
          .string()
          .trim()
          .min(1)
          .max(10_000)
          .optional()
          .describe(
            "what you already believe that bears on the action — the retrieved chunk, the cached field, the prior answer",
          ),
        claims: z
          .array(claimInput)
          .min(1)
          .max(20)
          .optional()
          .describe(
            "check these facts directly instead of extracting them: plain sentences, or {subject, predicate, object, scope} objects (structured claims skip extraction entirely)",
          ),
        mode: z
          .enum(["fast", "standard"])
          .optional()
          .describe(
            "'standard' (default) may research anything stale or novel within max_wait_ms; 'fast' answers only from stored state and reports anything it does not know as unknown",
          ),
        max_wait_ms: z
          .number()
          .int()
          .min(MIN_CHECK_MAX_WAIT_MS)
          .max(MCP_CHECK_MAX_WAIT_MS)
          .optional()
          .describe(
            `budget in ms for live research on facts that are stale or new. Over MCP this defaults to ${MCP_CHECK_MAX_WAIT_MS} and cannot go higher, because a tool call is cancelled by the caller at 60s; the API's own default, for direct HTTP callers, is ${DEFAULT_CHECK_MAX_WAIT_MS}. Lower it when a bounded REVIEW beats waiting; ${MIN_CHECK_MAX_WAIT_MS} disables research entirely, which is what mode:'fast' does. Facts that miss the budget come back as unknown.`,
          ),
        origin_urls: z
          .array(httpUrlInput)
          .max(20)
          .optional()
          .describe(
            "authoritative sources for this action, merged with whatever this workspace already watches",
          ),
        materiality: materialityInput
          .optional()
          .describe(
            "how much this action's correctness matters — drives whether a changed fact is REVIEW or BLOCK",
          ),
        as_of: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("RFC 3339 cutoff for what the action may rely on"),
      },
    },
    async ({ max_wait_ms, ...args }, { signal }) => {
      if (args.action === undefined && args.claims === undefined) {
        return toolError({
          error: "bad_request",
          message:
            "provide `action` (what you are about to do) or `claims` (the facts to check)",
        });
      }
      // Always send the budget. Omitting it inherits the API's 100s default, which outlives the MCP
      // caller's own request deadline — the check would be cancelled rather than answered.
      return safe(
        () =>
          api.check(
            { ...args, max_wait_ms: max_wait_ms ?? MCP_CHECK_MAX_WAIT_MS },
            transportOptions(undefined, signal),
          ),
        signal,
      );
    },
  );

  server.registerTool(
    "get_receipt",
    {
      description:
        "Fetch the full signed receipt for a check you already ran, by the `receipt.id` that check returned. `check` gives you only the id, the signature, and when it was signed; this returns the document that was actually signed — every fact with its state and the evidence basis under it (source locator, content digest, fetch and publication time), the freshness failure if state could not be served, the decision-rule version, and the signing key id. Get it when you have to SHOW the work: attach it to a BLOCK you are escalating, hand it to a reviewer or auditor, or check the verdict offline — the decision table is published, so the receipt's own fact list re-derives its decision with no server involved.",
      inputSchema: {
        receipt_id: z
          .string()
          .uuid()
          .describe("the `receipt.id` from the check you want the proof for"),
      },
    },
    async ({ receipt_id }, { signal }) =>
      // The client unwraps the envelope for TypeScript callers; an agent reads a named field more
      // reliably than a bare object, so put it back.
      safe(
        async () => ({ receipt: await api.getReceipt(receipt_id, { signal }) }),
        signal,
      ),
  );

  server.registerTool(
    "add_source",
    {
      description:
        "Tell Kaval what to watch, so later checks are answered from fresh state instead of live research. Registering the NAME of an authority is usually enough: {kind:'entity', name:'Aetna', intent:'payer policy bulletins'} resolves to the pages that publish it and watches them. Use kind:'url' for a specific page, kind:'push' for a document your own system will send in. Kaval polls watched sources adaptively, re-evaluates the facts that depend on them when they change, and (if a fact_state webhook is configured) pushes you a delta naming what flipped. You do not have to call this first — an unregistered source cited by a check is auto-watched — but registering ahead of time is what makes the first check on a fact fast.",
      inputSchema: {
        kind: watchedSourceKindInput.describe(
          "url (a specific page) | entity (a name to resolve) | push (a document you will send to Kaval) | connection (a configured system of record)",
        ),
        locator: z
          .string()
          .trim()
          .min(1)
          .max(2_048)
          .optional()
          .describe("the URL, connection id, or push locator"),
        name: z
          .string()
          .trim()
          .min(1)
          .max(2_048)
          .optional()
          .describe(
            "for kind:'entity', the plain name of the authority, e.g. 'Aetna' — the same field as locator, spelled for readability",
          ),
        label: z.string().trim().min(1).max(512).optional(),
        intent: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .optional()
          .describe(
            "what you want watched about it, e.g. 'prior-authorization policy bulletins'. Drives entity resolution.",
          ),
        scope_keys: z
          .array(z.string().trim().min(1).max(256))
          .max(64)
          .optional()
          .describe(
            "tags that route document changes to the facts they can affect, e.g. ['plan:HMO','state:CA']",
          ),
        poll_interval_s: z
          .number()
          .int()
          .min(60)
          .max(7 * 24 * 60 * 60)
          .optional()
          .describe(
            "starting poll interval; Kaval adapts it — slower when nothing changes, faster when it does",
          ),
      },
    },
    async (args, { signal }) => {
      if (args.locator === undefined && args.name === undefined) {
        return toolError({
          error: "bad_request",
          message: "provide `locator`, or `name` for kind:'entity'",
        });
      }
      return safe(
        () => api.addSource(args, transportOptions(undefined, signal)),
        signal,
      );
    },
  );

  server.registerTool(
    "list_sources",
    {
      description:
        "List what Kaval currently watches for this workspace — including sources it auto-registered after a check cited them. Each row shows the locator, what it was registered for, when it was last successfully fetched, and whether it is active. Use it to see whether the fact you care about is actually backed by a watched source (and therefore fast and monitored) before relying on a check being warm.",
      inputSchema: {
        include_inactive: z
          .boolean()
          .optional()
          .describe("also return paused sources (default false)"),
      },
    },
    async ({ include_inactive }, { signal }) =>
      // The client unwraps the envelope for TypeScript callers; an agent reads a named field more
      // reliably than a bare array, so put it back.
      safe(
        async () => ({
          sources: await api.listSources({
            signal,
            ...(include_inactive === undefined
              ? {}
              : { includeInactive: include_inactive }),
          }),
        }),
        signal,
      ),
  );

  server.registerTool(
    "remove_source",
    {
      description:
        "Stop watching a source and forget it, by the `id` `add_source` or `list_sources` returned. Removal is the only thing that frees registry capacity, and capacity is finite: a workspace watches a bounded number of ACTIVE sources, and every URL a check cites gets auto-registered against that same bound, so an agent that only ever adds eventually fills it — after which new citations are silently dropped and checks that used to be warm go back to researching. Remove what you registered for a task once the task is done. This forgets the source itself, not the facts already checked against it.",
      inputSchema: {
        id: z
          .string()
          .uuid()
          .describe(
            "the watched-source id returned by add_source (`source.id`) or list_sources",
          ),
      },
    },
    async ({ id }, { signal }) =>
      safe(() => api.deleteSource(id, { signal }), signal),
  );

  server.registerTool(
    "report_outcome",
    {
      description:
        "Report what actually happened after a prior check, using the receipt id it returned, so Kaval can calibrate. Use `relied_and_correct` when you acted on an ALLOW and it held; `current_later_contradicted` when an ALLOW turned out to be wrong; `stale_caught_real` when a REVIEW/BLOCK caught a genuine change; `stale_was_false_alarm` when it did not.",
      // These bounds mirror the server's OutcomeRequest exactly. A model that invents a receipt id
      // is a real failure mode here, and it should hear the field name from us rather than get a
      // round-trip `bad_request` with nothing pointing at `id`.
      inputSchema: {
        id: z
          .string()
          .uuid()
          .describe("the `receipt.id` returned by the check you are labelling"),
        kind: z.enum([
          "current_later_contradicted",
          "stale_caught_real",
          "stale_was_false_alarm",
          "relied_and_correct",
        ]),
        note: z
          .string()
          .max(2_048)
          .refine(
            (value) => !value.includes("\0"),
            "must not contain null bytes",
          )
          .optional(),
      },
    },
    async (args, { signal }) =>
      safe(
        () => api.reportOutcome(args, transportOptions(undefined, signal)),
        signal,
      ),
  );

  // Deprecated pilot alias. Kept only while conclusion+evidence_refs integrations migrate; the
  // description steers new callers to `check` without breaking prompts that already name it.
  server.registerTool(
    "verify",
    {
      description:
        "DEPRECATED — prefer the `check` tool. Verifies one load-bearing conclusion against evidence references you supply and returns a signed ProofPacket receipt (status valid | invalidated | could_not_verify, receipt.decision ALLOW | REVIEW | BLOCK). Kept only for existing pilot integrations that pass explicit evidence_refs; it will be removed. New calls should use `check`, which needs no evidence list, is answered from watched state in milliseconds, and keeps monitoring the facts afterwards.",
      inputSchema: {
        conclusion: z
          .string()
          .min(1)
          .max(10_000)
          .describe(
            "the exact assertable proposition the downstream workflow intends to rely on — a STATEMENT of what you believe, in the indicative. The API rejects anything phrased as a request or a question, INCLUDING the phrasing this tool's name invites: 'verify whether/if/that …', 'check whether …', 'is X still true?', and role prefixes like 'system:'. Write \"The 2024 International Building Code is the current IBC edition.\", not \"Verify that the 2024 IBC is the current edition.\"",
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
      safe(
        () => api.verify(args, transportOptions(idempotency_key, signal)),
        signal,
      ),
  );

  return server;
}
