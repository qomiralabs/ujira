// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Holds the line on copy: nothing a person reads may be typed into a
// component. Every word comes from a language file, so a translator has one
// place to work and nobody has to hunt through templates.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { en } from './en.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..');

// Every file that renders markup.
const COMPONENTS = [
  'src/onboarding-element.ts',
  'src/views/footer.ts',
  'src/views/parts.ts',
  'src/views/step-views.ts',
];

// Attributes a screen reader or a tooltip reads out.
// A value that is typed in rather than interpolated: the marker stands for
// `${...}`, so `aria-label=${label}` passes and `aria-label="Close"` does not.
const SPOKEN_ATTRIBUTE =
  /\b(?:aria-label|aria-description|aria-placeholder|placeholder|title|alt)=["']?[^"'\s>$]/i;
const MARKER = '\u0000';

export interface Literal {
  file: string;
  line: number;
  text: string;
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
        if (SPOKEN_ATTRIBUTE.test(tag.replaceAll(MARKER, ' '))) {
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
  return problems;
}

describe('i18n', () => {
  it('no literal user-facing strings in components', () => {
    const problems = COMPONENTS.flatMap((file) =>
      literalStrings(file, readFileSync(join(PACKAGE_ROOT, file), 'utf8')),
    );
    expect(problems).toEqual([]);
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

  it('every key in the catalogue is used', () => {
    const sources = COMPONENTS.concat(['src/methods.ts', 'src/steps.ts'])
      .map((file) => readFileSync(join(PACKAGE_ROOT, file), 'utf8'))
      .join('\n');
    const unused = Object.keys(en).filter((key) => !sources.includes(`'${key}'`));
    expect(unused).toEqual([]);
  });
});
