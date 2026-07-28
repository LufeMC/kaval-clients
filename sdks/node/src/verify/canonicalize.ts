import type { JsonValue } from "./types.js";

export const DEFAULT_MAX_JSON_DEPTH = 128;
export const DEFAULT_MAX_JSON_NODES = 1_000_000;
export const MAX_JSON_NUMBER_CHARACTERS = 1_000;

function fail(message: string): never {
  throw new Error(message);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Kaval stable JSON v1.
 *
 * Object keys use ECMAScript's default UTF-16 code-unit ordering, arrays retain their order,
 * strings/numbers use JSON.stringify spelling, integers must be safe integers, and no
 * insignificant whitespace is emitted.
 */
export function stableCanonicalJson(
  value: unknown,
  seen = new Set<object>(),
): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      return fail("canonical JSON does not permit non-finite numbers");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return fail(
        "canonical JSON does not permit integers outside the interoperable safe-integer range",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    return fail(`canonical JSON does not permit ${typeof value} values`);
  }
  if (seen.has(value))
    return fail("canonical JSON does not permit cyclic values");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          return fail("canonical JSON does not permit sparse arrays");
      }
      return `[${value.map((entry) => stableCanonicalJson(entry, seen)).join(",")}]`;
    }
    if (!isJsonObject(value))
      return fail("canonical JSON requires plain JSON objects");
    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (symbolKeys.length > 0)
      return fail("canonical JSON does not permit symbol keys");
    const keys = Object.keys(value).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableCanonicalJson(value[key], seen)}`,
      )
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalUnsignedReceiptJson(receipt: unknown): string {
  if (!isJsonObject(receipt)) throw new Error("receipt must be a JSON object");
  const unsigned: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(receipt)) {
    if (key !== "signature") unsigned[key] = receipt[key];
  }
  return stableCanonicalJson(unsigned);
}

export function canonicalUnsignedReceiptBytes(receipt: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalUnsignedReceiptJson(receipt));
}

class StrictJsonParser {
  private index = 0;
  private nodes = 0;

  constructor(
    private readonly source: string,
    private readonly maxDepth: number,
    private readonly maxNodes: number,
  ) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const result = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length)
      this.error("unexpected trailing input");
    return result;
  }

  private error(message: string): never {
    throw new Error(`${message} at JSON offset ${this.index}`);
  }

  private countNode(): void {
    this.nodes += 1;
    if (this.nodes > this.maxNodes) this.error("JSON node limit exceeded");
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r" ||
      this.source[this.index] === "\t"
    ) {
      this.index += 1;
    }
  }

  private parseValue(depth: number): JsonValue {
    if (depth > this.maxDepth) this.error("JSON depth limit exceeded");
    this.countNode();
    const token = this.source[this.index];
    if (token === '"') return this.parseString();
    if (token === "{") return this.parseObject(depth + 1);
    if (token === "[") return this.parseArray(depth + 1);
    if (token === "t") return this.parseLiteral("true", true);
    if (token === "f") return this.parseLiteral("false", false);
    if (token === "n") return this.parseLiteral("null", null);
    if (
      token === "-" ||
      (token !== undefined && token >= "0" && token <= "9")
    ) {
      return this.parseNumber();
    }
    this.error("expected a JSON value");
  }

  private parseLiteral<T extends JsonValue>(token: string, value: T): T {
    if (this.source.slice(this.index, this.index + token.length) !== token) {
      this.error(`invalid ${token} literal`);
    }
    this.index += token.length;
    return value;
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index]!;
      const code = character.charCodeAt(0);
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          this.error("invalid JSON string");
        }
      }
      if (code < 0x20) this.error("unescaped control character in JSON string");
      if (character === "\\") {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === undefined || !'"\\/bfnrtu'.includes(escape)) {
          this.error("invalid JSON string escape");
        }
        if (escape === "u") {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9A-Fa-f]{4}$/u.test(hex))
            this.error("invalid JSON unicode escape");
          this.index += 4;
        }
      }
      this.index += 1;
    }
    this.error("unterminated JSON string");
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.source.slice(this.index),
    );
    if (!match) this.error("invalid JSON number");
    const token = match[0];
    this.index += token.length;
    if (token.length > MAX_JSON_NUMBER_CHARACTERS) {
      this.error(
        `JSON number exceeds ${MAX_JSON_NUMBER_CHARACTERS} characters`,
      );
    }
    const value = Number(token);
    if (!Number.isFinite(value))
      this.error("JSON number is outside the finite range");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      this.error(
        "JSON integer is outside the interoperable safe-integer range",
      );
    }
    if (normalizedDecimal(token) !== normalizedDecimal(JSON.stringify(value))) {
      this.error(
        "JSON number loses information under ECMAScript Number coercion",
      );
    }
    return value;
  }

  private parseArray(depth: number): JsonValue[] {
    this.index += 1;
    const values: JsonValue[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return values;
    }
    while (true) {
      this.skipWhitespace();
      values.push(this.parseValue(depth));
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return values;
      }
      if (delimiter !== ",") this.error("expected ',' or ']' in JSON array");
      this.index += 1;
    }
  }

  private parseObject(depth: number): { [key: string]: JsonValue } {
    this.index += 1;
    const value = Object.create(null) as { [key: string]: JsonValue };
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return value;
    }
    while (true) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"')
        this.error("expected a JSON object key");
      const key = this.parseString();
      if (keys.has(key))
        this.error(`duplicate JSON object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":")
        this.error("expected ':' after JSON object key");
      this.index += 1;
      this.skipWhitespace();
      value[key] = this.parseValue(depth);
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return value;
      }
      if (delimiter !== ",") this.error("expected ',' or '}' in JSON object");
      this.index += 1;
    }
  }
}

/**
 * Parse JSON while rejecting duplicate keys, lossy/non-interoperable numbers, and
 * resource-exhaustion shapes.
 */
export function parseJsonStrict(
  source: string,
  options: { max_depth?: number; max_nodes?: number } = {},
): JsonValue {
  const maxDepth = options.max_depth ?? DEFAULT_MAX_JSON_DEPTH;
  const maxNodes = options.max_nodes ?? DEFAULT_MAX_JSON_NODES;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_024) {
    throw new Error("max_depth must be an integer between 1 and 1024");
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 10_000_000) {
    throw new Error("max_nodes must be an integer between 1 and 10000000");
  }
  return new StrictJsonParser(source, maxDepth, maxNodes).parse();
}

/**
 * Normalize a valid JSON number as an exact decimal coefficient and base-10 exponent.
 *
 * This comparison happens on the source lexeme before Number coercion. It lets equivalent spellings
 * such as `1.0` and `1e0` through while rejecting distinct decimal values that collapse to the same
 * IEEE-754 Number.
 */
function normalizedDecimal(token: string): string {
  const match =
    /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?$/u.exec(token);
  if (!match)
    return fail("internal error: invalid JSON number normalization input");
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/u, "");
  if (!digits) return "0e0";

  let trailingZeroes = 0;
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    trailingZeroes += 1;
  }
  const explicitExponentDigits = (match[5] ?? "0").replace(/^0+(?=\d)/u, "");
  const explicitExponent =
    BigInt(explicitExponentDigits) * (match[4] === "-" ? -1n : 1n);
  const exponent =
    explicitExponent - BigInt(fraction.length) + BigInt(trailingZeroes);
  return `${negative ? "-" : ""}${digits}e${exponent}`;
}
