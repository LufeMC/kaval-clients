/**
 * "Is this delivery really from Kaval?" — the first question a `fact_state.delta` receiver has.
 *
 * Your callback URL is a public HTTPS endpoint. Anything on the internet can POST a plausible delta
 * to it, and a delta says "a fact your agent relies on just flipped" — an instruction worth forging.
 * The signature is what separates the two, and until now every integrator had to reimplement it from
 * prose.
 *
 * Kaval signs Standard-Webhooks style: HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<body>`,
 * base64url, delivered as `webhook-signature: v1,<mac>` beside `webhook-id`, `webhook-timestamp` and
 * `webhook-key-id`. This is the receiving half of exactly that, and nothing else — it authenticates
 * the bytes, it does not parse or validate the event.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The only signature scheme that exists. A `v2` would be a new format, not a new key. */
export const WEBHOOK_SIGNATURE_VERSION = "v1";

/** What the MAC is taken over, verbatim from `webhook_verification.signed_content`. */
export const WEBHOOK_SIGNED_CONTENT =
  "<webhook-id>.<webhook-timestamp>.<exact UTF-8 request body>";

/**
 * Five minutes either way, the Standard Webhooks recommendation.
 *
 * The window is a replay blunter, not replay protection: it bounds how long a captured delivery
 * stays useful. Real deduplication is yours — keep the `webhookId` of everything you have processed,
 * because delivery is at-least-once by design and a retry is a legitimate duplicate.
 */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookRejectionReason =
  /** A required `webhook-*` header is absent, or arrived more than once. */
  | "missing_header"
  /** `webhook-timestamp` is not the 10-13 digit Unix time the signer emits. */
  | "malformed_timestamp"
  /** `webhook-key-id` names a generation you passed no secret for. */
  | "unknown_key_id"
  /** The signature is versioned, but not `v1`. */
  | "unsupported_signature_version"
  /** `webhook-signature` is not `<version>,<base64url 32-byte MAC>`. */
  | "malformed_signature"
  /** Well-formed and checkable, and it is not the MAC over these bytes. */
  | "signature_mismatch"
  /** Authentic, but dated outside the tolerance window. */
  | "timestamp_out_of_tolerance";

export interface WebhookSignatureAccepted {
  valid: true;
  /** The generation that signed it — `webhook-key-id`. */
  keyId: string;
  /**
   * The CloudEvent id (`webhook-id`, equal to the event's own `id`). Deliveries are at-least-once:
   * dedupe on this before acting, or a retry replays your side effects.
   */
  webhookId: string;
  /** `webhook-timestamp`, as sent by the signer. */
  timestamp: Date;
}

export interface WebhookSignatureRejected {
  valid: false;
  reason: WebhookRejectionReason;
  /** Safe to log. Contains no secret material. */
  message: string;
}

export type WebhookSignatureResult =
  WebhookSignatureAccepted | WebhookSignatureRejected;

/**
 * Anything a web framework calls a header bag: a `fetch`-style object with `.get()` (Next.js route
 * handlers, Hono, Cloudflare Workers) or a plain record (Express, Fastify, Node's own `http`).
 */
export type WebhookHeaderSource =
  | { get(name: string): string | null | undefined }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyWebhookSignatureInput {
  /**
   * The EXACT bytes of the request body, before any JSON parsing.
   *
   * The MAC covers the octets on the wire. `JSON.parse` followed by `JSON.stringify` is not a byte
   * round trip — it drops insignificant whitespace and respells numbers and escapes — so verifying a
   * re-serialised body computes a different MAC and rejects every genuine delivery. In Express that
   * means `express.raw({ type: "application/json" })` on this route, not `express.json()`.
   */
  body: string | Uint8Array;
  headers: WebhookHeaderSource;
  /**
   * `webhook-key-id` → the base64url secret from that generation's `webhook_verification.secret`.
   *
   * A map rather than a single secret because rotation overlaps deliberately: after
   * `rotateWebhookSigningKey()` both generations sign real deliveries until `overlap_until`. Hold
   * both here and the rollover is a config change instead of an outage.
   */
  secrets: Readonly<Record<string, string>>;
  /** Seconds either side of now. `null` disables the check — then replay defence is entirely yours. */
  toleranceSeconds?: number | null;
  /** Verification instant; defaults to `Date.now()`. Milliseconds since the epoch, or a `Date`. */
  now?: Date | number;
}

/** SHA-256's digest size — the only length a `v1` MAC can decode to. */
const MAC_BYTES = 32;

function reject(
  reason: WebhookRejectionReason,
  message: string,
): WebhookSignatureRejected {
  return { valid: false, reason, message };
}

/** Attacker-controlled header text ends up in someone's log line. Bound what it can put there. */
function quoted(value: string): string {
  return value.length <= 128 ? value : `${value.slice(0, 128)}…`;
}

/**
 * Read one header out of whatever the framework handed us.
 *
 * A repeated header is refused rather than joined: Node concatenates duplicates with ", ", and
 * silently MAC-ing a concatenation of an attacker's header and ours is exactly the ambiguity a
 * verifier must not resolve by guessing.
 */
function headerValue(source: WebhookHeaderSource, name: string): string | null {
  const getter = (source as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (header: string) => unknown).call(source, name);
    return typeof value === "string" ? value : null;
  }
  const bag = source as Record<string, string | readonly string[] | undefined>;
  let value = bag[name];
  if (value === undefined) {
    // Node lowercases what arrives over the wire; a hand-built object may not have.
    for (const [key, candidate] of Object.entries(bag)) {
      if (key.toLowerCase() === name) {
        value = candidate;
        break;
      }
    }
  }
  if (typeof value === "string") return value;
  if (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === "string"
  ) {
    return value[0];
  }
  return null;
}

interface OfferedSignatures {
  /** Every well-formed `v1` MAC on offer. */
  macs: Uint8Array[];
  /** At least one element carried a version we do not implement. */
  otherVersion: boolean;
}

/**
 * Standard Webhooks permits a space-separated list, so a sender can offer several signatures for one
 * body. Kaval sends exactly one today; accepting the list costs nothing and means a future
 * dual-signed rollout does not need a new SDK on the receiving side.
 */
function offeredSignatures(header: string): OfferedSignatures {
  const macs: Uint8Array[] = [];
  let otherVersion = false;
  for (const element of header
    .split(/\s+/u)
    .filter((part) => part.length > 0)) {
    const parts = element.split(",");
    const encoded = parts[1];
    if (parts.length !== 2 || encoded === undefined || encoded === "") continue;
    if (parts[0] !== WEBHOOK_SIGNATURE_VERSION) {
      otherVersion = true;
      continue;
    }
    // Decoded leniently and then length-checked, which is what the signer's own receiver does. A MAC
    // that is not 32 bytes cannot be a SHA-256 one whatever it decodes from.
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.byteLength === MAC_BYTES) macs.push(decoded);
  }
  return { macs, otherVersion };
}

/**
 * The signer emits Unix seconds today and its contract admits 10-13 digits. Twelve digits or more is
 * milliseconds; fewer is seconds. Both real spellings (10-digit seconds, 13-digit milliseconds) stay
 * unambiguous until the year 2286, and the in-between widths are absurd as either reading.
 */
function timestampMilliseconds(digits: string): number | null {
  if (!/^\d{10,13}$/u.test(digits)) return null;
  const value = Number(digits);
  return digits.length >= 12 ? value : value * 1000;
}

/**
 * Verify the HMAC-SHA256 signature on an inbound Kaval webhook.
 *
 * Checks run cheapest-first, and the order is deliberate: structural problems are named before any
 * MAC is computed, and the replay window is checked LAST, so `timestamp_out_of_tolerance` can only
 * ever be reported for a delivery that is genuinely ours and merely old.
 *
 * ```ts
 * const result = verifyWebhookSignature({ body: rawBody, headers: req.headers, secrets });
 * if (!result.valid) return res.status(400).send(result.reason);
 * ```
 *
 * `result` is an object, so `if (result)` is always true — branch on `result.valid`.
 *
 * Throws `TypeError` only for caller mistakes (an empty secret map, a body that is neither text nor
 * bytes). Everything attacker-controlled comes back as a rejection you can log, never as a throw.
 */
export function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): WebhookSignatureResult {
  const secrets = input.secrets;
  if (
    secrets === null ||
    typeof secrets !== "object" ||
    Object.keys(secrets).length === 0
  ) {
    throw new TypeError(
      "secrets must map at least one webhook-key-id to its base64url webhook_verification.secret",
    );
  }
  const body =
    typeof input.body === "string"
      ? Buffer.from(input.body, "utf8")
      : input.body;
  if (!(body instanceof Uint8Array)) {
    throw new TypeError(
      "body must be the raw request bytes (Buffer/Uint8Array) or the raw body text, never a parsed object",
    );
  }
  const tolerance =
    input.toleranceSeconds === undefined
      ? DEFAULT_WEBHOOK_TOLERANCE_SECONDS
      : input.toleranceSeconds;
  if (
    tolerance !== null &&
    (typeof tolerance !== "number" ||
      !Number.isFinite(tolerance) ||
      tolerance < 0)
  ) {
    throw new TypeError(
      "toleranceSeconds must be a non-negative finite number, or null to disable the window",
    );
  }

  const webhookId = headerValue(input.headers, "webhook-id");
  const timestamp = headerValue(input.headers, "webhook-timestamp");
  const keyId = headerValue(input.headers, "webhook-key-id");
  const signature = headerValue(input.headers, "webhook-signature");
  const UNSIGNED = "is missing, empty, or repeated — Kaval did not sign this";
  if (!webhookId) return reject("missing_header", `webhook-id ${UNSIGNED}`);
  if (!timestamp)
    return reject("missing_header", `webhook-timestamp ${UNSIGNED}`);
  if (!keyId) return reject("missing_header", `webhook-key-id ${UNSIGNED}`);
  if (!signature)
    return reject("missing_header", `webhook-signature ${UNSIGNED}`);

  const milliseconds = timestampMilliseconds(timestamp);
  if (milliseconds === null) {
    return reject(
      "malformed_timestamp",
      "webhook-timestamp must be 10-13 digits of Unix time",
    );
  }

  const secret = Object.hasOwn(secrets, keyId) ? secrets[keyId] : undefined;
  if (typeof secret !== "string" || secret === "") {
    return reject(
      "unknown_key_id",
      `no secret was supplied for webhook-key-id ${quoted(keyId)} — if the key was just rotated, add the new generation`,
    );
  }

  const { macs, otherVersion } = offeredSignatures(signature);
  if (macs.length === 0) {
    return otherVersion
      ? reject(
          "unsupported_signature_version",
          `webhook-signature offers no ${WEBHOOK_SIGNATURE_VERSION} signature; this SDK is older than the delivery`,
        )
      : reject(
          "malformed_signature",
          `webhook-signature must be ${WEBHOOK_SIGNATURE_VERSION},<base64url ${MAC_BYTES}-byte MAC>`,
        );
  }

  const expected = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(webhookId, "utf8")
    .update(".", "utf8")
    .update(timestamp, "utf8")
    .update(".", "utf8")
    .update(body)
    .digest();
  // Compare every offer, and compare all of them: bailing on the first match would leak, through
  // timing, which position matched.
  let matched = false;
  for (const mac of macs) {
    if (timingSafeEqual(mac, expected)) matched = true;
  }
  if (!matched) {
    return reject(
      "signature_mismatch",
      "webhook-signature is not the MAC over these exact body bytes",
    );
  }

  if (tolerance !== null) {
    const now = input.now === undefined ? Date.now() : Number(input.now);
    if (!Number.isFinite(now)) {
      throw new TypeError("now must be a Date or a millisecond timestamp");
    }
    const skewSeconds = Math.abs(now - milliseconds) / 1000;
    if (skewSeconds > tolerance) {
      return reject(
        "timestamp_out_of_tolerance",
        `signature is authentic but ${Math.round(skewSeconds)}s from now, outside the ${tolerance}s window`,
      );
    }
  }

  return { valid: true, keyId, webhookId, timestamp: new Date(milliseconds) };
}
