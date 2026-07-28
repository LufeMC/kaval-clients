const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

export interface Rfc3339Instant {
  epoch_milliseconds: number;
  epoch_nanoseconds: bigint;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parse a component-valid RFC 3339 instant without discarding sub-millisecond precision.
 *
 * This v1 profile accepts four-digit Gregorian years, seconds 00-59, one to nine fractional
 * digits, `Z` or a numeric offset, and rejects RFC 3339's `-00:00` unknown-local-offset marker.
 */
export function parseRfc3339Instant(value: unknown): Rfc3339Instant | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fractionalNanoseconds = BigInt((match[7] ?? "").padEnd(9, "0") || "0");
  const zone = match[8]!;
  const offsetSign = match[9];
  const offsetHour = Number(match[10] ?? "0");
  const offsetMinute = Number(match[11] ?? "0");

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    zone === "-00:00"
  ) {
    return null;
  }

  // Date.UTC treats years 0-99 as 1900-1999. Setting the full year explicitly avoids that
  // historical constructor behavior while retaining the full four-digit RFC 3339 range.
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  const offset =
    zone === "Z"
      ? 0
      : (offsetSign === "-" ? -1 : 1) *
        (offsetHour * 60 + offsetMinute) *
        60_000;
  const epochSecondMilliseconds = utc.getTime() - offset;
  if (!Number.isFinite(epochSecondMilliseconds)) return null;
  return {
    epoch_milliseconds:
      epochSecondMilliseconds + Number(fractionalNanoseconds / 1_000_000n),
    epoch_nanoseconds:
      BigInt(epochSecondMilliseconds) * 1_000_000n + fractionalNanoseconds,
  };
}

/** Millisecond projection for Date interoperability. Exact comparisons must use nanoseconds. */
export function rfc3339TimestampMilliseconds(value: unknown): number | null {
  return parseRfc3339Instant(value)?.epoch_milliseconds ?? null;
}

export function rfc3339TimestampNanoseconds(value: unknown): bigint | null {
  return parseRfc3339Instant(value)?.epoch_nanoseconds ?? null;
}

export function isRfc3339Timestamp(value: unknown): value is string {
  return parseRfc3339Instant(value) !== null;
}
