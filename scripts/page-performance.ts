// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Reads the Lighthouse reports a run left behind and prints what it
// measured: every sample of every asserted metric, per route, with the
// median and the spread beside the bar it was judged against.
//
// It does not judge the numbers. Lighthouse CI does that, from the same
// config file this reads, and two of its bars are deliberately warnings
// rather than errors because the instrument's own spread on a CI runner is
// wider than the distance from a failing median to the bar. What this does
// gate is that the measurement happened: the routes the config names, the
// number of runs it asks for, and a value for every metric it asserts. A
// warning that nobody can fail is worth nothing if the data behind it can
// go missing without a word.
//
// The bars, the routes and the run count are read out of the config rather
// than repeated here, so this cannot report a bar the gate does not hold.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class PagePerformanceError extends Error {
  override name = 'PagePerformanceError';
}

// Lighthouse CI only reads report files whose names look like this, and
// ignores everything else in the folder without a word. Mirrored here so a
// misnamed report is an error rather than a sample that quietly vanishes.
const LHR_FILE = /^lhr-\d+\.json$/;

export type Severity = 'error' | 'warn' | 'off';
export type BarKind = 'minScore' | 'maxNumericValue';

export interface Bar {
  // `categories:performance` or an audit id such as `total-blocking-time`.
  readonly metric: string;
  readonly kind: BarKind;
  readonly value: number;
  readonly severity: Severity;
}

export interface GateConfig {
  readonly urls: readonly string[];
  readonly runs: number;
  readonly bars: readonly Bar[];
}

export interface MetricSamples {
  readonly bar: Bar;
  readonly values: readonly number[];
  readonly median: number;
  readonly spread: number;
  readonly inside: boolean;
}

export interface ObservedSamples {
  readonly audit: string;
  readonly unit: string;
  // Absent when the run did not collect this audit, which is printed rather
  // than skipped: these are the candidates for a bar that a runner cannot
  // move, and a candidate nobody can see the numbers for stays a candidate.
  readonly values: readonly number[] | undefined;
  readonly median: number | undefined;
  readonly spread: number | undefined;
}

export interface RouteReport {
  readonly url: string;
  readonly metrics: readonly MetricSamples[];
  readonly observed: readonly ObservedSamples[];
}

export interface Report {
  readonly config: GateConfig;
  readonly routes: readonly RouteReport[];
}

export interface SummaryOptions {
  // A run must cover every route the config collects, or a route could stop
  // being measured without anything noticing. The recorded sample set from
  // one route is read with this off, since one route is all it holds.
  readonly allowMissingRoutes?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PagePerformanceError(`${where} is not a number`);
  }
  return value;
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PagePerformanceError(`${where} is not valid JSON`);
  }
}

function parseSeverity(value: unknown, metric: string): Severity {
  if (value === 'error' || value === 'warn' || value === 'off') return value;
  throw new PagePerformanceError(
    `assertion ${metric} has level ${JSON.stringify(value)}, not error, warn or off`,
  );
}

function parseBar(metric: string, assertion: unknown): Bar | undefined {
  // `"off"` on its own turns an assertion off, and so does `["off", {...}]`.
  if (typeof assertion === 'string') {
    parseSeverity(assertion, metric);
    return undefined;
  }
  if (!Array.isArray(assertion) || assertion.length !== 2) {
    throw new PagePerformanceError(
      `assertion ${metric} must be a level or a level and its options`,
    );
  }
  const severity = parseSeverity(assertion[0], metric);
  const options: unknown = assertion[1];
  if (!isRecord(options)) {
    throw new PagePerformanceError(`assertion ${metric} has no options object`);
  }
  if (severity === 'off') return undefined;
  const hasMinScore = 'minScore' in options;
  const hasMaxNumeric = 'maxNumericValue' in options;
  if (hasMinScore === hasMaxNumeric) {
    throw new PagePerformanceError(
      `assertion ${metric} must set exactly one of minScore and maxNumericValue`,
    );
  }
  const kind: BarKind = hasMinScore ? 'minScore' : 'maxNumericValue';
  return {
    metric,
    kind,
    value: readNumber(options[kind], `assertion ${metric} ${kind}`),
    severity,
  };
}

// The routes, the run count and the bars, taken from the file Lighthouse CI
// itself reads.
export function parseGateConfig(text: string, where: string): GateConfig {
  const parsed = parseJson(text, where);
  const ci = isRecord(parsed) ? parsed['ci'] : undefined;
  const collect = isRecord(ci) ? ci['collect'] : undefined;
  const assert = isRecord(ci) ? ci['assert'] : undefined;
  if (!isRecord(collect) || !isRecord(assert)) {
    throw new PagePerformanceError(`${where} has no ci.collect and ci.assert`);
  }
  const urls = collect['url'];
  if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === 'string')) {
    throw new PagePerformanceError(`${where} names no routes to collect`);
  }
  const runs = readNumber(collect['numberOfRuns'], `${where} ci.collect.numberOfRuns`);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new PagePerformanceError(`${where} ci.collect.numberOfRuns must be a whole number`);
  }
  const assertions = assert['assertions'];
  if (!isRecord(assertions) || Object.keys(assertions).length === 0) {
    throw new PagePerformanceError(`${where} asserts nothing`);
  }
  const bars: Bar[] = [];
  for (const [metric, assertion] of Object.entries(assertions)) {
    const bar = parseBar(metric, assertion);
    if (bar !== undefined) bars.push(bar);
  }
  if (bars.length === 0) {
    throw new PagePerformanceError(`${where} has every assertion turned off`);
  }
  return { urls, runs, bars };
}

// Audits that describe the page rather than time it, which makes them the
// candidates to gate on in place of the two metrics that move on their own.
// Measured across three runs of one commit on a CI runner: dom-size was
// identical every time, and total-byte-weight moved by one to three bytes
// on every route, on totals of about 392 kB for the overview and about
// 388 kB for the other two, while the median blocking time of the same
// bytes moved by more than three times. So they are steady rather than exact, and a
// bar on either needs a tolerance rather than equality. They carry no bar
// yet, because two runs are a start and not a basis, and a bar set without
// measured spread is the guess this arrangement exists to remove. The
// report prints them so the values accumulate run by run.
export const OBSERVED_AUDITS: readonly { readonly audit: string; readonly unit: string }[] = [
  { audit: 'total-byte-weight', unit: 'bytes' },
  { audit: 'dom-size', unit: 'elements' },
];

// The audits that lose their only guard when the performance category is
// reported rather than failed. The category is a composite: five of its
// audits carry weight in the score and the rest carry zero, so only the
// weighted ones were ever being held by that bar. Two of the five are
// asserted in their own right, blocking time and layout shift, and both are
// named in the diff that demotes the category. These three are not, which
// is why they are named here and in the job output.
//
// Time to interactive is deliberately absent: the installed Lighthouse
// gives it weight zero in the hidden group, so the category score never
// reflected it and this bar never held it. Interaction to next paint is
// weight zero for the same reason. The list is derived from the installed
// package's own weights in the test beside this file rather than trusted
// here, because a list restated in code and in a document can be wrong in
// both places at once and the pair will still agree.
export const PERFORMANCE_CATEGORY_AUDITS: readonly string[] = [
  'largest-contentful-paint',
  'first-contentful-paint',
  'speed-index',
];

export interface LoadedSample {
  readonly file: string;
  readonly url: string;
  readonly values: ReadonlyMap<string, number>;
  readonly observed: ReadonlyMap<string, number>;
}

// One report. Only the metrics the config asserts are read, and a missing
// one is an error: a metric that stops being collected would otherwise turn
// a bar into an opinion about nothing.
export function parseSample(text: string, file: string, bars: readonly Bar[]): LoadedSample {
  const parsed = parseJson(text, file);
  if (!isRecord(parsed)) throw new PagePerformanceError(`${file} is not a Lighthouse report`);
  const url = parsed['requestedUrl'];
  if (typeof url !== 'string' || url === '') {
    throw new PagePerformanceError(`${file} has no requestedUrl`);
  }
  const categories = parsed['categories'];
  const audits = parsed['audits'];
  const values = new Map<string, number>();
  for (const bar of bars) {
    const category = bar.metric.startsWith('categories:')
      ? bar.metric.slice('categories:'.length)
      : undefined;
    const holder = category === undefined ? audits : categories;
    if (!isRecord(holder)) {
      throw new PagePerformanceError(
        `${file} has no ${category === undefined ? 'audits' : 'categories'} for ${bar.metric}`,
      );
    }
    const entry = holder[category ?? bar.metric];
    if (!isRecord(entry)) {
      throw new PagePerformanceError(`${file} did not measure ${bar.metric}`);
    }
    const field = bar.kind === 'minScore' ? 'score' : 'numericValue';
    values.set(bar.metric, readNumber(entry[field], `${file} ${bar.metric} ${field}`));
  }
  const observed = new Map<string, number>();
  for (const { audit } of OBSERVED_AUDITS) {
    const entry = isRecord(audits) ? audits[audit] : undefined;
    if (!isRecord(entry)) continue;
    const value = entry['numericValue'];
    if (typeof value === 'number' && Number.isFinite(value)) observed.set(audit, value);
  }
  return { file, url, values, observed };
}

export function loadSamples(directory: string, bars: readonly Bar[]): readonly LoadedSample[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new PagePerformanceError(`${directory} does not exist; run the page measurement first`);
  }
  const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  const reports = names.filter((name) => LHR_FILE.test(name));
  // The three files the measurement writes beside its reports. Anything else
  // that is not a report is an error rather than something to skip.
  const bookkeeping = new Set(['manifest.json', 'assertion-results.json', 'links.json']);
  const ignored = names.filter((name) => !LHR_FILE.test(name) && !bookkeeping.has(name));
  if (ignored.length > 0) {
    throw new PagePerformanceError(
      `${directory} holds ${ignored.sort().join(', ')}, which the page measurement reads as nothing: reports must be named lhr-<number>.json`,
    );
  }
  if (reports.length === 0) {
    throw new PagePerformanceError(`${directory} holds no lhr-<number>.json report`);
  }
  return reports
    .sort()
    .map((name) => parseSample(readFileSync(join(directory, name), 'utf8'), name, bars));
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (high === undefined) throw new PagePerformanceError('no values to take a median of');
  if (sorted.length % 2 === 1 || low === undefined) return high;
  return (low + high) / 2;
}

function inside(bar: Bar, value: number): boolean {
  return bar.kind === 'minScore' ? value >= bar.value : value <= bar.value;
}

export function summarise(
  config: GateConfig,
  samples: readonly LoadedSample[],
  options: SummaryOptions = {},
): readonly RouteReport[] {
  const byUrl = new Map<string, LoadedSample[]>();
  for (const sample of samples) {
    const existing = byUrl.get(sample.url);
    if (existing === undefined) byUrl.set(sample.url, [sample]);
    else existing.push(sample);
  }
  const unexpected = [...byUrl.keys()].filter((url) => !config.urls.includes(url));
  if (unexpected.length > 0) {
    throw new PagePerformanceError(
      `reports name ${unexpected.sort().join(', ')}, which the config does not collect`,
    );
  }
  const measured = config.urls.filter(
    (url) => options.allowMissingRoutes !== true || byUrl.has(url),
  );
  if (measured.length === 0) {
    throw new PagePerformanceError('no report names a route the config collects');
  }
  return measured.map((url) => {
    const forUrl = byUrl.get(url) ?? [];
    if (forUrl.length !== config.runs) {
      throw new PagePerformanceError(
        `${url} has ${String(forUrl.length)} report${forUrl.length === 1 ? '' : 's'}, not the ${String(config.runs)} the config collects`,
      );
    }
    const metrics = config.bars.map((bar) => {
      const values = forUrl.map((sample) => {
        const value = sample.values.get(bar.metric);
        if (value === undefined) {
          throw new PagePerformanceError(`${sample.file} did not measure ${bar.metric}`);
        }
        return value;
      });
      const middle = median(values);
      return {
        bar,
        values,
        median: middle,
        spread: Math.max(...values) - Math.min(...values),
        inside: inside(bar, middle),
      };
    });
    const observed = OBSERVED_AUDITS.map(({ audit, unit }) => {
      const values = forUrl
        .map((sample) => sample.observed.get(audit))
        .filter((value): value is number => value !== undefined);
      if (values.length !== forUrl.length) {
        return { audit, unit, values: undefined, median: undefined, spread: undefined };
      }
      return {
        audit,
        unit,
        values,
        median: median(values),
        spread: Math.max(...values) - Math.min(...values),
      };
    });
    return { url, metrics, observed };
  });
}

function round(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(3).replace(/0+$/, '');
}

export function formatReport(report: Report): string {
  const lines = [
    `Page measurement: ${String(report.config.runs)} runs per route, median judged against each bar`,
  ];
  for (const route of report.routes) {
    lines.push('', route.url);
    for (const metric of route.metrics) {
      const { bar } = metric;
      const comparison = bar.kind === 'minScore' ? '>=' : '<=';
      const verdict = metric.inside
        ? 'inside the bar'
        : bar.severity === 'error'
          ? 'outside the bar, and this one fails the build'
          : 'outside the bar, reported only';
      lines.push(
        `  ${bar.metric}`,
        `    samples ${metric.values.map(round).join(', ')}`,
        `    median ${round(metric.median)}, spread ${round(metric.spread)}, bar ${comparison} ${round(bar.value)} (${bar.severity})`,
        `    ${verdict}`,
      );
      if (bar.metric === 'categories:performance' && bar.severity !== 'error') {
        lines.push(
          `    reported with it, and asserted nowhere else: ${PERFORMANCE_CATEGORY_AUDITS.join(', ')}`,
        );
      }
    }
    for (const entry of route.observed) {
      lines.push(`  ${entry.audit}`);
      if (entry.values === undefined || entry.median === undefined || entry.spread === undefined) {
        lines.push('    not collected in these runs, so it carries no reading yet');
        continue;
      }
      lines.push(
        `    samples ${entry.values.map(round).join(', ')} ${entry.unit}`,
        `    median ${round(entry.median)}, spread ${round(entry.spread)}, no bar`,
      );
    }
  }
  const reported = report.config.bars.filter((bar) => bar.severity === 'warn');
  if (reported.length > 0) {
    lines.push(
      '',
      `Reported, not gated: ${reported.map((bar) => bar.metric).join(', ')}. These vary between runs on identical bytes by more than the margin a bar would give them, so a failure would carry no information. The route bundle budget is the gate on page weight.`,
    );
  }
  lines.push('', 'Every route was measured the number of times the config asks for.');
  return `${lines.join('\n')}\n`;
}

export function buildReport(
  configText: string,
  configPath: string,
  directory: string,
  options: SummaryOptions = {},
): Report {
  const config = parseGateConfig(configText, configPath);
  return { config, routes: summarise(config, loadSamples(directory, config.bars), options) };
}
