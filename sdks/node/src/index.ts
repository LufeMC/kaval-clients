/**
 * @usekaval/kaval — the evidence gate for AI agents. A typed, dependency-light HTTP client for the Kaval API.
 * Mirrors the Python SDK (`pip install kaval`). Uses the global `fetch` (Node 18+, browsers, edge).
 */

import type {
  AuditInput,
  ProofGateInput,
  ProofGateResult,
  ProofPacket,
} from "./proof.js";
import {
  reviewOnlyCommerceActionTimeGateResult,
  reviewOnlyOfferSearchProgressEvent,
  reviewOnlyOfferSearchReplayEvent,
  reviewOnlyOfferSearchResult,
  type CommerceActionTimeGateInput,
  type CommerceActionTimeGateResult,
  type LiveOfferSearchResult,
  type OfferSearchInput,
  type OfferSearchStreamEvent,
} from "./offer-search.js";

export type * from "./proof.js";
export type * from "./offer-search.js";

export type VerdictStatus =
  | "current"
  | "stale"
  | "contradicted"
  | "unsupported"
  | "conflicting"
  | "insufficient";

/** Speed/depth tier for a verify() call. */
export type VerifyMode = "instant" | "fast" | "auto" | "deep";

export interface Evidence {
  /** Canonical source signature (host/path). */
  source: string;
  url?: string;
  fetched_at: string;
  http_status?: number;
  content_hash?: string;
  extracted: { statement: string; [k: string]: unknown };
  authority?: number | string;
}

/** A source backing a deep-tier explanation; `[n]` in the content refers to `citations[n-1]`. */
export interface Citation {
  url: string;
  title?: string;
}

/** The deep tier's cited synthesis: markdown `content` with `[n]` citations + an overall grounding band. */
export interface Explanation {
  content: string;
  citations: Citation[];
  confidence: "high" | "medium" | "low";
}

/** A typed freshness verdict for a belief. */
export interface Verdict {
  id: string;
  status: VerdictStatus;
  /** Calibrated 0–1. */
  confidence: number;
  reason: string;
  /** ISO timestamp — the freshness guarantee. */
  checked_at: string;
  evidence: Evidence[];
  /** Present iff `status !== "current"`. */
  discrepancy?: { kind: string; [k: string]: unknown };
  freshness_delta_s?: number;
  /** The tier that produced this verdict (echoes the requested `mode`, default "auto"). */
  tier?: VerifyMode;
  /** Deep tier only: a cited synthesis explaining the verdict. */
  explanation?: Explanation;
}

/** A verdict plus `act` — true only when the belief is `current` and confident enough to rely on. */
export interface Decision extends Verdict {
  act: boolean;
}

export interface CheckedBelief extends Verdict {
  belief: string;
}

export interface ScanRisk {
  id: string;
  belief?: string;
  status: VerdictStatus;
  confidence: number;
  reason: string;
  source?: string;
}

export interface ScanResult {
  total: number;
  summary: Partial<Record<VerdictStatus, number>>;
  /** The beliefs most likely to have drifted, worst first. */
  riskiest: ScanRisk[];
  /** The tier the sweep ran at (echoes `input.mode`, default "fast"). Always present. */
  tier: VerifyMode;
}

/** Cross-run memory so a monitor delivers only NEWLY-risky beliefs. Persist it between runs (cron) or
 *  pass the previous response's `state` straight back in. */
export interface MonitorState {
  riskyKeys: string[];
}

export interface MonitorResult extends ScanResult {
  checked_at: string;
  /** How many newly-risky beliefs were delivered to the webhook. */
  delivered: number;
  webhookOk?: boolean;
  /** This sweep's risky keys — pass it back as `input.state` next run so a still-stale belief isn't
   *  re-delivered every sweep. */
  state: MonitorState;
}

export type OutcomeKind =
  | "current_later_contradicted"
  | "stale_caught_real"
  | "stale_was_false_alarm"
  | "relied_and_correct";

export interface VerifyInput {
  belief: string;
  context?: string;
  url?: string;
  held_at?: string;
  held_content_hash?: string;
  held_evidence?: string[];
  freshness_sla?: string;
  proof_standard?: string;
  /** Act only if confidence ≥ this (default 0.7). */
  minConfidence?: number;
  /** Speed/depth tier: instant (cache/prior only, no LLM) | fast (cheap model) | auto (default) |
   *  deep (strongest model, max accuracy + a cited `explanation`). The response echoes `tier`. */
  mode?: VerifyMode;
}

export interface CheckInput {
  belief: string;
  context?: string;
  held_evidence?: string[];
  freshness_sla?: string;
  proof_standard?: string;
}

export interface ScanInput {
  beliefs: string[];
  freshness_sla?: string;
  concurrency?: number;
  /** Speed/depth tier for the whole sweep (default "fast"). */
  mode?: VerifyMode;
}

export interface MonitorInput extends ScanInput {
  /** URL that receives a POST with the newly-risky beliefs. */
  webhook?: string;
  /** Last sweep's risky keys (from the previous response's `state`) → deliver only newly-risky beliefs. */
  state?: MonitorState;
}

/** Thrown on any non-2xx response. */
export class KavalError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    /** Reuse this key to resolve/replay a billable request after an ambiguous failure. */
    readonly idempotencyKey?: string,
  ) {
    super(`kaval ${status}: ${JSON.stringify(payload)}`);
    this.name = "KavalError";
  }
}

function attachIdempotencyKey(error: unknown, idempotencyKey: string): unknown {
  if (error && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, "idempotencyKey", {
        value: idempotencyKey,
        enumerable: true,
        configurable: true,
      });
    } catch {
      // Preserve the original error even when a host object is non-extensible.
    }
  }
  return error;
}

export interface KavalOptions {
  apiKey?: string;
  /** Defaults to https://api.usekaval.com */
  baseUrl?: string;
  /** Inject a fetch implementation (tests, custom agents). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Default deadline for each HTTP operation. Defaults to 30 seconds; set null to disable. */
  timeoutMs?: number | null;
}

/** Transport options for one billable API operation. Kaval generates a UUID by default. Supply the
 * same key when coordinating a retry outside this client after an ambiguous/no-response failure. */
export interface RequestOptions {
  idempotencyKey?: string;
  /** Cancels the operation and every bounded retry. */
  signal?: AbortSignal;
  /** Per-call deadline override. Set null to disable the constructor default. */
  timeoutMs?: number | null;
}

export interface KavalBatchOptions extends RequestOptions {
  concurrency?: number;
}

const DEFAULT_BASE_URL = "https://api.usekaval.com";
const MAX_BILLABLE_ATTEMPTS = 2;
const AMBIGUOUS_IDEMPOTENCY_CODES = new Set([
  "idempotency_in_progress",
  "idempotency_resolution_pending",
  "event_persistence_pending",
]);
let fallbackUuidSequence = 0;

function fallbackRandomUuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node 18 exposes fetch but may not expose Web Crypto globally. Idempotency keys are uniqueness
    // tokens, not secrets, so mix multiple PRNG draws with time + a process-local sequence rather
    // than making every default billable call fail in that supported runtime.
    fallbackUuidSequence += 1;
    let state = (Date.now() ^ fallbackUuidSequence) >>> 0;
    for (let offset = 0; offset < bytes.length; offset += 1) {
      state =
        (Math.imul(
          state ^ Math.floor(Math.random() * 0x1_0000_0000),
          1_664_525,
        ) +
          1_013_904_223) >>>
        0;
      bytes[offset] = state & 0xff;
    }
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generatedIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : fallbackRandomUuid();
}

function apiErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload))
    return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object" || !("code" in error))
    return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function requestSignal(
  external: AbortSignal | undefined,
  timeoutMs: number | null,
): { signal: AbortSignal | undefined; cleanup(): void } {
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError("timeoutMs must be a positive finite number or null");
  }
  if (timeoutMs === null) return { signal: external, cleanup() {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) onAbort();
  else external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`kaval request timed out after ${timeoutMs}ms`),
      ),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/** The Kaval client: evidence in, an action-bound decision or review-only research result out. */
export class Kaval {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number | null;

  constructor(opts: KavalOptions = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs === undefined ? 30_000 : opts.timeoutMs;
    if (
      this.timeoutMs !== null &&
      (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0)
    ) {
      throw new RangeError(
        "timeoutMs must be a positive finite number or null",
      );
    }
    this.headers = { "content-type": "application/json" };
    if (opts.apiKey) this.headers["authorization"] = `Bearer ${opts.apiKey}`;
  }

  private async billablePost<T>(
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const idempotencyKey = options.idempotencyKey ?? generatedIdempotencyKey();
    const headers = { ...this.headers, "idempotency-key": idempotencyKey };
    const request = requestSignal(
      options.signal,
      options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs,
    );

    try {
      for (let attempt = 0; attempt < MAX_BILLABLE_ATTEMPTS; attempt += 1) {
        let res: Response;
        try {
          res = await this.f(`${this.base}${path}`, {
            method: "POST",
            headers,
            signal: request.signal,
            // JSON.stringify omits `undefined` keys, so optional params drop out automatically.
            body: JSON.stringify(body),
          });
        } catch (error) {
          if (request.signal?.aborted) {
            throw attachIdempotencyKey(error, idempotencyKey);
          }
          // A fetch rejection is transport-ambiguous: the server may have committed before the
          // connection failed. Retry once with the SAME key so it replays instead of double-billing.
          if (attempt + 1 < MAX_BILLABLE_ATTEMPTS) continue;
          throw attachIdempotencyKey(error, idempotencyKey);
        }

        let payload: unknown;
        try {
          payload = await res.json();
        } catch (error) {
          // A 2xx without the promised JSON contract is a protocol failure, not a successful null
          // result. Error responses may legitimately come from a non-Kaval intermediary as text.
          if (res.ok) throw attachIdempotencyKey(error, idempotencyKey);
          payload = null;
        }
        if (res.ok) return payload as T;

        const code = apiErrorCode(payload);
        if (
          attempt + 1 < MAX_BILLABLE_ATTEMPTS &&
          code !== undefined &&
          AMBIGUOUS_IDEMPOTENCY_CODES.has(code)
        ) {
          continue;
        }
        throw new KavalError(res.status, payload, idempotencyKey);
      }
    } finally {
      request.cleanup();
    }

    throw new Error("unreachable billable request state");
  }

  private async post<T>(
    path: string,
    body: unknown,
    options: Pick<RequestOptions, "signal" | "timeoutMs"> = {},
  ): Promise<T> {
    const request = requestSignal(
      options.signal,
      options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs,
    );
    try {
      const res = await this.f(`${this.base}${path}`, {
        method: "POST",
        headers: this.headers,
        signal: request.signal,
        // JSON.stringify omits `undefined` keys, so optional params drop out automatically.
        body: JSON.stringify(body),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new KavalError(res.status, payload);
      return payload as T;
    } finally {
      request.cleanup();
    }
  }

  /** Pre-action gate: the verdict plus `act`. Treat `act === false` as "re-fetch before relying on it". */
  verify(
    input: string | VerifyInput,
    options?: RequestOptions,
  ): Promise<Decision> {
    return this.billablePost(
      "/v1/verify",
      typeof input === "string" ? { belief: input } : input,
      options,
    );
  }

  /** Re-ground a held belief → the raw freshness verdict (no act decision). */
  check(
    input: string | CheckInput,
    options?: RequestOptions,
  ): Promise<Verdict> {
    return this.billablePost(
      "/v1/check",
      typeof input === "string" ? { belief: input } : input,
      options,
    );
  }

  /** Pull every factual belief out of a paragraph and check each. */
  extractAndCheck(
    input: {
      text: string;
      context?: string;
      freshness_sla?: string;
    },
    options?: RequestOptions,
  ): Promise<{ beliefs: CheckedBelief[] }> {
    return this.billablePost("/v1/extract-and-check", input, options);
  }

  /** Sweep a belief store for drift, worst first. */
  scanStore(input: ScanInput, options?: RequestOptions): Promise<ScanResult> {
    return this.billablePost("/v1/scan-store", input, options);
  }

  /** Sweep + POST the newly-risky beliefs to a `webhook` (server-side delivery). */
  monitor(
    input: MonitorInput,
    options?: RequestOptions,
  ): Promise<MonitorResult> {
    return this.billablePost("/v1/monitor", input, options);
  }

  /** Search the accessible configured web for exact or possible offers. Current results are
   * research-only: action.state is NEEDS_REVIEW or NO_RELIABLE_OFFER, never permission to quote. */
  async searchOffers(
    input: OfferSearchInput,
    options?: RequestOptions,
  ): Promise<LiveOfferSearchResult> {
    const result = await this.billablePost<unknown>(
      "/v1/search-offers",
      input,
      options,
    );
    return reviewOnlyOfferSearchResult(result, input.request_id);
  }

  /** Stream bounded, review-only acquisition progress followed by one canonical final result.
   * Cancellation closes the response body and propagates to the hosted acquisition operation. */
  async *streamOfferSearch(
    input: OfferSearchInput,
    options: RequestOptions = {},
  ): AsyncGenerator<OfferSearchStreamEvent, LiveOfferSearchResult, void> {
    const idempotencyKey = options.idempotencyKey ?? generatedIdempotencyKey();
    const headers = {
      ...this.headers,
      accept: "text/event-stream",
      "idempotency-key": idempotencyKey,
    };
    const request = requestSignal(
      options.signal,
      options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs,
    );

    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      for (let attempt = 0; attempt < MAX_BILLABLE_ATTEMPTS; attempt += 1) {
        try {
          response = await this.f(`${this.base}/v1/search-offers`, {
            method: "POST",
            headers,
            signal: request.signal,
            body: JSON.stringify(input),
          });
        } catch (error) {
          if (request.signal?.aborted || attempt + 1 >= MAX_BILLABLE_ATTEMPTS) {
            throw attachIdempotencyKey(error, idempotencyKey);
          }
          continue;
        }

        if (response.ok) break;
        const responseText = await response.text();
        let payload: unknown = responseText;
        try {
          payload = JSON.parse(responseText);
        } catch {
          // A non-Kaval intermediary may return a plain-text error.
        }
        const code = apiErrorCode(payload);
        if (
          attempt + 1 < MAX_BILLABLE_ATTEMPTS &&
          code !== undefined &&
          AMBIGUOUS_IDEMPOTENCY_CODES.has(code)
        ) {
          response = undefined;
          continue;
        }
        throw new KavalError(response.status, payload, idempotencyKey);
      }

      if (!response?.ok)
        throw new Error("unreachable Offer Search stream request state");
      if (
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        throw attachIdempotencyKey(
          new TypeError("Offer Search stream returned a non-SSE response"),
          idempotencyKey,
        );
      }
      if (!response.body) {
        throw attachIdempotencyKey(
          new TypeError("Offer Search stream response has no body"),
          idempotencyKey,
        );
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastSequence = -1;
      let finalResult: LiveOfferSearchResult | undefined;
      let streamRequestDigest: string | undefined;

      const consumeFrame = (frame: string): OfferSearchStreamEvent | null => {
        const lines = frame.split("\n");
        const eventName = lines
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim();
        const idText = lines
          .find((line) => line.startsWith("id:"))
          ?.slice("id:".length)
          .trim();
        const dataText = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (!eventName || !dataText) return null;

        let payload: unknown;
        try {
          payload = JSON.parse(dataText);
        } catch (error) {
          throw attachIdempotencyKey(error, idempotencyKey);
        }
        const id = idText === undefined ? undefined : Number(idText);
        if (idText !== undefined && (!Number.isInteger(id) || id! < 0)) {
          throw new TypeError("Offer Search stream event ID is invalid");
        }

        if (eventName === "error") {
          const error = payload as { status?: unknown };
          throw new KavalError(
            typeof error?.status === "number" ? error.status : 500,
            payload,
            idempotencyKey,
          );
        }
        if (eventName === "final") {
          const result = reviewOnlyOfferSearchResult(payload, input.request_id);
          if (
            streamRequestDigest !== undefined &&
            result.request_digest !== streamRequestDigest
          ) {
            throw new TypeError(
              "Offer Search stream events are bound to another final result",
            );
          }
          const sequence = Number.isInteger(id) ? id! : lastSequence + 1;
          if (sequence <= lastSequence) {
            throw new TypeError(
              "Offer Search stream sequence is not monotonic",
            );
          }
          lastSequence = sequence;
          finalResult = result;
          return { type: "final", sequence, result };
        }

        if (eventName === "replay") {
          const event = reviewOnlyOfferSearchReplayEvent(
            payload,
            input.request_id,
          );
          if (
            (id !== undefined && id !== event.sequence) ||
            event.sequence <= lastSequence
          ) {
            throw new TypeError(
              "Offer Search stream replay sequence is invalid",
            );
          }
          if (
            streamRequestDigest !== undefined &&
            event.request_digest !== streamRequestDigest
          ) {
            throw new TypeError("Offer Search replay request binding changed");
          }
          streamRequestDigest = event.request_digest;
          lastSequence = event.sequence;
          return event;
        }

        const event = reviewOnlyOfferSearchProgressEvent(payload);
        if (
          event.type !== eventName ||
          event.request_id !== input.request_id ||
          (id !== undefined && id !== event.sequence) ||
          event.sequence <= lastSequence
        ) {
          throw new TypeError(
            "Offer Search stream event sequence or type is invalid",
          );
        }
        if (event.type === "candidate_provisional") {
          if (
            streamRequestDigest !== undefined &&
            event.details.request_digest !== streamRequestDigest
          ) {
            throw new TypeError(
              "Offer Search provisional candidate request binding changed",
            );
          }
          streamRequestDigest = event.details.request_digest;
        }
        lastSequence = event.sequence;
        return event;
      };

      while (true) {
        const chunk = await reader.read();
        buffer =
          `${buffer}${decoder.decode(chunk.value, { stream: !chunk.done })}`.replaceAll(
            "\r\n",
            "\n",
          );
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = consumeFrame(frame);
          if (event) yield event;
          if (finalResult) return finalResult;
          boundary = buffer.indexOf("\n\n");
        }
        if (chunk.done) break;
      }

      if (buffer.trim().length > 0) {
        const event = consumeFrame(buffer);
        if (event) yield event;
        if (finalResult) return finalResult;
      }
      throw attachIdempotencyKey(
        new TypeError("Offer Search stream ended before its final result"),
        idempotencyKey,
      );
    } finally {
      await reader?.cancel().catch(() => undefined);
      request.cleanup();
    }
  }

  /** Re-read one persisted offer generation at the exact action boundary. This final fence always
   * returns REVIEW with commerce permission withheld; it never authorizes quoting or purchasing. */
  async gateOfferSearch(
    input: CommerceActionTimeGateInput,
    options?: Pick<RequestOptions, "signal" | "timeoutMs">,
  ): Promise<CommerceActionTimeGateResult> {
    const result = await this.post<unknown>(
      "/v1/search-offers/gate",
      input,
      options,
    );
    return reviewOnlyCommerceActionTimeGateResult(result, input);
  }

  /** Build, sign, and persist a complete action-bound proof packet. */
  audit(input: AuditInput, options?: RequestOptions): Promise<ProofPacket> {
    return this.billablePost("/v1/audit", input, options);
  }

  /** Apply a current durable proof to the exact action without repeating research. */
  gateAction(
    input: ProofGateInput,
    options?: RequestOptions,
  ): Promise<ProofGateResult> {
    return this.billablePost("/v1/gate", input, options);
  }

  /** Short alias for gateAction(). */
  gate(
    input: ProofGateInput,
    options?: RequestOptions,
  ): Promise<ProofGateResult> {
    return this.gateAction(input, options);
  }

  /** Report what actually happened, to calibrate trust over time. */
  reportOutcome(input: {
    id: string;
    kind: OutcomeKind;
    note?: string;
  }): Promise<{ ok: true }> {
    return this.post("/v1/report-outcome", input);
  }

  /** Lower-level structured passthrough: a `KavalRequest` in, the raw `Verdict` out. Prefer
   *  `verify`/`check` unless you need the structured fact-type form. Mirrors the Python `kaval()`. */
  kaval(
    request: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<Verdict> {
    return this.billablePost("/v1/kaval", request, options);
  }

  /** Batch of structured `KavalRequest`s → a `Verdict` per request (same order). Mirrors the Python
   *  `kaval_batch()`. */
  kavalBatch(
    requests: Record<string, unknown>[],
    opts: KavalBatchOptions = {},
  ): Promise<Verdict[]> {
    return this.billablePost(
      "/v1/kaval-batch",
      {
        requests,
        concurrency: opts.concurrency,
      },
      opts,
    );
  }

  async health(): Promise<{ ok: boolean; name: string; version: string }> {
    const res = await this.f(`${this.base}/health`);
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new KavalError(res.status, payload);
    return payload as { ok: boolean; name: string; version: string };
  }
}

/** Convenience factory, for callers who prefer a function over `new`. */
export function createKaval(opts?: KavalOptions): Kaval {
  return new Kaval(opts);
}
