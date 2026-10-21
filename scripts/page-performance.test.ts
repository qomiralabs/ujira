// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// The recorded samples under fixtures/page-performance/recorded-samples are
// the three runs one Dashboard job produced for /payouts from identical
// bytes: performance 0.79, 0.75 and 0.91, with total blocking time 512.5,
// 651.2 and 136.5 milliseconds. Those six numbers are the measurement; the
// rest of each file is the least a Lighthouse report needs for the other
// assertions to be evaluated at all, set to passing values so the replay
// isolates the two metrics under test.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildReport,
  formatReport,
  loadSamples,
  median,
  PagePerformanceError,
  parseGateConfig,
  parseSample,
  summarise,
  type Bar,
} from './page-performance.ts';

const ROOT = join(import.meta.dirname, '..');
const CONFIG_PATH = join(ROOT, 'apps', 'dashboard', 'lighthouserc.json');
const RECORDED = join(import.meta.dirname, 'fixtures', 'page-performance', 'recorded-samples');
const CONFIG_TEXT = readFileSync(CONFIG_PATH, 'utf8');

// The version of Lighthouse the pinned toolchain actually installs, read
// through the packages that depend on it rather than written down twice.
function installedLighthouseVersion(): string {
  const fromDashboard = createRequire(join(ROOT, 'apps', 'dashboard', 'package.json'));
  const fromCli = createRequire(fromDashboard.resolve('@lhci/cli/package.json'));
  const manifest: unknown = JSON.parse(
    readFileSync(fromCli.resolve('lighthouse/package.json'), 'utf8'),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error('the installed lighthouse package has no version');
  }
  return manifest.version;
}

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ujira-page-performance-'));
  temporary.push(directory);
  return directory;
}

// The recorded samples, with one value changed, so a case can say exactly
// what it varies from the real measurement.
function recordedWith(change: (lhr: Record<string, unknown>, index: number) => void): string {
  const directory = scratch();
  for (const index of [1, 2, 3]) {
    const file = `lhr-${String(index)}.json`;
    const lhr: unknown = JSON.parse(readFileSync(join(RECORDED, file), 'utf8'));
    if (typeof lhr !== 'object' || lhr === null) throw new Error('fixture is not an object');
    change(lhr as Record<string, unknown>, index);
    writeFileSync(join(directory, file), JSON.stringify(lhr));
  }
  return directory;
}

const PERFORMANCE_BAR: Bar = {
  metric: 'categories:performance',
  kind: 'minScore',
  value: 0.9,
  severity: 'warn',
};

describe('the committed page gate config', () => {
  const config = parseGateConfig(CONFIG_TEXT, 'lighthouserc.json');

  it('collects three runs of three routes', () => {
    expect(config.runs).toBe(3);
    expect(config.urls).toEqual([
      'http://localhost:3300/',
      'http://localhost:3300/payouts',
      'http://localhost:3300/approvals',
    ]);
  });

  // The decision this file records: the two metrics whose within job spread
  // was measured wider than their own margin report rather than fail, and
  // everything else still fails the build.
  it('reports the two noisy metrics and gates the rest', () => {
    const severities = Object.fromEntries(config.bars.map((bar) => [bar.metric, bar.severity]));
    expect(severities).toEqual({
      'categories:performance': 'warn',
      'total-blocking-time': 'warn',
      'categories:accessibility': 'error',
      'categories:best-practices': 'error',
      'cumulative-layout-shift': 'error',
    });
  });

  it('keeps the bars themselves where they were', () => {
    const bars = Object.fromEntries(config.bars.map((bar) => [bar.metric, bar.value]));
    expect(bars).toEqual({
      'categories:performance': 0.9,
      'total-blocking-time': 200,
      'categories:accessibility': 0.95,
      'categories:best-practices': 0.95,
      'cumulative-layout-shift': 0.05,
    });
  });
});

// Nothing in the replay reads the version field, which is the reason to
// pin it: a shape change fails loudly by design, while a version move
// would leave these files working and no longer representative, and that
// is the drift that does not announce itself. Tying the field to the
// installed package means a bump has to be noticed, and whoever makes it
// has to decide whether the recorded spread still describes the runner.
describe('the recorded samples name the version that produced them', () => {
  const installed = installedLighthouseVersion();

  it.each(['lhr-1.json', 'lhr-2.json', 'lhr-3.json'])(
    'matches the installed Lighthouse in %s',
    (file) => {
      const lhr: unknown = JSON.parse(readFileSync(join(RECORDED, file), 'utf8'));
      const version =
        typeof lhr === 'object' && lhr !== null && 'lighthouseVersion' in lhr
          ? lhr.lighthouseVersion
          : undefined;
      expect(version).toBe(installed);
    },
  );

  it('carries a note saying which of its fields are a measurement', () => {
    for (const file of ['lhr-1.json', 'lhr-2.json', 'lhr-3.json']) {
      const text = readFileSync(join(RECORDED, file), 'utf8');
      expect(text).toContain('_fixtureNote');
      expect(text).toContain('Fixture, not a real report');
    }
  });
});

describe('replaying the recorded samples', () => {
  // The recorded set covers the one route the samples were taken from, so
  // the route completeness rule is relaxed here and tested on its own below.
  const report = buildReport(CONFIG_TEXT, 'lighthouserc.json', RECORDED, {
    allowMissingRoutes: true,
  });
  const payouts = report.routes.find((route) => route.url.endsWith('/payouts'));
  const metric = (name: string) => payouts?.metrics.find((entry) => entry.bar.metric === name);

  it('reads all three samples of both noisy metrics', () => {
    expect(metric('categories:performance')?.values).toEqual([0.79, 0.75, 0.91]);
    expect(metric('total-blocking-time')?.values).toEqual([512.5, 651.2, 136.5]);
  });

  // The measurement that settles the question: the spread between samples
  // taken from identical bytes is wider than the distance from the failing
  // median to the bar, 0.11, so a failure carried no information.
  it('shows a spread wider than the margin the bar allows', () => {
    const performance = metric('categories:performance');
    expect(performance?.median).toBe(0.79);
    expect(performance?.spread).toBeCloseTo(0.16, 10);
    expect(performance?.spread).toBeGreaterThan(0.9 - 0.79);
    const blocking = metric('total-blocking-time');
    expect(blocking?.median).toBe(512.5);
    expect(blocking?.spread).toBeCloseTo(514.7, 10);
  });

  it('calls both of them outside the bar, and neither of them a failure', () => {
    expect(metric('categories:performance')?.inside).toBe(false);
    expect(metric('total-blocking-time')?.inside).toBe(false);
    for (const name of ['categories:performance', 'total-blocking-time']) {
      expect(metric(name)?.bar.severity).toBe('warn');
    }
  });

  it('prints every sample, not only the median and a verdict', () => {
    const text = formatReport(report);
    expect(text).toContain('samples 0.79, 0.75, 0.91');
    expect(text).toContain('samples 512.5, 651.2, 136.5');
    expect(text).toContain('median 0.79, spread 0.16, bar >= 0.9 (warn)');
    expect(text).toContain('median 512.5, spread 514.7, bar <= 200 (warn)');
    expect(text).toContain('outside the bar, reported only');
    expect(text).not.toContain('fails the build');
  });

  it('reports the gated metrics of the same route beside the noisy ones', () => {
    const text = formatReport(report);
    expect(text).toContain('http://localhost:3300/payouts');
    expect(text).toContain('cumulative-layout-shift');
    expect(text).toContain('bar <= 0.05 (error)');
    expect(text).toContain('bar >= 0.95 (error)');
  });
});

describe('the deterministic candidates for a bar', () => {
  it('says so when a run did not collect them, rather than leaving a blank', () => {
    const report = buildReport(CONFIG_TEXT, 'lighthouserc.json', RECORDED, {
      allowMissingRoutes: true,
    });
    const text = formatReport(report);
    expect(text).toContain('total-byte-weight');
    expect(text).toContain('dom-size');
    expect(text).toContain('not collected in these runs, so it carries no reading yet');
  });

  it('prints their samples and spread when a run did collect them', () => {
    const weights = [412_345, 412_345, 412_345];
    const elements = [640, 640, 641];
    const directory = recordedWith((lhr, index) => {
      const audits = lhr['audits'] as Record<string, { numericValue: number }>;
      audits['total-byte-weight'] = { numericValue: weights[index - 1] ?? 0 };
      audits['dom-size'] = { numericValue: elements[index - 1] ?? 0 };
    });
    const text = formatReport(
      buildReport(CONFIG_TEXT, 'lighthouserc.json', directory, { allowMissingRoutes: true }),
    );
    expect(text).toContain('samples 412345, 412345, 412345 bytes');
    expect(text).toContain('median 412345, spread 0, no bar');
    expect(text).toContain('samples 640, 640, 641 elements');
    expect(text).toContain('median 640, spread 1, no bar');
  });

  // They are reported, so a value that cannot be read must not become a
  // reading of zero, and must not fail a run either: they carry no bar.
  it('treats a value it cannot read as not collected', () => {
    const directory = recordedWith((lhr) => {
      const audits = lhr['audits'] as Record<string, { numericValue: unknown }>;
      audits['dom-size'] = { numericValue: 'about 600' };
    });
    const text = formatReport(
      buildReport(CONFIG_TEXT, 'lighthouserc.json', directory, { allowMissingRoutes: true }),
    );
    expect(text).toContain('not collected in these runs, so it carries no reading yet');
  });
});

describe('a regression the arrangement still fails', () => {
  it('fails an accessibility drop, which is not a timing measurement', () => {
    const directory = recordedWith((lhr) => {
      const categories = lhr['categories'] as Record<string, { score: number }>;
      categories['accessibility'] = { score: 0.8 };
    });
    const report = buildReport(CONFIG_TEXT, 'lighthouserc.json', directory, {
      allowMissingRoutes: true,
    });
    const route = report.routes.find((entry) => entry.url.endsWith('/payouts'));
    const accessibility = route?.metrics.find(
      (entry) => entry.bar.metric === 'categories:accessibility',
    );
    expect(accessibility?.inside).toBe(false);
    expect(accessibility?.bar.severity).toBe('error');
    expect(formatReport(report)).toContain('outside the bar, and this one fails the build');
  });

  // What the chosen option stops catching, stated as a test so the gap is
  // recorded where someone changing this will see it.
  it('does not fail a page that got slower without getting bigger', () => {
    const directory = recordedWith((lhr) => {
      const categories = lhr['categories'] as Record<string, { score: number }>;
      categories['performance'] = { score: 0.2 };
      const audits = lhr['audits'] as Record<string, { numericValue: number }>;
      audits['total-blocking-time'] = { numericValue: 4000 };
    });
    const report = buildReport(CONFIG_TEXT, 'lighthouserc.json', directory, {
      allowMissingRoutes: true,
    });
    const route = report.routes.find((entry) => entry.url.endsWith('/payouts'));
    expect(
      route?.metrics.find((entry) => entry.bar.metric === 'categories:performance')?.inside,
    ).toBe(false);
    expect(formatReport(report)).toContain('samples 4000, 4000, 4000');
    expect(formatReport(report)).not.toContain('fails the build');
  });
});

describe('the measurement itself is what this gates', () => {
  it('fails when the report folder is missing', () => {
    expect(() => loadSamples(join(scratch(), 'nowhere'), [PERFORMANCE_BAR])).toThrow(
      /does not exist; run the page measurement first/,
    );
  });

  it('fails when the folder holds no report', () => {
    expect(() => loadSamples(scratch(), [PERFORMANCE_BAR])).toThrow(
      /holds no lhr-<number>\.json report/,
    );
  });

  // Lighthouse CI ignores a report whose name does not match its pattern,
  // without a word, so three samples can become two in silence.
  it('fails on a report the page measurement would ignore', () => {
    const directory = scratch();
    writeFileSync(join(directory, 'lhr-first.json'), '{}');
    expect(() => loadSamples(directory, [PERFORMANCE_BAR])).toThrow(
      /lhr-first\.json, which the page measurement reads as nothing/,
    );
  });

  it('allows the bookkeeping files the page measurement writes beside them', () => {
    const directory = recordedWith(() => undefined);
    writeFileSync(join(directory, 'manifest.json'), '[]');
    writeFileSync(join(directory, 'assertion-results.json'), '[]');
    writeFileSync(join(directory, 'links.json'), '{}');
    expect(loadSamples(directory, [PERFORMANCE_BAR])).toHaveLength(3);
  });

  it('fails when a route was measured fewer times than the config asks', () => {
    const directory = scratch();
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'lhr-1.json'), readFileSync(join(RECORDED, 'lhr-1.json')));
    expect(() =>
      buildReport(CONFIG_TEXT, 'lighthouserc.json', directory, { allowMissingRoutes: true }),
    ).toThrow(/has 1 report, not the 3 the config collects/);
  });

  it('fails when a route the config collects produced no report at all', () => {
    // The default: three routes are collected and the recorded set covers
    // one, so a run that lost two routes cannot pass as a measurement.
    expect(() => buildReport(CONFIG_TEXT, 'lighthouserc.json', RECORDED)).toThrow(
      /http:\/\/localhost:3300\/ has 0 reports, not the 3 the config collects/,
    );
  });

  it('fails when a report names a route the config does not collect', () => {
    const directory = recordedWith((lhr, index) => {
      if (index === 2) lhr['requestedUrl'] = 'http://localhost:3300/elsewhere';
    });
    expect(() =>
      buildReport(CONFIG_TEXT, 'lighthouserc.json', directory, { allowMissingRoutes: true }),
    ).toThrow(/reports name http:\/\/localhost:3300\/elsewhere, which the config does not collect/);
  });

  it('fails when an asserted metric stopped being measured', () => {
    const directory = recordedWith((lhr) => {
      const audits = lhr['audits'] as Record<string, unknown>;
      delete audits['total-blocking-time'];
    });
    expect(() => buildReport(CONFIG_TEXT, 'lighthouserc.json', directory)).toThrow(
      /did not measure total-blocking-time/,
    );
  });

  it('fails when a measured value is not a number', () => {
    const directory = recordedWith((lhr) => {
      const audits = lhr['audits'] as Record<string, { numericValue: unknown }>;
      audits['total-blocking-time'] = { numericValue: null };
    });
    expect(() => buildReport(CONFIG_TEXT, 'lighthouserc.json', directory)).toThrow(
      /total-blocking-time numericValue is not a number/,
    );
  });

  it('fails on a report that is not valid JSON', () => {
    const directory = scratch();
    writeFileSync(join(directory, 'lhr-1.json'), '{');
    expect(() => loadSamples(directory, [PERFORMANCE_BAR])).toThrow(
      /lhr-1\.json is not valid JSON/,
    );
  });

  it('fails on a report with no audits at all', () => {
    const bar: Bar = {
      metric: 'total-blocking-time',
      kind: 'maxNumericValue',
      value: 200,
      severity: 'warn',
    };
    expect(() =>
      parseSample('{"requestedUrl":"http://localhost:3300/","categories":{}}', 'lhr-1.json', [bar]),
    ).toThrow(/lhr-1\.json has no audits for total-blocking-time/);
  });

  it('fails on a report with no requestedUrl', () => {
    expect(() => parseSample('{"categories":{}}', 'lhr-1.json', [])).toThrow(
      /lhr-1\.json has no requestedUrl/,
    );
  });
});

// These two guards cannot be reached through the files, because the loader
// refuses an empty folder and a report that is missing a metric. They are
// reached directly, because a guard nobody has ever seen fire is a guard
// nobody knows works: an empty sample set would otherwise summarise to no
// routes at all and print a clean report about nothing.
describe('the guards against an empty or inconsistent sample set', () => {
  const config = parseGateConfig(CONFIG_TEXT, 'lighthouserc.json');

  it('refuses a sample set with no reports in it', () => {
    expect(() => summarise(config, [], { allowMissingRoutes: true })).toThrow(
      /no report names a route the config collects/,
    );
  });

  it('refuses a report that carries no value for an asserted metric', () => {
    const sample = {
      file: 'lhr-1.json',
      url: 'http://localhost:3300/payouts',
      values: new Map<string, number>(),
      observed: new Map<string, number>(),
    };
    expect(() => summarise(config, [sample, sample, sample], { allowMissingRoutes: true })).toThrow(
      /lhr-1\.json did not measure categories:performance/,
    );
  });
});

describe('reading the config', () => {
  it('refuses a config that asserts nothing', () => {
    expect(() =>
      parseGateConfig('{"ci":{"collect":{"url":["u"],"numberOfRuns":3},"assert":{}}}', 'rc'),
    ).toThrow(/asserts nothing/);
  });

  it('refuses a config with every assertion turned off', () => {
    const text =
      '{"ci":{"collect":{"url":["u"],"numberOfRuns":3},"assert":{"assertions":{"x":"off"}}}}';
    expect(() => parseGateConfig(text, 'rc')).toThrow(/has every assertion turned off/);
  });

  it('refuses an assertion with no bar or with two', () => {
    const base = '{"ci":{"collect":{"url":["u"],"numberOfRuns":3},"assert":{"assertions":';
    expect(() => parseGateConfig(`${base}{"x":["error",{}]}}}}`, 'rc')).toThrow(
      /exactly one of minScore and maxNumericValue/,
    );
    expect(() =>
      parseGateConfig(`${base}{"x":["error",{"minScore":1,"maxNumericValue":2}]}}}}`, 'rc'),
    ).toThrow(/exactly one of minScore and maxNumericValue/);
  });

  it('refuses an assertion that is neither a level nor a level and options', () => {
    const base = '{"ci":{"collect":{"url":["u"],"numberOfRuns":3},"assert":{"assertions":';
    expect(() => parseGateConfig(`${base}{"x":3}}}}`, 'rc')).toThrow(
      /must be a level or a level and its options/,
    );
    expect(() => parseGateConfig(`${base}{"x":["error","minScore"]}}}}`, 'rc')).toThrow(
      /has no options object/,
    );
  });

  it('refuses an unknown level', () => {
    const text =
      '{"ci":{"collect":{"url":["u"],"numberOfRuns":3},"assert":{"assertions":{"x":["fatal",{"minScore":1}]}}}}';
    expect(() => parseGateConfig(text, 'rc')).toThrow(/not error, warn or off/);
  });

  it('refuses a config with no routes or no run count', () => {
    expect(() =>
      parseGateConfig('{"ci":{"collect":{"numberOfRuns":3},"assert":{"assertions":{}}}}', 'rc'),
    ).toThrow(/names no routes to collect/);
    expect(() =>
      parseGateConfig('{"ci":{"collect":{"url":["u"]},"assert":{"assertions":{}}}}', 'rc'),
    ).toThrow(/numberOfRuns is not a number/);
  });

  it('refuses a run count that is not a whole number of runs', () => {
    const base = '{"ci":{"collect":{"url":["u"],"numberOfRuns":';
    const tail = '},"assert":{"assertions":{"x":["error",{"minScore":1}]}}}}';
    expect(() => parseGateConfig(`${base}2.5${tail}`, 'rc')).toThrow(
      /numberOfRuns must be a whole number/,
    );
    expect(() => parseGateConfig(`${base}0${tail}`, 'rc')).toThrow(
      /numberOfRuns must be a whole number/,
    );
  });

  it('refuses a config that is not a config', () => {
    expect(() => parseGateConfig('[]', 'rc')).toThrow(/has no ci.collect and ci.assert/);
    expect(() => parseGateConfig('{', 'rc')).toThrow(/is not valid JSON/);
  });
});

describe('median', () => {
  it('takes the middle of an odd number of values, in any order', () => {
    expect(median([0.79, 0.75, 0.91])).toBe(0.79);
    expect(median([0.91, 0.79, 0.75])).toBe(0.79);
  });

  it('averages the middle two of an even number', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('refuses an empty set rather than reporting nothing as zero', () => {
    expect(() => median([])).toThrow(PagePerformanceError);
  });
});
