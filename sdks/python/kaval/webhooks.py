""""Is this delivery really from Kaval?" — the first question a ``fact_state.delta`` receiver has.

Your callback URL is a public HTTPS endpoint. Anything on the internet can POST a plausible delta to
it, and a delta says "a fact your agent relies on just flipped" — an instruction worth forging. The
signature is what separates the two, and until now every integrator had to reimplement it from prose.

Kaval signs Standard-Webhooks style: HMAC-SHA256 over ``<webhook-id>.<webhook-timestamp>.<body>``,
base64url, delivered as ``webhook-signature: v1,<mac>`` beside ``webhook-id``, ``webhook-timestamp``
and ``webhook-key-id``. This module is the receiving half of exactly that, and nothing else — it
authenticates the bytes; it does not parse or validate the event.

Nothing here touches the network or reads an API key, and it imports no third-party package.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import math
import re
import time
from typing import Iterable, Literal, Mapping, Optional, Tuple, Union, cast

# The only signature scheme that exists. A `v2` would be a new format, not a new key.
WEBHOOK_SIGNATURE_VERSION = "v1"

# What the MAC is taken over, verbatim from `webhook_verification["signed_content"]`.
WEBHOOK_SIGNED_CONTENT = "<webhook-id>.<webhook-timestamp>.<exact UTF-8 request body>"

# Five minutes either way, the Standard Webhooks recommendation.
#
# The window is a replay blunter, not replay protection: it bounds how long a captured delivery stays
# useful. Real deduplication is yours — keep the `webhook_id` of everything you have processed,
# because delivery is at-least-once by design and a retry is a legitimate duplicate.
DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300.0

WebhookRejectionReason = Literal[
    # A required `webhook-*` header is absent or empty.
    "missing_header",
    # `webhook-timestamp` is not the 10-13 digit Unix time the signer emits.
    "malformed_timestamp",
    # `webhook-key-id` names a generation you passed no secret for.
    "unknown_key_id",
    # The signature is versioned, but not `v1`.
    "unsupported_signature_version",
    # `webhook-signature` is not `<version>,<base64url 32-byte MAC>`.
    "malformed_signature",
    # Well-formed and checkable, and it is not the MAC over these bytes.
    "signature_mismatch",
    # Authentic, but dated outside the tolerance window.
    "timestamp_out_of_tolerance",
]

_REQUIRED_HEADERS = (
    "webhook-id",
    "webhook-timestamp",
    "webhook-key-id",
    "webhook-signature",
)
_UNIX_TIME = re.compile(r"^\d{10,13}$")
_MAC_BYTES = hashlib.sha256().digest_size


@dataclass(frozen=True)
class WebhookSignatureResult:
    """The verdict on one inbound delivery.

    Truthy exactly when :attr:`valid` is, so ``if not verify_webhook_signature(...)`` is both the
    obvious spelling and the correct one — an always-truthy result object is the way a verifier
    silently starts accepting everything.
    """

    valid: bool
    #: Why it was refused. ``None`` on acceptance.
    reason: Optional[WebhookRejectionReason] = None
    #: Safe to log. Contains no secret material.
    message: str = ""
    #: The generation that signed it — ``webhook-key-id``. ``None`` on rejection.
    key_id: Optional[str] = None
    #: The CloudEvent id (``webhook-id``, equal to the event's own ``id``). Deliveries are
    #: at-least-once: dedupe on this before acting, or a retry replays your side effects.
    webhook_id: Optional[str] = None
    #: ``webhook-timestamp`` as sent by the signer, timezone-aware UTC.
    timestamp: Optional[datetime] = None

    def __bool__(self) -> bool:
        return self.valid


def _reject(reason: WebhookRejectionReason, message: str) -> WebhookSignatureResult:
    return WebhookSignatureResult(valid=False, reason=reason, message=message)


def _quoted(value: str) -> str:
    """Attacker-controlled header text ends up in someone's log line. Bound what it can put there."""
    return value if len(value) <= 128 else f"{value[:128]}…"


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    """Read one header out of whatever the framework handed us.

    Starlette/FastAPI, Flask and Django all expose case-insensitive ``.get``; a plain ``dict`` built
    by hand may not, so a lowercased scan is the fallback rather than a silent miss that would read
    as an unsigned request.
    """
    getter = getattr(headers, "get", None)
    if callable(getter):
        value = getter(name)
        if isinstance(value, str):
            return value
    items = getattr(headers, "items", None)
    if callable(items):
        # `getattr` erases the return type to `object`, which is not iterable as far as a type
        # checker is concerned. The cast states what a mapping's `items()` yields; the isinstance
        # guards below are what actually make it safe, since `headers` may be any framework's
        # header object rather than a real Mapping.
        for key, value in cast(Iterable[Tuple[object, object]], items()):
            if isinstance(key, str) and key.lower() == name and isinstance(value, str):
                return value
    return None


def _decode_base64url(value: str) -> bytes:
    """Lenient decode then a length check — what the signer's own receiver does."""
    try:
        return base64.urlsafe_b64decode(f"{value}{'=' * (-len(value) % 4)}".encode("ascii"))
    except (binascii.Error, ValueError):
        return b""


def _offered_macs(header: str) -> tuple[list[bytes], bool]:
    """Every well-formed ``v1`` MAC on offer, and whether some other version was also offered.

    Standard Webhooks permits a space-separated list, so a sender can offer several signatures for
    one body. Kaval sends exactly one today; accepting the list costs nothing and means a future
    dual-signed rollout does not need a new SDK on the receiving side.
    """
    macs: list[bytes] = []
    other_version = False
    for element in header.split():
        parts = element.split(",")
        if len(parts) != 2 or not parts[1]:
            continue
        if parts[0] != WEBHOOK_SIGNATURE_VERSION:
            other_version = True
            continue
        decoded = _decode_base64url(parts[1])
        if len(decoded) == _MAC_BYTES:
            macs.append(decoded)
    return macs, other_version


def _timestamp_seconds(digits: str) -> Optional[float]:
    """The signer emits Unix seconds today and its contract admits 10-13 digits.

    Twelve digits or more is milliseconds; fewer is seconds. Both real spellings (10-digit seconds,
    13-digit milliseconds) stay unambiguous until the year 2286, and the in-between widths are absurd
    as either reading.
    """
    if not _UNIX_TIME.match(digits):
        return None
    value = float(digits)
    return value / 1000.0 if len(digits) >= 12 else value


def verify_webhook_signature(
    *,
    body: Union[bytes, bytearray, memoryview, str],
    headers: Mapping[str, str],
    secrets: Mapping[str, str],
    tolerance_seconds: Optional[float] = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
    now: Union[float, datetime, None] = None,
) -> WebhookSignatureResult:
    """Verify the HMAC-SHA256 signature on an inbound Kaval webhook.

    Checks run cheapest-first, and the order is deliberate: structural problems are named before any
    MAC is computed, and the replay window is checked LAST, so ``timestamp_out_of_tolerance`` can
    only ever be reported for a delivery that is genuinely ours and merely old.

    :param body: The EXACT bytes of the request body, before any JSON parsing. The MAC covers the
        octets on the wire, so a body that has been parsed and re-serialised produces a different MAC
        and every genuine delivery fails. In FastAPI that means ``await request.body()``, not the
        parsed model; in Flask, ``request.get_data()``, not ``request.json``.
    :param headers: The inbound request headers. Anything with a case-insensitive ``.get`` works —
        ``request.headers`` in FastAPI/Starlette, Flask and Django all do.
    :param secrets: ``webhook-key-id`` → that generation's base64url
        ``webhook_verification["secret"]``. A mapping rather than a single secret because rotation
        overlaps deliberately: after :meth:`~kaval.KavalClient.rotate_webhook_signing_key` both
        generations sign real deliveries until ``overlap_until``. Hold both here and the rollover is
        a config change instead of an outage.
    :param tolerance_seconds: Seconds either side of ``now``. ``None`` disables the check — then
        replay defence is entirely yours.
    :param now: Verification instant, as epoch seconds or an aware ``datetime``. Defaults to the wall
        clock.
    :raises TypeError: only for caller mistakes — an empty ``secrets`` mapping, a body that is
        neither text nor bytes, a nonsensical tolerance. Everything attacker-controlled comes back as
        a rejection you can log, never as an exception.
    """
    if not secrets or not callable(getattr(secrets, "get", None)):
        raise TypeError(
            "secrets must map at least one webhook-key-id to its base64url "
            'webhook_verification["secret"]'
        )
    if isinstance(body, str):
        body_bytes = body.encode("utf-8")
    elif isinstance(body, (bytes, bytearray, memoryview)):
        body_bytes = bytes(body)
    else:
        raise TypeError(
            "body must be the raw request bytes or the raw body text, never a parsed object"
        )
    if tolerance_seconds is not None and (
        not isinstance(tolerance_seconds, (int, float))
        or isinstance(tolerance_seconds, bool)
        or not math.isfinite(tolerance_seconds)
        or tolerance_seconds < 0
    ):
        raise TypeError(
            "tolerance_seconds must be a non-negative finite number, or None to disable the window"
        )

    present: dict[str, str] = {}
    for name in _REQUIRED_HEADERS:
        value = _header(headers, name)
        if not value:
            return _reject(
                "missing_header", f"{name} is missing or empty — Kaval did not sign this"
            )
        present[name] = value

    seconds = _timestamp_seconds(present["webhook-timestamp"])
    if seconds is None:
        return _reject(
            "malformed_timestamp", "webhook-timestamp must be 10-13 digits of Unix time"
        )

    key_id = present["webhook-key-id"]
    secret = secrets.get(key_id)
    if not isinstance(secret, str) or not secret:
        return _reject(
            "unknown_key_id",
            f"no secret was supplied for webhook-key-id {_quoted(key_id)} — if the key "
            "was just rotated, add the new generation",
        )

    macs, other_version = _offered_macs(present["webhook-signature"])
    if not macs:
        if other_version:
            return _reject(
                "unsupported_signature_version",
                f"webhook-signature offers no {WEBHOOK_SIGNATURE_VERSION} signature; "
                "this SDK is older than the delivery",
            )
        return _reject(
            "malformed_signature",
            f"webhook-signature must be {WEBHOOK_SIGNATURE_VERSION},"
            f"<base64url {_MAC_BYTES}-byte MAC>",
        )

    signed_content = b".".join(
        (
            present["webhook-id"].encode("utf-8"),
            present["webhook-timestamp"].encode("utf-8"),
            body_bytes,
        )
    )
    expected = hmac.new(_decode_base64url(secret), signed_content, hashlib.sha256).digest()
    # Compare every offer, and compare all of them: returning on the first match would leak, through
    # timing, which position matched.
    matched = False
    for mac in macs:
        if hmac.compare_digest(mac, expected):
            matched = True
    if not matched:
        return _reject(
            "signature_mismatch",
            "webhook-signature is not the MAC over these exact body bytes",
        )

    if tolerance_seconds is not None:
        if now is None:
            at = time.time()
        elif isinstance(now, datetime):
            at = now.timestamp()
        else:
            at = float(now)
        skew = abs(at - seconds)
        if skew > tolerance_seconds:
            return _reject(
                "timestamp_out_of_tolerance",
                f"signature is authentic but {round(skew)}s from now, outside the "
                f"{tolerance_seconds:g}s window",
            )

    return WebhookSignatureResult(
        valid=True,
        key_id=key_id,
        webhook_id=present["webhook-id"],
        timestamp=datetime.fromtimestamp(seconds, tz=timezone.utc),
    )
