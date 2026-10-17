// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// JSON.parse keeps the last of two equal keys without a word, so a second
// `packageManager` key can override the one a reviewer or a text search sees.
// This parser follows RFC 8259 exactly and rejects duplicate keys at any
// depth, comparing keys after escapes are decoded.

export class StrictJsonError extends Error {
  override name = 'StrictJsonError';
}

const MAX_DEPTH = 256;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

class Parser {
  private at = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): unknown {
    this.skipWhitespace();
    const value = this.parseValue('$', 0);
    this.skipWhitespace();
    if (this.at !== this.text.length) this.fail('unexpected content after the document');
    return value;
  }

  private fail(message: string): never {
    throw new StrictJsonError(`${message} at offset ${String(this.at)}`);
  }

  private skipWhitespace(): void {
    WHITESPACE.lastIndex = this.at;
    WHITESPACE.exec(this.text);
    this.at = WHITESPACE.lastIndex;
  }

  private expect(character: string): void {
    if (this.text[this.at] !== character) this.fail(`expected "${character}"`);
    this.at += 1;
  }

  private parseValue(path: string, depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail(`nested deeper than ${String(MAX_DEPTH)} levels`);
    const character = this.text[this.at];
    if (character === '{') return this.parseObject(path, depth);
    if (character === '[') return this.parseArray(path, depth);
    if (character === '"') return this.parseString();
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.text.startsWith(word, this.at)) {
        this.at += word.length;
        return value;
      }
    }
    NUMBER.lastIndex = this.at;
    const number = NUMBER.exec(this.text);
    if (number) {
      this.at = NUMBER.lastIndex;
      // A digit right after the match, as in 01, is not valid JSON.
      if (/[0-9]/.test(this.text[this.at] ?? '')) this.fail('invalid number');
      return Number(number[0]);
    }
    return this.fail('expected a value');
  }

  private parseObject(path: string, depth: number): Record<string, unknown> {
    this.expect('{');
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.at] === '}') {
      this.at += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.at] !== '"') this.fail('expected a string key');
      const key = this.parseString();
      if (seen.has(key)) {
        throw new StrictJsonError(`duplicate key ${JSON.stringify(key)} at ${path}`);
      }
      seen.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      const value = this.parseValue(`${path}.${key}`, depth + 1);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      if (this.text[this.at] === ',') {
        this.at += 1;
        continue;
      }
      this.expect('}');
      return result;
    }
  }

  private parseArray(path: string, depth: number): unknown[] {
    this.expect('[');
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.at] === ']') {
      this.at += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue(`${path}[${String(result.length)}]`, depth + 1));
      this.skipWhitespace();
      if (this.text[this.at] === ',') {
        this.at += 1;
        continue;
      }
      this.expect(']');
      return result;
    }
  }

  private parseString(): string {
    this.expect('"');
    let value = '';
    for (;;) {
      // Plain characters up to the next quote, backslash or control character.
      let end = this.at;
      for (; end < this.text.length; end += 1) {
        const code = this.text.charCodeAt(end);
        if (code === 0x22 || code === 0x5c || code < 0x20) break;
      }
      value += this.text.slice(this.at, end);
      this.at = end;
      const character = this.text[this.at];
      if (character === '"') {
        this.at += 1;
        return value;
      }
      if (character !== '\\') {
        return this.fail(
          character === undefined ? 'unterminated string' : 'raw control character in a string',
        );
      }
      const escape = this.text[this.at + 1] ?? '';
      if (escape === 'u') {
        const hex = this.text.slice(this.at + 2, this.at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid unicode escape');
        value += String.fromCharCode(parseInt(hex, 16));
        this.at += 6;
      } else {
        const decoded = ESCAPES[escape];
        if (decoded === undefined) this.fail('invalid escape');
        value += decoded;
        this.at += 2;
      }
    }
  }
}

/** Parses RFC 8259 JSON, failing on any duplicate object key. */
export function parseStrictJson(text: string): unknown {
  return new Parser(text).parseDocument();
}

const PACKAGE_MANAGER = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.[0-9a-f]{128}$/;

/** Problems with the `packageManager` pin in a parsed package.json. */
export function checkPackageManager(manifest: unknown, expectedVersion: string): string[] {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return ['package.json is not an object'];
  }
  if (!Object.hasOwn(manifest, 'packageManager')) return ['packageManager is missing'];
  const value: unknown = (manifest as Record<string, unknown>)['packageManager'];
  if (typeof value !== 'string') return ['packageManager is not a string'];
  const match = PACKAGE_MANAGER.exec(value);
  if (!match) {
    return [`packageManager "${value}" must be pnpm@<version>+sha512.<128 hex>`];
  }
  if (match[1] !== expectedVersion) {
    return [`packageManager pins pnpm ${match[1] ?? ''}, but CI installs pnpm ${expectedVersion}`];
  }
  return [];
}
