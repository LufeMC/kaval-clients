/**
 * kaval — the freshness gate for AI. A typed, dependency-light HTTP client for the kaval API.
 * Mirrors the Python SDK (`pip install kaval`). Uses the global `fetch` (Node 18+, browsers, edge).
 */

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
  ) {
    super(`kaval ${status}: ${JSON.stringify(payload)}`);
    this.name = "KavalError";
  }
}

export interface KavalOptions {
  apiKey?: string;
  /** Defaults to https://api.usekaval.com */
  baseUrl?: string;
  /** Inject a fetch implementation (tests, custom agents). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.usekaval.com";

/** The kaval client: a belief your system holds in, a typed freshness verdict out. */
export class Kaval {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly f: typeof fetch;

  constructor(opts: KavalOptions = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
    this.headers = { "content-type": "application/json" };
    if (opts.apiKey) this.headers["authorization"] = `Bearer ${opts.apiKey}`;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.f(`${this.base}${path}`, {
      method: "POST",
      headers: this.headers,
      // JSON.stringify omits `undefined` keys, so optional params drop out automatically.
      body: JSON.stringify(body),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new KavalError(res.status, payload);
    return payload as T;
  }

  /** Pre-action gate: the verdict plus `act`. Treat `act === false` as "re-fetch before relying on it". */
  verify(input: string | VerifyInput): Promise<Decision> {
    return this.post(
      "/v1/verify",
      typeof input === "string" ? { belief: input } : input,
    );
  }

  /** Re-ground a held belief → the raw freshness verdict (no act decision). */
  check(input: string | CheckInput): Promise<Verdict> {
    return this.post(
      "/v1/check",
      typeof input === "string" ? { belief: input } : input,
    );
  }

  /** Pull every factual belief out of a paragraph and check each. */
  extractAndCheck(input: {
    text: string;
    context?: string;
    freshness_sla?: string;
  }): Promise<{ beliefs: CheckedBelief[] }> {
    return this.post("/v1/extract-and-check", input);
  }

  /** Sweep a belief store for drift, worst first. */
  scanStore(input: ScanInput): Promise<ScanResult> {
    return this.post("/v1/scan-store", input);
  }

  /** Sweep + POST the newly-risky beliefs to a `webhook` (server-side delivery). */
  monitor(input: MonitorInput): Promise<MonitorResult> {
    return this.post("/v1/monitor", input);
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
  kaval(request: Record<string, unknown>): Promise<Verdict> {
    return this.post("/v1/kaval", request);
  }

  /** Batch of structured `KavalRequest`s → a `Verdict` per request (same order). Mirrors the Python
   *  `kaval_batch()`. */
  kavalBatch(
    requests: Record<string, unknown>[],
    opts: { concurrency?: number } = {},
  ): Promise<Verdict[]> {
    return this.post("/v1/kaval-batch", {
      requests,
      concurrency: opts.concurrency,
    });
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
