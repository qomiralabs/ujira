# @ujira/ui

The UJIRA design system, shared by the dashboard and the website. It holds the design tokens, the nine brand icons, the form primitives and the component catalogue. Charts and payment components come later.

## Layout

| Path                                 | What it is                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `assets/brand/Tokens.json`           | Brand colour tokens, copied unchanged from the brand kit                                                                           |
| `assets/brand/ujira_icon-sprite_...` | Brand icon sprite from the brand kit, embedded provenance metadata removed                                                         |
| `tokens/system.json`                 | Design system tokens on top of the brand: density, radius, focus, shadow, motion, fonts, type scale and data visualisation colours |
| `tokens/generate.ts`                 | Turns the three sources into the generated files below                                                                             |
| `tokens/build.ts`                    | Writes the generated files                                                                                                         |
| `styles/tokens.css`                  | Generated. CSS custom properties, light and dark                                                                                   |
| `styles/theme.css`                   | Generated. Tailwind CSS v4 `@theme` block, imports `tokens.css`                                                                    |
| `src/tokens/tokens.generated.ts`     | Generated. Typed constants with the same values                                                                                    |
| `src/icons/brand-icons.generated.ts` | Generated. The nine icon names and their shapes, read from the sprite                                                              |
| `src/icons/brand-icon.tsx`           | `<BrandIcon name="payout" />`                                                                                                      |
| `src/primitives/`                    | The form primitives, shadcn/ui on Radix restyled to the brand                                                                      |
| `src/lib/cn.ts`                      | `cn()`, the class merge that knows the brand type steps, radii and shadows                                                         |
| `stories/`                           | One story file per primitive, every variant and state                                                                              |
| `.storybook/`                        | The catalogue: light and dark, the three widths, the axe addon                                                                     |
| `e2e/`                               | The browser tests: axe, the focus ring and the visual snapshots                                                                    |

## Primitives

```tsx
import { Button, Field, Input } from '@ujira/ui';

<Field label="Recipient email" hint="We send the receipt here." error={errors.email?.message}>
  <Input type="email" {...register('email')} />
</Field>
<Button variant="primary">Approve payout</Button>
```

`Field` is the wiring: it gives the control an id, links the label, the hint and the error with
`aria-describedby` and `aria-errormessage`, and marks the control invalid while an error is set.
Pass a react-hook-form message straight to `error`. Group controls such as `RadioGroup` are named
by the label instead. Input, Textarea, Select, Checkbox, RadioGroup and Switch all read the field
around them, so nothing has to be wired twice.

Rules the primitives hold to:

- One saffron primary action per view. `Button` has `primary`, `secondary`, `ghost` and `danger`;
  only `primary` uses the saffron fill.
- No action borrows a payment status colour. Paid, waiting and blocked describe a payment, so
  `danger` is marked by the strongest border of the four variants and by the icon the caller gives
  it, not by red. The red belongs to the confirmation step that follows. A test fails if any
  variant picks up a status token. If we later want a louder destructive button, that needs a
  destructive colour in the brand tokens, which is the brand owner's decision, not a local one.
- Every interactive element has the 2px saffron focus ring with a 2px offset, and a teal ink ring
  in the offset band so it stays visible on cream, on white and on a saffron button.
- 6px radius on inputs and buttons, no shadows outside overlays.
- Errors carry an icon and a sentence, never colour alone.
- A loading button keeps its label and its place in the tab order: it is marked busy and disabled,
  and ignores clicks, rather than dropping out of the page.
- Lucide icons are drawn at `strokeWidth={1.5}`, and only where the brand has no icon of its own.
  The nine core ideas (mandate, payout, recipient, approval, receipt, rail, local currency, agent,
  pause) use `<BrandIcon />`, so a pause button shows the brand glyph rather than a generic one.
- Choices the product named carry a description: `RadioGroupItem` and `SelectItem` take one, linked
  with `aria-describedby`, and the name stays the accessible name. Choices the principal named
  themselves, such as a project or a mandate, stay bare, because the name is the whole content.
- Radius: an overlay anchored to and sized by a control, such as the open `Select` list, matches
  the control's 6px. A free standing overlay, such as a dialog or a sheet, uses 14px. There is no
  third value.
- Text only ever sits on `bg` or `surface`. Those are the two grounds the token tests hold every
  text colour to 4.5:1 against. A highlighted row therefore uses `bg`, never `rule`: secondary text
  on the rule ground measures 3.8:1 in dark mode, and axe catches it.
- Checkbox and radio boxes are 20px with a 24px hit area, so they meet WCAG 2.2 AA target size even
  in a dense row with no label beside them to click.
- Colours come from the generated theme only. A test fails on a hex, `rgb()` or `hsl()` literal, on
  a colour utility that is not in the theme, and on a custom property that is not a UJIRA or Radix one.

## Catalogue

```sh
pnpm --filter @ujira/ui storybook        # the catalogue at http://localhost:6006
pnpm --filter @ujira/ui build-storybook  # static build into storybook-static/
pnpm --filter @ujira/ui test-storybook   # the browser tests against that build
```

The catalogue switches mode with the same `data-theme` attribute the apps use, and the viewport
toolbar holds the three widths every screen is checked at: 375, 768 and 1440. The a11y addon runs
axe on the story you are looking at.

`test-storybook` runs every story twice, once per mode. Each run checks axe for WCAG 2.2 AA
violations and compares a screenshot. A separate spec presses Tab on every interactive story in
both modes and asserts the saffron ring. Build the catalogue first; the tests read its
`index.json`, so a new story is covered the moment it exists.

Most stories are a single control whose layout does not change with the width, so they are
snapshotted once at 768. The stories whose layout does change, listed in `RESPONSIVE` in
`e2e/storybook.spec.ts`, are snapshotted at all three widths. Add a story to that list when its
layout reflows, rather than tripling every image.

Off Linux the screenshot comparison is the only thing that does not run: axe, the focus ring and
the sideways scroll check at every width still do. The run says so before it starts and each story
carries a `snapshot skipped` annotation, so a green local run cannot be mistaken for the full
visual gate.

Screenshots are compared only on Linux, so that one set of files works for everyone. Take and
check them in the same image CI uses:

```sh
docker run --rm --platform linux/amd64 -v "$PWD/../..":/w \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  bash -c 'cd /w/packages/ui && node node_modules/@playwright/test/cli.js test --update-snapshots'
```

Look at every changed image before you commit it. Run the same command without
`--update-snapshots` to check them.

The screenshots are our own output, not third party material, so they are registered once in
`assets.licenses.json` as a single glob over the folder. New stories need no new entry.

## Tokens

Never type a brand hex value by hand. Colours come from `assets/brand/Tokens.json`; `tokens/system.json` refers to them as `{core.teal}`, `{neutral.mist-300}`, `{status.paid.fill}` or `{mode.rule}`. The only literal hex values in `system.json` are values the brand palette does not have: the data visualisation steps and `status.blocked.dark-text`. A test fails if one of them duplicates a brand colour.

`system.json` also adds mode tokens on top of the brand ones: `paid-fill`, `waiting-fill` and `blocked-fill` for status icons and fills, and a dark `blocked` text value of `#FCA5A5`, because the brand dark red is 3.44:1 on the dark surface. The brand red stays the dark blocked fill and icon colour. The brand file itself is not changed; the brand owner can adopt `status.blocked.dark-text` there later.

After changing any source, regenerate and commit the output:

```sh
pnpm --filter @ujira/ui tokens
```

`pnpm --filter @ujira/ui test` fails when a committed file differs from a fresh generation, when a generated colour differs from the brand tokens, when light and dark do not have the same keys, or when a text token drops below WCAG AA on its ground. The generator validates every source with zod and rejects unknown references, malformed colours, missing mode keys and icons that leave the brand grid.

### Colour modes

Light is the default. Dark follows `prefers-color-scheme` unless an ancestor sets `data-theme`, so a manual toggle always wins:

```html
<html data-theme="dark"></html>
```

`data-density="compact"` lowers the table row height from 44px to 36px.

### Focus ring

`tokens.css` sets one `:focus-visible` rule in `@layer base`: a 2px saffron outline with a 2px offset, and a teal ink ring (`--ujira-focus-ring-inner`) drawn in the offset band with `box-shadow`. Saffron alone is about 2:1 on cream and white, so the ink ring carries the contrast in light mode and keeps the ring visible on a saffron button. A component that sets its own `box-shadow` must add the inner ring to it when focused.

### Contrast and colour vision

The tests hold every value to these minimums on `bg` and `surface` in both modes:

- 4.5:1 for text, secondary and subtle text, accent text and status text
- 3:1 for status fills, the focus ring, every categorical colour, every sequential step, the highlight and waiting strokes, the paid and blocked series, axis text and tooltip text
- a CIEDE2000 difference of at least 10 between categorical colours and between each categorical colour and the highlight, and at least 5 between adjacent sequential steps, under normal vision and simulated protanopia, deuteranopia and tritanopia (Machado 2009, full severity)

### Chart rules

- The saffron highlight fill and the light waiting fill are below 3:1 on light grounds, so they are always drawn with `viz-highlight-stroke` or `viz-waiting-stroke`: a 1.5px outline on bars and areas, and the line colour on line series.
- The lowest sequential step reaches 3:1, so "no data" is never a colour: it is the surface with a `rule` outline, and the table view carries the exact values.
- Paid and blocked sit close under deuteranopia, so status series always carry direct labels and the blocked series uses a decal pattern (ECharts `aria.decal`). Never colour alone.

### Tailwind CSS v4

```css
@import 'tailwindcss';
@import '@ujira/ui/styles/theme.css';
```

The theme drops the Tailwind default colours, fonts, type sizes, radii, shadows and easings, so only brand values produce utilities: `bg-surface`, `text-text-secondary`, `border-rule`, `bg-accent-fill`, `text-accent-text`, `text-paid`, `bg-paid-fill`, `rounded-control`, `rounded-card`, `rounded-overlay`, `shadow-overlay`, `font-mono`, `text-amount-xl`, `h-row`, `ease-out`, `ease-settle`, `outline-focus`, `ring-focus-inner`. Utilities read the `--ujira-*` variables directly, so they switch with the mode without a rebuild.

Raw saffron and raw status shades are CSS variables only and have no utilities: they ignore the mode, and saffron as text on light fails contrast. The mode accent is exposed as `accent-fill`, so `text-accent-fill` reads as wrong in review; saffron text is `text-accent-text`.

### TypeScript

```ts
import { modes, viz, cssVar } from '@ujira/ui';

viz.dark.categorical; // four hex colours for a chart theme
cssVar('surface'); // 'var(--ujira-surface)'
```

## Icons

```tsx
import { BrandIcon } from '@ujira/ui';

<BrandIcon name="approval" />                         // decorative, hidden from screen readers
<BrandIcon name="pause" label="Mandate paused" />     // announced as an image
```

`name` accepts only the nine brand icons: `mandate`, `payout`, `recipient`, `approval`, `receipt`, `rail`, `local-currency`, `agent`, `pause`. The icon draws with a 1.5px round stroke in `currentColor` on the 24px grid; set its colour with a text colour class. The stroke is written into the inline style as well, so neither a class nor a `style` prop can change it. The shapes are rendered inline from the sprite, so the icon works in server components and inside shadow DOM without a sprite request. Apps that prefer the sprite file can import `@ujira/ui/assets/brand-icons.svg`. For every other interface icon use Lucide with `strokeWidth={1.5}`.

## Fonts

Fonts are self-hosted with `next/font` in each app; nothing is loaded from a font CDN. All three faces are under the SIL Open Font License 1.1.

| Role                                   | Face           | Weights       | CSS variable the app sets     |
| -------------------------------------- | -------------- | ------------- | ----------------------------- |
| Display, marketing headlines only      | Nunito         | 800           | `--ujira-font-nunito`         |
| Interface and body                     | Inter          | 400, 500, 600 | `--ujira-font-inter`          |
| Amounts, codes, labels, always tabular | JetBrains Mono | 400, 500      | `--ujira-font-jetbrains-mono` |

In each app, load the faces with `next/font/google` (it downloads at build time and serves the files from the app), pass `variable` with the names above and `subsets: ['latin', 'latin-ext']` so Hausa, Yoruba and Igbo diacritics render, and put the three `variable` class names on `<html>`. The token stacks (`--ujira-font-display`, `--ujira-font-sans`, `--ujira-font-mono`) fall back to system faces until then.

Rules the components will enforce: Nunito never below 20px and never in the product interface; every amount in JetBrains Mono with `tabular-nums`; body line height 1.6 or more wherever diacritics appear; the `label` step is set in capitals.

## Brand material

`assets/brand/Tokens.json` and `assets/brand/ujira_icon-sprite_all_currentcolor.svg` are internal UJIRA brand material owned by Qomira Labs. `Tokens.json` is copied byte for byte from the brand kit. The sprite is the brand kit file with its embedded provenance metadata removed (the `<metadata>` element and the `xmlns:c2pa` namespace); every symbol is byte for byte the same, and a test checks both. They are not third party assets and carry no open source license. Update them only from a new brand kit release, then regenerate.
