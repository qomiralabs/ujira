// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turns the raw `pnpm licenses list` output, the lockfile and the installed
// manifests into one checked list of packages. Every step fails closed: a
// listing that is empty, malformed, out of line with the installed manifests
// or with pnpm-lock.yaml is reported as a problem, never treated as clean.
// File access goes through the injected inspector so this stays testable.

import type { Lockfile } from './lockfile.ts';
import {
  findViolations,
  normalizeRepository,
  renderNotices,
  sanitizeUrl,
  type AssetNotice,
  type NoticeEntry,
  type Scope,
  type ScopedLicense,
  type Violation,
} from './license-policy.ts';

export class ListingError extends Error {}

export interface PnpmLicenseEntry {
  name: string;
  versions: string[];
  paths: string[];
  license: string | undefined;
  homepage: string | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function optionalString(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ListingError(`${what} is not a string`);
  return value;
}

// Parses `pnpm licenses list --json` output and validates its shape strictly.
// pnpm groups entries under the license it read; an entry level `license`
// field, when present, takes precedence over the group key.
export function parsePnpmListing(stdout: string, scope: Scope): PnpmLicenseEntry[] {
  const label = `pnpm licenses list --${scope}`;
  if (stdout.trim() === '') throw new ListingError(`${label} printed nothing`);
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new ListingError(`${label} did not print valid JSON`);
  }
  if (!isPlainObject(json)) throw new ListingError(`${label} did not print a JSON object`);
  const entries: PnpmLicenseEntry[] = [];
  for (const [group, list] of Object.entries(json)) {
    if (!Array.isArray(list)) throw new ListingError(`${label}: group "${group}" is not an array`);
    list.forEach((raw: unknown, index) => {
      const where = `${label}: group "${group}" entry ${String(index)}`;
      if (!isPlainObject(raw)) throw new ListingError(`${where} is not an object`);
      const { name, versions, paths } = raw;
      if (typeof name !== 'string' || name === '') throw new ListingError(`${where} has no name`);
      if (!isStringArray(versions) || !isStringArray(paths)) {
        throw new ListingError(`${where} (${name}) needs string arrays "versions" and "paths"`);
      }
      const license = optionalString(raw['license'], `${where} (${name}) license`);
      entries.push({
        name,
        versions,
        paths,
        license: license ?? group,
        homepage: optionalString(raw['homepage'], `${where} (${name}) homepage`),
      });
    });
  }
  return entries;
}

export type Manifest = Record<string, unknown>;

export interface ManifestInspector {
  realpath(path: string): string | undefined;
  // Parsed package.json in `dir`, or undefined when there is none.
  manifest(dir: string): Manifest | undefined;
}

export interface WorkspaceProject {
  // Real path of the project folder.
  dir: string;
  name: string;
  version: string;
  manifest: Manifest;
}

export interface InstalledPackage {
  name: string;
  version: string;
  license: string;
  path: string;
  homepage: string | undefined;
  repository: unknown;
}

// A registry version, as opposed to a `file:`, `link:` or git specifier.
const REGISTRY_VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/;

// Resolves each listed version to the package folder that holds it and reads
// that folder's package.json, so a version is never trusted on its position
// in the list alone. Our own workspace projects are skipped only when the path
// is exactly one of their folders and the manifest there has the same name and
// version.
export function resolveListing(
  entries: readonly PnpmLicenseEntry[],
  workspaces: readonly WorkspaceProject[],
  inspector: ManifestInspector,
): { packages: InstalledPackage[]; problems: string[] } {
  const packages: InstalledPackage[] = [];
  const problems: string[] = [];
  const byDir = new Map(workspaces.map((project) => [project.dir, project]));
  for (const entry of entries) {
    const label = entry.name;
    if (entry.versions.length === 0 || entry.versions.length !== entry.paths.length) {
      problems.push(
        `${label}: pnpm listed ${String(entry.versions.length)} version(s) and ${String(entry.paths.length)} path(s); cannot tell which path holds which version`,
      );
      continue;
    }
    entry.versions.forEach((version, i) => {
      const path = entry.paths[i] ?? '';
      const where = `${label}@${version}`;
      const real = path === '' ? undefined : inspector.realpath(path);
      if (real === undefined) {
        problems.push(`${where}: listed path "${path}" does not exist`);
        return;
      }
      const manifest = inspector.manifest(real);
      if (manifest === undefined) {
        problems.push(`${where}: no package.json at "${real}"`);
        return;
      }
      if (manifest['name'] !== entry.name) {
        problems.push(`${where}: package.json at "${real}" is named "${String(manifest['name'])}"`);
        return;
      }
      const project = byDir.get(real);
      if (
        project?.name === entry.name &&
        manifest['version'] === project.version &&
        (version === project.version || version.startsWith('link:'))
      ) {
        return;
      }
      if (REGISTRY_VERSION.test(version) && manifest['version'] !== version) {
        problems.push(
          `${where}: package.json at "${real}" has version "${String(manifest['version'])}"`,
        );
        return;
      }
      packages.push({
        name: entry.name,
        version,
        license: (entry.license ?? '').trim(),
        path: real,
        homepage: entry.homepage,
        repository: manifest['repository'],
      });
    });
  }
  return { packages, problems };
}

// Reviewed licenses for platform specific packages, which pnpm lists only on
// the platform that installs them.
export interface PlatformLicense {
  name: string;
  // An exact version, "*", or a version with trailing "x" parts such as "1.x".
  versions: string;
  license: string;
  source: string;
}

const RANGE = /^(?:\*|\d+\.(?:x|\d+\.(?:x|\d+(?:-[\w.]+)?))|\d+\.x\.x|\d+\.x)$/;

export function versionMatches(range: string, version: string): boolean {
  if (range === '*') return true;
  if (!range.includes('x')) return range === version;
  if (/[-+]/.test(version)) return false;
  const want = range.split('.');
  const have = version.split('.');
  return want.every((part, i) => part === 'x' || part === have[i]);
}

export function parsePlatformMap(text: string): PlatformLicense[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ListingError('scripts/platform-licenses.json is not valid JSON');
  }
  if (!isPlainObject(json) || !Array.isArray(json['packages'])) {
    throw new ListingError('scripts/platform-licenses.json needs a "packages" array');
  }
  const allowedKeys = new Set(['$comment', 'packages']);
  for (const key of Object.keys(json)) {
    if (!allowedKeys.has(key))
      throw new ListingError(`scripts/platform-licenses.json: unknown key "${key}"`);
  }
  return json['packages'].map((raw: unknown, index) => {
    const where = `scripts/platform-licenses.json packages[${String(index)}]`;
    if (!isPlainObject(raw)) throw new ListingError(`${where} is not an object`);
    const keys = Object.keys(raw).sort().join(',');
    if (keys !== 'license,name,source,versions') {
      throw new ListingError(`${where} must have exactly name, versions, license and source`);
    }
    const { name, versions, license, source } = raw;
    if (typeof name !== 'string' || name === '') throw new ListingError(`${where}: invalid name`);
    if (typeof versions !== 'string' || !RANGE.test(versions)) {
      throw new ListingError(`${where} (${name}): unsupported version range "${String(versions)}"`);
    }
    if (typeof license !== 'string' || license.trim() === '') {
      throw new ListingError(`${where} (${name}): invalid license`);
    }
    if (typeof source !== 'string' || !/^https:\/\/[^\s@]+$/.test(source)) {
      throw new ListingError(`${where} (${name}): source must be an https URL without credentials`);
    }
    return { name, versions, license, source };
  });
}

const THIRD_PARTY_SPEC = (spec: unknown): boolean =>
  typeof spec === 'string' && !spec.startsWith('workspace:') && !spec.startsWith('link:');

// True when the manifest declares a third party dependency that pnpm should
// list on every platform. Names the lockfile only knows as platform specific
// builds are left out, since they may not be installed here.
function declares(
  manifest: Manifest,
  fields: readonly string[],
  platformOnly: ReadonlySet<string>,
): boolean {
  return fields.some((field) => {
    const deps = manifest[field];
    return (
      isPlainObject(deps) &&
      Object.entries(deps).some(([name, spec]) => THIRD_PARTY_SPEC(spec) && !platformOnly.has(name))
    );
  });
}

export interface TreeInputs {
  prodListing: string;
  devListing: string;
  lockfile: Lockfile;
  workspaces: readonly WorkspaceProject[];
  platformMap: readonly PlatformLicense[];
  inspector: ManifestInspector;
  // Non-npm assets already checked against assets.licenses.json.
  assets?: readonly AssetNotice[];
}

export interface TreeResult {
  problems: string[];
  violations: Violation[];
  checked: number;
  notices: string | undefined;
}

interface Listed {
  pkg: InstalledPackage;
  scope: Scope;
}

export function checkTree(inputs: TreeInputs): TreeResult {
  const problems: string[] = [];
  const listed = new Map<string, Listed>();
  const everywhere = new Set(
    inputs.lockfile.packages.filter((p) => !p.platformSpecific).map((p) => p.name),
  );
  const platformOnly = new Set(
    inputs.lockfile.packages
      .filter((p) => p.platformSpecific && !everywhere.has(p.name))
      .map((p) => p.name),
  );
  const scopes: [Scope, string, readonly string[]][] = [
    ['prod', inputs.prodListing, ['dependencies', 'optionalDependencies']],
    ['dev', inputs.devListing, ['devDependencies']],
  ];
  for (const [scope, stdout, fields] of scopes) {
    let entries: PnpmLicenseEntry[];
    try {
      entries = parsePnpmListing(stdout, scope);
    } catch (error) {
      if (!(error instanceof ListingError)) throw error;
      problems.push(error.message);
      continue;
    }
    const declaring = inputs.workspaces.filter((project) =>
      declares(project.manifest, fields, platformOnly),
    );
    if (entries.length === 0 && declaring.length > 0) {
      problems.push(
        `pnpm licenses list --${scope} is empty, but ${declaring.map((p) => p.name).join(', ')} declare ${fields.join(' or ')}`,
      );
    }
    const resolved = resolveListing(entries, inputs.workspaces, inputs.inspector);
    problems.push(...resolved.problems);
    for (const pkg of resolved.packages) {
      const key = `${pkg.name}@${pkg.version}`;
      const seen = listed.get(key);
      if (seen === undefined || scope === 'prod') listed.set(key, { pkg, scope });
    }
  }

  const locked = new Map(
    inputs.lockfile.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]),
  );
  const toCheck: ScopedLicense[] = [];
  const notices: Record<'prod' | 'dev' | 'platformProd' | 'platformDev', NoticeEntry[]> = {
    prod: [],
    dev: [],
    platformProd: [],
    platformDev: [],
  };

  for (const lock of inputs.lockfile.packages) {
    if (!lock.platformSpecific && !listed.has(`${lock.name}@${lock.version}`)) {
      problems.push(
        `${lock.name}@${lock.version}: in pnpm-lock.yaml but missing from pnpm licenses list`,
      );
    }
  }

  const usedMapEntries = new Set<PlatformLicense>();
  for (const lock of inputs.lockfile.packages) {
    if (!lock.platformSpecific) continue;
    const key = `${lock.name}@${lock.version}`;
    const matches = inputs.platformMap.filter(
      (entry) => entry.name === lock.name && versionMatches(entry.versions, lock.version),
    );
    const match = matches[0];
    if (match === undefined || matches.length > 1) {
      problems.push(
        matches.length > 1
          ? `${key}: matches more than one entry in scripts/platform-licenses.json`
          : `${key}: platform specific package missing from scripts/platform-licenses.json; review its license and add it`,
      );
      continue;
    }
    usedMapEntries.add(match);
    const installed = listed.get(key);
    if (installed !== undefined && installed.pkg.license !== match.license) {
      problems.push(
        `${key}: installed license "${installed.pkg.license}" differs from scripts/platform-licenses.json "${match.license}"`,
      );
    }
    const scope: Scope = lock.scope === 'prod' || installed?.scope === 'prod' ? 'prod' : 'dev';
    toCheck.push({ name: lock.name, version: lock.version, license: match.license, scope });
    (scope === 'prod' ? notices.platformProd : notices.platformDev).push({
      name: lock.name,
      version: lock.version,
      license: match.license,
      repository: match.source,
    });
  }
  for (const entry of inputs.platformMap) {
    if (!usedMapEntries.has(entry)) {
      problems.push(
        `scripts/platform-licenses.json: ${entry.name}@${entry.versions} matches nothing in pnpm-lock.yaml; remove it`,
      );
    }
  }

  for (const [key, { pkg, scope: listedScope }] of listed) {
    const lock = locked.get(key);
    // Still checked, so the report names its license as well.
    if (lock === undefined) problems.push(`${key}: listed by pnpm but not in pnpm-lock.yaml`);
    if (lock?.platformSpecific === true) continue;
    const scope: Scope = listedScope === 'prod' || lock?.scope === 'prod' ? 'prod' : 'dev';
    toCheck.push({ name: pkg.name, version: pkg.version, license: pkg.license, scope });
    (scope === 'prod' ? notices.prod : notices.dev).push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      repository: normalizeRepository(pkg.repository) ?? sanitizeUrl(pkg.homepage),
    });
  }

  const violations = findViolations(toCheck);
  return {
    problems: [...new Set(problems)].sort(),
    violations,
    checked: toCheck.length,
    notices:
      problems.length === 0 && violations.length === 0
        ? renderNotices({ ...notices, assets: inputs.assets ?? [] })
        : undefined,
  };
}
