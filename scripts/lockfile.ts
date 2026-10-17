// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reads pnpm-lock.yaml (lockfile version 9) without a YAML dependency. Only the
// subset pnpm writes is supported: block mappings, block sequences of scalars,
// flow sequences of scalars and quoted or plain scalars. Flow mappings such as
// `resolution: {integrity: ...}` are kept as opaque strings. Anything else
// throws, so a format change fails the license check instead of hiding
// packages from it.

export class LockfileError extends Error {}

type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };
type YamlMap = Record<string, YamlValue>;

interface Line {
  number: number;
  indent: number;
  text: string;
}

function unquote(raw: string, lineNumber: number): string {
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) {
      throw new LockfileError(`line ${String(lineNumber)}: unterminated quoted string`);
    }
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) {
      throw new LockfileError(`line ${String(lineNumber)}: unterminated quoted string`);
    }
    return JSON.parse(raw) as string;
  }
  return raw;
}

function scalarOrFlow(raw: string, lineNumber: number): YamlValue {
  if (raw === '{}') return {};
  if (raw === '[]') return [];
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']'))
      throw new LockfileError(`line ${String(lineNumber)}: unterminated flow sequence`);
    return raw
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim(), lineNumber));
  }
  if (raw.startsWith('{')) {
    if (!raw.endsWith('}'))
      throw new LockfileError(`line ${String(lineNumber)}: unterminated flow mapping`);
    return raw;
  }
  return unquote(raw, lineNumber);
}

// Splits `key: value` where the key may be quoted and may contain colons.
function splitKey(text: string, lineNumber: number): [string, string] {
  let end: number;
  if (text.startsWith("'") || text.startsWith('"')) {
    const quote = text[0] ?? '';
    end = 1;
    for (;;) {
      end = text.indexOf(quote, end);
      if (end === -1)
        throw new LockfileError(`line ${String(lineNumber)}: unterminated quoted key`);
      if (quote === "'" && text[end + 1] === "'") {
        end += 2;
        continue;
      }
      break;
    }
    end++;
    if (text[end] !== ':')
      throw new LockfileError(`line ${String(lineNumber)}: expected ":" after key`);
  } else {
    const match = /:(?:\s|$)/.exec(text);
    if (!match) throw new LockfileError(`line ${String(lineNumber)}: expected "key: value"`);
    end = match.index;
  }
  return [unquote(text.slice(0, end), lineNumber), text.slice(end + 1).trim()];
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const first = lines[start];
  if (first?.text.startsWith('- ') === true || first?.text === '-') {
    const items: YamlValue[] = [];
    let i = start;
    for (let line = lines[i]; line?.indent === indent; line = lines[i]) {
      if (!line.text.startsWith('- ')) {
        throw new LockfileError(`line ${String(line.number)}: expected a sequence item`);
      }
      items.push(scalarOrFlow(line.text.slice(2).trim(), line.number));
      i++;
    }
    return [items, i];
  }
  const map: YamlMap = {};
  let i = start;
  for (let line = lines[i]; line !== undefined && line.indent >= indent; line = lines[i]) {
    if (line.indent > indent)
      throw new LockfileError(`line ${String(line.number)}: unexpected indentation`);
    const [key, rest] = splitKey(line.text, line.number);
    if (Object.hasOwn(map, key))
      throw new LockfileError(`line ${String(line.number)}: duplicate key "${key}"`);
    i++;
    if (rest === '') {
      const next = lines[i];
      if (next !== undefined && next.indent > indent) {
        const [child, after] = parseBlock(lines, i, next.indent);
        map[key] = child;
        i = after;
      } else {
        map[key] = '';
      }
    } else {
      map[key] = scalarOrFlow(rest, line.number);
    }
  }
  return [map, i];
}

export function parseYamlDocuments(text: string): YamlMap[] {
  const docs: Line[][] = [[]];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/^---\s*$/.test(raw)) {
      docs.push([]);
      return;
    }
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
    if (raw.includes('\t'))
      throw new LockfileError(`line ${String(index + 1)}: tabs are not supported`);
    const indent = raw.length - raw.trimStart().length;
    docs.at(-1)?.push({ number: index + 1, indent, text: raw.trim() });
  });
  return docs
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      const [value, end] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
      if (end !== lines.length || typeof value !== 'object' || Array.isArray(value)) {
        throw new LockfileError(`line ${String(lines[end]?.number ?? 0)}: unexpected content`);
      }
      return value;
    });
}

export interface LockedPackage {
  name: string;
  // The version pnpm reports: the registry version, the manifest version of a
  // tarball or git dependency, or the `file:` specifier of a directory.
  version: string;
  // True when the package declares os, cpu or libc, so it is installed only
  // on some platforms and may be absent from `pnpm licenses list`.
  platformSpecific: boolean;
  scope: 'prod' | 'dev';
}

export interface Lockfile {
  packages: LockedPackage[];
  // Importer paths relative to the workspace root, for example "." and "packages/core".
  importers: string[];
}

function asMap(value: YamlValue | undefined, what: string): YamlMap {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new LockfileError(`${what} is not a mapping`);
  return value;
}

function asString(value: YamlValue | undefined, what: string): string {
  if (typeof value !== 'string' || value === '') throw new LockfileError(`${what} is not a string`);
  return value;
}

// `foo@1.0.0(peer@2.0.0)` and `@scope/foo@1.0.0` split into name and version.
export function splitPackageKey(key: string): { name: string; version: string } {
  const peerStart = key.indexOf('(');
  const bare = peerStart === -1 ? key : key.slice(0, peerStart);
  const at = bare.indexOf('@', 1);
  if (at <= 0 || at === bare.length - 1) throw new LockfileError(`invalid package key "${key}"`);
  return { name: bare.slice(0, at), version: bare.slice(at + 1) };
}

// A dependency value is either a version (with optional peer suffix), an alias
// `real-name@version`, or a `link:` to a workspace folder.
function dependencyKey(name: string, value: string): string | undefined {
  if (value.startsWith('link:')) return undefined;
  const peerStart = value.indexOf('(');
  const bare = peerStart === -1 ? value : value.slice(0, peerStart);
  const at = bare.indexOf('@', 1);
  const isAlias = at > 0 && !/^(file|git|https?|git\+\w+):/.test(bare);
  return isAlias ? value : `${name}@${value}`;
}

function edges(entry: YamlMap, fields: readonly string[], what: string): string[] {
  const out: string[] = [];
  for (const field of fields) {
    for (const [name, raw] of Object.entries(asMap(entry[field], `${what} ${field}`))) {
      const value =
        typeof raw === 'object' && !Array.isArray(raw)
          ? asString(raw['version'], `${what} ${field} ${name} version`)
          : asString(raw, `${what} ${field} ${name}`);
      const key = dependencyKey(name, value);
      if (key !== undefined) out.push(key);
    }
  }
  return out;
}

const PROD_FIELDS = ['dependencies', 'optionalDependencies'];
const DEV_FIELDS = ['devDependencies'];
const SNAPSHOT_FIELDS = ['dependencies', 'optionalDependencies'];
// Fields of pnpm's own install document, which precedes the project document.
const PACKAGE_MANAGER_FIELDS = new Set(['configDependencies', 'packageManagerDependencies']);

// pnpm writes its own install (the pinned pnpm version and its platform
// binaries) as a separate document before the project lockfile. Its importers
// only carry package manager fields.
function isPackageManagerDocument(doc: YamlMap): boolean {
  const importers = Object.values(asMap(doc['importers'], 'importers'));
  return (
    importers.length > 0 &&
    importers.every((importer) => {
      const fields = Object.keys(asMap(importer, 'importer'));
      return fields.length > 0 && fields.every((field) => PACKAGE_MANAGER_FIELDS.has(field));
    })
  );
}

export function parseLockfile(text: string): Lockfile {
  const docs = parseYamlDocuments(text);
  const projects = docs.filter((doc) => !isPackageManagerDocument(doc));
  if (projects.length !== 1) {
    throw new LockfileError(`expected one project document, found ${String(projects.length)}`);
  }
  const doc = projects[0] ?? {};
  if (doc['lockfileVersion'] !== '9.0') {
    throw new LockfileError(
      `unsupported lockfileVersion ${typeof doc['lockfileVersion'] === 'string' ? `"${doc['lockfileVersion']}"` : 'missing'}, expected "9.0"`,
    );
  }
  const importers = asMap(doc['importers'], 'importers');
  const packages = asMap(doc['packages'], 'packages');
  const snapshots = asMap(doc['snapshots'], 'snapshots');

  // Snapshot keys carry peer suffixes; package keys do not.
  const children = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(snapshots)) {
    children.set(key, edges(asMap(entry, `snapshot ${key}`), SNAPSHOT_FIELDS, `snapshot ${key}`));
  }

  const scopeOf = new Map<string, 'prod' | 'dev'>();
  const walk = (roots: string[], scope: 'prod' | 'dev'): void => {
    const queue = [...roots];
    const seen = new Set<string>();
    for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
      if (seen.has(key)) continue;
      seen.add(key);
      const { name, version } = splitPackageKey(key);
      const packageKey = `${name}@${version}`;
      if (!scopeOf.has(packageKey)) scopeOf.set(packageKey, scope);
      const next = children.get(key);
      if (next === undefined) throw new LockfileError(`dependency "${key}" has no snapshot`);
      queue.push(...next);
    }
  };
  const importerEntries = Object.entries(importers).map(
    ([path, entry]) => [path, asMap(entry, `importer ${path}`)] as const,
  );
  walk(
    importerEntries.flatMap(([path, entry]) => edges(entry, PROD_FIELDS, `importer ${path}`)),
    'prod',
  );
  walk(
    importerEntries.flatMap(([path, entry]) => edges(entry, DEV_FIELDS, `importer ${path}`)),
    'dev',
  );

  const locked: LockedPackage[] = [];
  for (const [key, raw] of Object.entries(packages)) {
    const entry = asMap(raw, `package ${key}`);
    const { name, version } = splitPackageKey(key);
    const scope = scopeOf.get(`${name}@${version}`);
    if (scope === undefined)
      throw new LockfileError(`package "${key}" is not reachable from any importer`);
    // Tarball and git entries record the manifest version separately, and
    // that is the version `pnpm licenses list` reports for them.
    const listed = entry['version'];
    locked.push({
      name,
      version: typeof listed === 'string' && listed !== '' ? listed : version,
      platformSpecific: ['os', 'cpu', 'libc'].some((field) => entry[field] !== undefined),
      scope,
    });
  }
  for (const key of scopeOf.keys()) {
    if (!Object.hasOwn(packages, key))
      throw new LockfileError(`dependency "${key}" has no package entry`);
  }
  return { packages: locked, importers: Object.keys(importers) };
}
