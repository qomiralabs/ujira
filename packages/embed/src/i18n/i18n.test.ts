// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Holds the line on copy: nothing a person reads may be typed into a
// component. Every word comes from a language file, so a translator has one
// place to work and nobody has to hunt through templates.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { en } from './en.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');

// Attributes a screen reader or a tooltip reads out.
// A value that is typed in rather than interpolated: the marker stands for
// `${...}`, so `aria-label=${label}` passes and `aria-label="Close"` does not.
const SPOKEN_ATTRIBUTE =
  /\b(?:aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext|placeholder|title|alt)=["']?[^"'\s>$]/i;
// A button's face is its value attribute, and an option's is its label.
const PRESSED_VALUE = /\btype=["']?(?:submit|button|reset)\b/i;
const VALUE_ATTRIBUTE = /\bvalue=["']?[^"'\s>$]/i;
const LABEL_ATTRIBUTE = /\blabel=["']?[^"'\s>$]/i;
const TAG_NAME = /^\s*([a-zA-Z][\w-]*)/;
/** The attribute names a screen reader reads out, for an interpolation's slot. */
const SPOKEN_NAME =
  /^(?:aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext|placeholder|title|alt)$/;
const MARKER = '\u0000';

/**
 * Every source file that renders markup, found rather than listed. A list
 * kept by hand goes stale the day someone adds a screen, and this rule
 * exists to catch exactly that day, so the rule would pass on the one
 * occasion it was built for.
 */
export function filesWithTemplates(root: string, base = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesWithTemplates(path, base));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.generated.ts')) continue;
    const source = readFileSync(path, 'utf8');
    if (/\b(?:html|svg)`/.test(source)) {
      found.push(relative(base, path).split('\\').join('/'));
    }
  }
  return found;
}

export interface Literal {
  file: string;
  line: number;
  text: string;
}

/**
 * Where each interpolation lands: in text, in an attribute, and if so which
 * one. A space in a string is no guide at all, in either direction: a one
 * word answer is copy, and a class holding two words is not. The position
 * is the thing that decides it.
 */
function slots(text: string): { inTag: boolean; attribute: string }[] {
  const found: { inTag: boolean; attribute: string }[] = [];
  let inTag = false;
  let tag = '';
  for (const character of text) {
    if (character === MARKER) {
      const attribute = /([a-zA-Z-]+)=["']?$/.exec(tag)?.[1]?.toLowerCase() ?? '';
      found.push({ inTag, attribute });
      continue;
    }
    if (!inTag && character === '<') {
      inTag = true;
      tag = '';
      continue;
    }
    if (inTag && character === '>') {
      inTag = false;
      continue;
    }
    if (inTag) tag += character;
  }
  return found;
}

/**
 * Words chosen inside an interpolation, in a position where they are read.
 * Text position and the spoken attributes count whatever their length;
 * every other attribute is structural and exempt by not being named.
 *
 * Arguments to a call are skipped, because t('name.heading') passes a key
 * to the translator rather than rendering a string.
 */
function spokenExpressions(file: string, source: string): Literal[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const found: Literal[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag.getText(tree);
      const template = node.template;
      if ((tag === 'html' || tag === 'svg') && !ts.isNoSubstitutionTemplateLiteral(template)) {
        const joined = [
          template.head.text,
          ...template.templateSpans.map((span) => span.literal.text),
        ].join(MARKER);
        const positions = slots(joined);
        template.templateSpans.forEach((span, index) => {
          const slot = positions[index];
          if (slot === undefined) return;
          const read = !slot.inTag || SPOKEN_NAME.test(slot.attribute);
          if (!read) return;
          const look = (inner: ts.Node): void => {
            if (ts.isCallExpression(inner) || ts.isElementAccessExpression(inner)) return;
            if (
              (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) &&
              inner.text.trim() !== ''
            ) {
              found.push({
                file,
                line: tree.getLineAndCharacterOfPosition(inner.getStart(tree)).line + 1,
                text: inner.text,
              });
            }
            ts.forEachChild(inner, look);
          };
          look(span.expression);
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** The literal spans of every html`` and svg`` template in a file. */
function templates(file: string, source: string): { text: string; line: number }[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag.getText(tree);
      if (tag === 'html' || tag === 'svg') {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        const template = node.template;
        const text = ts.isNoSubstitutionTemplateLiteral(template)
          ? template.text
          : [template.head.text, ...template.templateSpans.map((span) => span.literal.text)].join(
              MARKER,
            );
        found.push({ text, line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/**
 * Text that lands between tags, and literal values of spoken attributes.
 * Interpolations stand in as a marker, so `${label}` reads as no text.
 */
export function literalStrings(file: string, source: string): Literal[] {
  const problems: Literal[] = [];
  for (const { text, line } of templates(file, source)) {
    let inTag = false;
    let outside = '';
    let tag = '';
    for (const character of text) {
      if (!inTag && character === '<') {
        inTag = true;
        tag = '';
        continue;
      }
      if (inTag && character === '>') {
        inTag = false;
        // The marker becomes a space, so an interpolated value reads as absent.
        const cleaned = tag.replaceAll(MARKER, ' ');
        const name = TAG_NAME.exec(cleaned)?.[1]?.toLowerCase() ?? '';
        const pressed = name === 'input' && PRESSED_VALUE.test(cleaned);
        if (
          SPOKEN_ATTRIBUTE.test(cleaned) ||
          (pressed && VALUE_ATTRIBUTE.test(cleaned)) ||
          ((name === 'option' || name === 'optgroup') && LABEL_ATTRIBUTE.test(cleaned))
        ) {
          problems.push({ file, line, text: tag.trim() });
        }
        continue;
      }
      if (inTag) tag += character;
      else outside += character;
    }
    const words = outside.replaceAll(MARKER, '').trim();
    if (words !== '') problems.push({ file, line, text: words });
  }
  problems.push(...spokenExpressions(file, source));
  return problems;
}

const SRC = join(PACKAGE_ROOT, 'src');

describe('i18n', () => {
  it('no literal user-facing strings in components', () => {
    const files = filesWithTemplates(SRC);
    // Pins what the walk found, so a walk that found nothing cannot report
    // an empty violation list with full confidence.
    expect(files).toEqual(
      expect.arrayContaining([
        'onboarding-element.ts',
        'views/footer.ts',
        'views/parts.ts',
        'views/step-views.ts',
      ]),
    );
    const problems = files.flatMap((file) =>
      literalStrings(file, readFileSync(join(SRC, file), 'utf8')),
    );
    expect(problems).toEqual([]);
  });

  it('finds a file that renders markup without being told about it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ujira-i18n-'));
    try {
      writeFileSync(join(dir, 'new-view.ts'), 'export const v = () => html`<p>${t(k)}</p>`;\n');
      writeFileSync(join(dir, 'plain.ts'), 'export const n = 1;\n');
      writeFileSync(join(dir, 'skipped.test.ts'), 'html`<p>Pay now</p>`;\n');
      expect(filesWithTemplates(dir)).toEqual(['new-view.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports text typed straight into a template', () => {
    const source = [
      'const view = () => html`<p class="hint">Pay now</p>`;',
      'const label = () => html`<button aria-label="Close this">${icon}</button>`;',
      'const fine = () => html`<p class="hint">${t("name.hint")}</p>`;',
    ].join('\n');
    expect(literalStrings('sample.ts', source)).toEqual([
      { file: 'sample.ts', line: 1, text: 'Pay now' },
      { file: 'sample.ts', line: 2, text: 'button aria-label="Close this"' },
    ]);
  });

  it('reports copy hidden in the attributes that carry it', () => {
    const source = [
      'const go = () => html`<input type="submit" value="Pay now" />`;',
      'const pick = () => html`<option label="Bank transfer" value="bank"></option>`;',
      'const said = () => html`<div aria-roledescription="payout card">${x}</div>`;',
      'const read = () => html`<div aria-valuetext="two of four">${x}</div>`;',
      'const fine = () => html`<input type="text" value=${v} />`;',
    ].join('\n');
    expect(literalStrings('sample.ts', source).map((p) => p.line)).toEqual([1, 2, 3, 4]);
  });

  it('reports a choice of words made inside an interpolation, however short', () => {
    const source = [
      'const v = () => html`<p>${done ? "All set" : t("k")}</p>`;',
      'const one = () => html`<p>${yes ? "Yes" : "No"}</p>`;',
      'const said = () => html`<p aria-label=${busy ? "Saving" : "Saved"}>${t("k")}</p>`;',
      'const ok = () => html`<p aria-invalid=${bad ? "true" : "false"}>${t("k")}</p>`;',
      'const cls = () => html`<p class=${wide ? "row wide" : "row"}>${t("k")}</p>`;',
      'const key = () => html`<p>${t("name.heading")}</p>`;',
    ].join('\n');
    // Text and spoken attributes count whatever the word count; structural
    // attributes do not count however many words they hold; and a key
    // passed to the translator is not copy.
    expect(literalStrings('sample.ts', source)).toEqual([
      { file: 'sample.ts', line: 1, text: 'All set' },
      { file: 'sample.ts', line: 2, text: 'Yes' },
      { file: 'sample.ts', line: 2, text: 'No' },
      { file: 'sample.ts', line: 3, text: 'Saving' },
      { file: 'sample.ts', line: 3, text: 'Saved' },
    ]);
  });

  it('every key in the catalogue is used', () => {
    const sources = filesWithTemplates(SRC)
      .concat(['methods.ts', 'steps.ts'])
      .map((file) => readFileSync(join(SRC, file), 'utf8'))
      .join('\n');
    const unused = Object.keys(en).filter((key) => !sources.includes(`'${key}'`));
    expect(unused).toEqual([]);
  });
});
