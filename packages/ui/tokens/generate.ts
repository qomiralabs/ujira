// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

// Turns the brand colour tokens, the design system tokens and the brand icon
// sprite into the CSS, Tailwind theme and TypeScript files the package ships.
// Everything here is pure apart from loadSources, so the tests can run the
// exact same code the build script runs and compare the results.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';

export const OUTPUT_FILES = [
  'styles/tokens.css',
  'styles/theme.css',
  'src/tokens/tokens.generated.ts',
  'src/icons/brand-icons.generated.ts',
] as const;

export type OutputFile = (typeof OUTPUT_FILES)[number];

type Mode = 'light' | 'dark';

const LICENSE_HEADER = [
  '// Copyright (c) 2026 Qomira Labs. All rights reserved.',
  '// Proprietary and confidential. Unauthorized copying is prohibited.',
].join('\n');

const CSS_LICENSE_HEADER = [
  '/* Copyright (c) 2026 Qomira Labs. All rights reserved. */',
  '/* Proprietary and confidential. Unauthorized copying is prohibited. */',
].join('\n');

const NOTICE =
  'Generated from the brand colour tokens, tokens/system.json and the brand icon sprite.\n' +
  'Do not edit by hand. Run `pnpm --filter @ujira/ui tokens` to regenerate.';

// Brand tokens

const hex = z.string().regex(/^#[0-9A-F]{6}$/, 'expected an uppercase six digit hex colour');
const tokenName = z.string().regex(/^[a-z][a-z0-9-]*$/);
const modeValue = z.union([hex, z.string().regex(/^[a-z][a-z-]*$/)]);

const brandSchema = z
  .strictObject({
    $description: z.string().optional(),
    core: z.record(tokenName, hex),
    neutral: z.record(tokenName, hex),
    status: z.record(tokenName, z.strictObject({ fill: hex, text: hex, dark: hex })),
    modes: z.strictObject({
      light: z.record(tokenName, modeValue),
      dark: z.record(tokenName, modeValue),
    }),
  })
  .superRefine((brand, ctx) => {
    const light = brand.modes.light;
    const dark = brand.modes.dark;
    for (const key of new Set([...Object.keys(light), ...Object.keys(dark)])) {
      const a = light[key];
      const b = dark[key];
      if (a === undefined || b === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['modes', a === undefined ? 'light' : 'dark', key],
          message: `mode token "${key}" must exist in both light and dark`,
        });
      } else if (a.startsWith('#') !== b.startsWith('#')) {
        ctx.addIssue({
          code: 'custom',
          path: ['modes', 'dark', key],
          message: `mode token "${key}" must be a colour in both modes or in neither`,
        });
      }
    }
  });

export type BrandTokens = z.infer<typeof brandSchema>;

export function parseBrandTokens(json: unknown): BrandTokens {
  return brandSchema.parse(json);
}

// Design system tokens

const colourRef = z
  .string()
  .regex(
    /^(#[0-9A-F]{6}|\{(core|neutral|mode)\.[a-z0-9-]+\}|\{status\.[a-z0-9-]+\.(fill|text|dark)\})$/,
    'expected an uppercase hex colour or a {group.name} reference',
  );
const length = z.string().regex(/^\d+(\.\d+)?px$/);

const vizModeSchema = z.strictObject({
  categorical: z.tuple([colourRef, colourRef, colourRef, colourRef]),
  sequential: z.tuple([colourRef, colourRef, colourRef, colourRef, colourRef]),
  highlight: colourRef,
  paid: colourRef,
  waiting: colourRef,
  blocked: colourRef,
  grid: colourRef,
  axis: colourRef,
  tooltip: colourRef,
  'tooltip-rule': colourRef,
  'tooltip-text': colourRef,
});

const fontSchema = z.strictObject({
  face: z.string().min(1),
  variable: z.string().regex(/^--ujira-font-[a-z0-9-]+$/),
  fallback: z.array(z.string().regex(/^[\w-]+$/)).min(1),
});

const typeStepSchema = z.strictObject({
  family: z.enum(['display', 'sans', 'mono']),
  size: z.number().int().positive(),
  lineHeight: z.number().positive(),
  tracking: z.string().regex(/^-?\d+(\.\d+)?em$/),
  weight: z.number().int().min(100).max(900),
});

const systemSchema = z.strictObject({
  $description: z.string().optional(),
  density: z.strictObject({ row: length, 'row-compact': length }),
  radius: z.strictObject({ control: length, card: length, overlay: length }),
  focus: z.strictObject({ width: length, offset: length, color: colourRef }),
  shadow: z.strictObject({
    overlay: z.strictObject({
      x: length,
      y: length,
      blur: length,
      color: colourRef,
      alpha: z.number().min(0).max(1),
    }),
  }),
  motion: z.strictObject({
    'ease-out': z.string().regex(/^cubic-bezier\([\d., -]+\)$/),
    'ease-settle': z.string().regex(/^cubic-bezier\([\d., -]+\)$/),
    arrive: z.string().regex(/^\d+ms$/),
  }),
  font: z.strictObject({ display: fontSchema, sans: fontSchema, mono: fontSchema }),
  type: z.record(tokenName, typeStepSchema),
  viz: z.strictObject({ light: vizModeSchema, dark: vizModeSchema }),
});

export type SystemTokens = z.infer<typeof systemSchema>;

export function parseSystemTokens(json: unknown): SystemTokens {
  return systemSchema.parse(json);
}

// Resolution

type VizMode = SystemTokens['viz']['light'];

export interface ResolvedTokens {
  brand: BrandTokens;
  system: SystemTokens;
  viz: Record<Mode, VizMode>;
  focusColor: string;
  shadowOverlay: string;
}

function resolveColour(ref: string, brand: BrandTokens, mode: Mode | undefined): string {
  if (ref.startsWith('#')) return ref;
  const path = ref.slice(1, -1).split('.');
  const [group, name, shade] = path;
  let value: unknown;
  if (group === 'core') value = brand.core[name ?? ''];
  else if (group === 'neutral') value = brand.neutral[name ?? ''];
  else if (group === 'status') {
    const entry = brand.status[name ?? ''];
    value =
      entry && (shade === 'fill' || shade === 'text' || shade === 'dark')
        ? entry[shade]
        : undefined;
  } else if (group === 'mode') {
    if (!mode) throw new Error(`${ref} needs a mode, it can only be used inside viz`);
    value = brand.modes[mode][name ?? ''];
  }
  if (typeof value !== 'string' || !value.startsWith('#')) {
    throw new Error(`unknown colour reference ${ref}`);
  }
  return value;
}

function hexToRgb(value: string): [number, number, number] {
  const n = Number.parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function resolveTokens(brand: BrandTokens, system: SystemTokens): ResolvedTokens {
  const resolveViz = (mode: Mode): VizMode => {
    const source = system.viz[mode];
    const c = (ref: string): string => resolveColour(ref, brand, mode);
    return {
      categorical: [
        c(source.categorical[0]),
        c(source.categorical[1]),
        c(source.categorical[2]),
        c(source.categorical[3]),
      ],
      sequential: [
        c(source.sequential[0]),
        c(source.sequential[1]),
        c(source.sequential[2]),
        c(source.sequential[3]),
        c(source.sequential[4]),
      ],
      highlight: c(source.highlight),
      paid: c(source.paid),
      waiting: c(source.waiting),
      blocked: c(source.blocked),
      grid: c(source.grid),
      axis: c(source.axis),
      tooltip: c(source.tooltip),
      'tooltip-rule': c(source['tooltip-rule']),
      'tooltip-text': c(source['tooltip-text']),
    };
  };
  const shadow = system.shadow.overlay;
  const [r, g, b] = hexToRgb(resolveColour(shadow.color, brand, undefined));
  const resolved: ResolvedTokens = {
    brand,
    system,
    viz: { light: resolveViz('light'), dark: resolveViz('dark') },
    focusColor: resolveColour(system.focus.color, brand, undefined),
    shadowOverlay: `${shadow.x} ${shadow.y} ${shadow.blur} rgb(${String(r)} ${String(g)} ${String(b)} / ${String(shadow.alpha)})`,
  };
  assertNoThemeCollisions(resolved);
  return resolved;
}

// Tailwind colour names share one namespace, so a brand palette name and a
// mode token name must never be the same word.
function assertNoThemeCollisions(tokens: ResolvedTokens): void {
  const seen = new Set<string>();
  for (const name of themeColourNames(tokens)) {
    if (seen.has(name)) throw new Error(`colour name "${name}" is defined twice`);
    seen.add(name);
  }
}

// Contrast

function luminance(value: string): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(value);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio between two hex colours, from 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// CSS

type Declaration = readonly [name: string, value: string];

function modeColours(brand: BrandTokens, mode: Mode): Declaration[] {
  return Object.entries(brand.modes[mode]).filter(([, value]) => value.startsWith('#'));
}

function vizDeclarations(viz: VizMode): Declaration[] {
  return [
    ...viz.categorical.map((value, i): Declaration => [`viz-categorical-${String(i + 1)}`, value]),
    ...viz.sequential.map((value, i): Declaration => [`viz-sequential-${String(i + 1)}`, value]),
    ...(['highlight', 'paid', 'waiting', 'blocked', 'grid', 'axis', 'tooltip'] as const).map(
      (key): Declaration => [`viz-${key}`, viz[key]],
    ),
    ['viz-tooltip-rule', viz['tooltip-rule']],
    ['viz-tooltip-text', viz['tooltip-text']],
  ];
}

function modeDeclarations(tokens: ResolvedTokens, mode: Mode): Declaration[] {
  return [...modeColours(tokens.brand, mode), ...vizDeclarations(tokens.viz[mode])];
}

function paletteDeclarations(brand: BrandTokens): Declaration[] {
  return [
    ...Object.entries(brand.core),
    ...Object.entries(brand.neutral),
    ...Object.entries(brand.status).flatMap(([name, shades]) =>
      Object.entries(shades).map(([shade, value]): Declaration => [
        `status-${name}-${shade}`,
        value,
      ]),
    ),
  ];
}

function fontStack(font: SystemTokens['font']['display']): string {
  return [`var(${font.variable}, '${font.face}')`, ...font.fallback].join(', ');
}

function block(
  selector: string,
  declarations: readonly Declaration[],
  extra: string[] = [],
): string {
  const lines = [...extra, ...declarations.map(([name, value]) => `--ujira-${name}: ${value};`)];
  return `${selector} {\n${lines.map((line) => `  ${line}`).join('\n')}\n}`;
}

export function renderTokensCss(tokens: ResolvedTokens): string {
  const { brand, system } = tokens;
  const root: Declaration[] = [
    ...paletteDeclarations(brand),
    ['font-display', fontStack(system.font.display)],
    ['font-sans', fontStack(system.font.sans)],
    ['font-mono', fontStack(system.font.mono)],
    ['radius-control', system.radius.control],
    ['radius-card', system.radius.card],
    ['radius-overlay', system.radius.overlay],
    ['row-height', system.density.row],
    ['focus-ring-color', tokens.focusColor],
    ['focus-ring-width', system.focus.width],
    ['focus-ring-offset', system.focus.offset],
    ['shadow-overlay', tokens.shadowOverlay],
    ['ease-out', system.motion['ease-out']],
    ['ease-settle', system.motion['ease-settle']],
    ['duration-arrive', system.motion.arrive],
  ];
  const light = modeDeclarations(tokens, 'light');
  const dark = modeDeclarations(tokens, 'dark');
  return [
    CSS_LICENSE_HEADER,
    `/*\n * ${NOTICE.replace(/\n/g, '\n * ')}\n *\n * Light is the default. Dark follows the system setting unless a\n * data-theme attribute picks a mode, so a manual toggle always wins.\n */`,
    block(':root', root),
    block("[data-density='compact']", [['row-height', system.density['row-compact']]]),
    block(":root,\n[data-theme='light']", light, ['color-scheme: light;']),
    `@media (prefers-color-scheme: dark) {\n${block(":root:not([data-theme='light'])", dark, ['color-scheme: dark;'])}\n}`,
    block("[data-theme='dark']", dark, ['color-scheme: dark;']),
  ].join('\n\n');
}

function themeColourNames(tokens: ResolvedTokens): string[] {
  return [
    ...paletteDeclarations(tokens.brand).map(([name]) => name),
    ...modeDeclarations(tokens, 'light').map(([name]) => name),
    'focus',
  ];
}

function rem(px: number): string {
  return `${String(px / 16)}rem`;
}

export function renderThemeCss(tokens: ResolvedTokens): string {
  const colours = [...paletteDeclarations(tokens.brand), ...modeDeclarations(tokens, 'light')].map(
    ([name]) => `--color-${name}: var(--ujira-${name});`,
  );
  const type = Object.entries(tokens.system.type).flatMap(([step, t]) => [
    `--text-${step}: ${rem(t.size)};`,
    `--text-${step}--line-height: ${String(t.lineHeight)};`,
    `--text-${step}--letter-spacing: ${t.tracking};`,
    `--text-${step}--font-weight: ${String(t.weight)};`,
  ]);
  const lines = [
    '/* Only brand values exist: the Tailwind defaults for these namespaces are dropped. */',
    '--color-*: initial;',
    '--font-*: initial;',
    '--text-*: initial;',
    '--radius-*: initial;',
    '--shadow-*: initial;',
    '--ease-*: initial;',
    '',
    '--spacing: 0.25rem;',
    '--spacing-row: var(--ujira-row-height);',
    '',
    ...colours,
    '--color-focus: var(--ujira-focus-ring-color);',
    '',
    '--font-display: var(--ujira-font-display);',
    '--font-sans: var(--ujira-font-sans);',
    '--font-mono: var(--ujira-font-mono);',
    '',
    ...type,
    '',
    '--radius-control: var(--ujira-radius-control);',
    '--radius-card: var(--ujira-radius-card);',
    '--radius-overlay: var(--ujira-radius-overlay);',
    '--shadow-overlay: var(--ujira-shadow-overlay);',
    '--ease-out: var(--ujira-ease-out);',
    '--ease-settle: var(--ujira-ease-settle);',
  ];
  return [
    CSS_LICENSE_HEADER,
    `/*\n * ${NOTICE.replace(/\n/g, '\n * ')}\n *\n * Tailwind CSS v4 theme. Import it after tailwindcss; utilities read the\n * custom properties from tokens.css, so they switch with the colour mode.\n */`,
    "@import './tokens.css';",
    `@theme inline {\n${lines.map((line) => (line ? `  ${line}` : '')).join('\n')}\n}`,
  ].join('\n\n');
}

// TypeScript

function constant(name: string, doc: string, value: unknown): string {
  return `/** ${doc} */\nexport const ${name} = ${JSON.stringify(value, null, 2)} as const;`;
}

export function renderTokensTs(tokens: ResolvedTokens): string {
  const { brand, system } = tokens;
  const fonts = Object.fromEntries(
    Object.entries(system.font).map(([role, font]) => [role, { ...font, stack: fontStack(font) }]),
  );
  return [
    LICENSE_HEADER,
    `// ${NOTICE.replace(/\n/g, '\n// ')}`,
    constant('palette', 'Brand core and neutral colours, the same in both modes.', {
      ...brand.core,
      ...brand.neutral,
    }),
    constant(
      'status',
      'Payment status colours. Payments only, always with a word and an icon.',
      brand.status,
    ),
    constant(
      'modes',
      'Semantic tokens per colour mode, with keys identical in light and dark.',
      brand.modes,
    ),
    constant(
      'viz',
      'Data visualisation colours per mode, resolved to hex for chart themes.',
      tokens.viz,
    ),
    constant(
      'radius',
      'Corner radius: controls, cards, and dialogs, sheets and receipts.',
      system.radius,
    ),
    constant(
      'density',
      'Table row height for the default and the compact density.',
      system.density,
    ),
    constant('focus', 'Focus ring on every interactive element, in both modes.', {
      ...system.focus,
      color: tokens.focusColor,
    }),
    constant('shadow', 'The one shadow level, for overlays only. Cards use a rule instead.', {
      overlay: tokens.shadowOverlay,
    }),
    constant('motion', 'Brand easing curves and the payment arrival duration.', system.motion),
    constant('fonts', 'Font roles. The variable is filled by next/font in each app.', fonts),
    constant('typeScale', 'Type scale in px with unitless line heights.', system.type),
  ].join('\n\n');
}

// Icons

const SYMBOL_ATTRIBUTES: Readonly<Record<string, string>> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.5',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};
const SHAPE_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const SHAPE_ATTRIBUTES = new Set([
  'd',
  'x',
  'y',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
]);

export type IconShape = readonly [tag: string, attributes: Readonly<Record<string, string>>];
export type IconSet = Readonly<Record<string, readonly IconShape[]>>;

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    if (match[1] !== undefined && match[2] !== undefined) found[match[1]] = match[2];
  }
  return found;
}

/**
 * Reads the brand sprite and checks every icon keeps the brand grid: a 24px
 * view box, a 1.5px round stroke in currentColor, no fills and nothing but
 * plain shapes.
 */
export function parseSprite(svg: string): IconSet {
  const icons: Record<string, IconShape[]> = {};
  for (const symbol of svg.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g)) {
    const attrs = attributes(symbol[1] ?? '');
    const id = attrs['id'] ?? '';
    const name = /^ujira-([a-z][a-z-]*)$/.exec(id)?.[1];
    if (!name) throw new Error(`sprite symbol has an unexpected id "${id}"`);
    for (const [key, expected] of Object.entries(SYMBOL_ATTRIBUTES)) {
      if (attrs[key] !== expected) {
        throw new Error(`${id}: ${key} must be "${expected}", got "${attrs[key] ?? ''}"`);
      }
    }
    const shapes: IconShape[] = [];
    const body = (symbol[2] ?? '').replace(
      /<([a-z]+)\b([^>]*?)\s*(?:\/>|>\s*<\/\1>)/g,
      (_whole, tag: string, rest: string) => {
        if (!SHAPE_TAGS.has(tag)) throw new Error(`${id}: <${tag}> is not a plain shape`);
        const shapeAttrs = attributes(rest);
        for (const key of Object.keys(shapeAttrs)) {
          if (!SHAPE_ATTRIBUTES.has(key))
            throw new Error(`${id} ${tag}: attribute ${key} is not allowed`);
        }
        shapes.push([tag, shapeAttrs]);
        return '';
      },
    );
    if (body.trim() !== '') throw new Error(`${id}: unexpected content "${body.trim()}"`);
    if (shapes.length === 0) throw new Error(`${id}: has no shapes`);
    if (name in icons) throw new Error(`${id}: defined twice`);
    icons[name] = shapes;
  }
  return icons;
}

export function renderIconsTs(icons: IconSet): string {
  const names = Object.keys(icons);
  return [
    LICENSE_HEADER,
    `// ${NOTICE.replace(/\n/g, '\n// ')}`,
    `/** The nine brand icons, in sprite order. */\nexport const brandIconNames = ${JSON.stringify(names)} as const;`,
    '/** Name of one of the nine brand icons. */\nexport type BrandIconName = (typeof brandIconNames)[number];',
    `export type BrandIconTag = ${[...new Set(Object.values(icons).flatMap((shapes) => shapes.map(([tag]) => JSON.stringify(tag))))].sort().join(' | ')};`,
    `export type BrandIconShapeAttributes = Readonly<Partial<Record<${[...SHAPE_ATTRIBUTES].map((a) => JSON.stringify(a)).join(' | ')}, string>>>;`,
    'export type BrandIconShape = readonly [tag: BrandIconTag, attributes: BrandIconShapeAttributes];',
    `/** Shapes of each icon, read from the brand sprite. */\nexport const brandIconShapes: Readonly<Record<BrandIconName, readonly BrandIconShape[]>> = ${JSON.stringify(icons, null, 2)};`,
  ].join('\n\n');
}

// Files

export interface Sources {
  brandJson: unknown;
  systemJson: unknown;
  sprite: string;
}

export function loadSources(root: string): Sources {
  const read = (path: string): string => readFileSync(join(root, path), 'utf8');
  return {
    brandJson: JSON.parse(read('assets/brand/Tokens.json')) as unknown,
    systemJson: JSON.parse(read('tokens/system.json')) as unknown,
    sprite: read('assets/brand/ujira_icon-sprite_all_currentcolor.svg'),
  };
}

/** Every output file, formatted with the repository Prettier config. */
export async function generateOutputs(root: string): Promise<Record<OutputFile, string>> {
  const sources = loadSources(root);
  const tokens = resolveTokens(
    parseBrandTokens(sources.brandJson),
    parseSystemTokens(sources.systemJson),
  );
  const raw: Record<OutputFile, string> = {
    'styles/tokens.css': renderTokensCss(tokens),
    'styles/theme.css': renderThemeCss(tokens),
    'src/tokens/tokens.generated.ts': renderTokensTs(tokens),
    'src/icons/brand-icons.generated.ts': renderIconsTs(parseSprite(sources.sprite)),
  };
  const formatted = {} as Record<OutputFile, string>;
  for (const file of OUTPUT_FILES) {
    const filepath = join(root, file);
    const config = (await resolveConfig(filepath)) ?? {};
    formatted[file] = await format(raw[file], { ...config, filepath });
  }
  return formatted;
}
