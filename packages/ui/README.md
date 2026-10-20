# @ujira/ui

The UJIRA design system, shared by the dashboard and the website. This first slice holds the design tokens, the nine brand icons and the font setup notes. Primitives, charts and payment components come later.

## Layout

| Path                                 | What it is                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `assets/brand/Tokens.json`           | Brand colour tokens, copied unchanged from the brand kit                                                                           |
| `assets/brand/ujira_icon-sprite_...` | Brand icon sprite from the brand kit, embedded provenance metadata removed                                                         |
| `tokens/system.json`                 | Design system tokens on top of the brand: density, radius, focus, shadow, motion, fonts, type scale and data visualisation colours |
| `tokens/generate.ts`                 | Turns the three sources into the generated files below                                                                             |
| `tokens/build.ts`                    | Writes the generated files                                                                                                         |
| `styles/tokens.css`                  | Generated. CSS custom properties, light and dark, imports `fonts.css`                                                              |
| `styles/theme.css`                   | Generated. Tailwind CSS v4 `@theme` block, imports `tokens.css`                                                                    |
| `styles/fonts.css`                   | Generated. The `@font-face` for the second mono face                                                                               |
| `fonts/`                             | The self hosted subset of that face and its licence                                                                                |
| `src/tokens/tokens.generated.ts`     | Generated. Typed constants with the same values                                                                                    |
| `src/icons/brand-icons.generated.ts` | Generated. The nine icon names and their shapes, read from the sprite                                                              |
| `src/icons/brand-icon.tsx`           | `<BrandIcon name="payout" />`                                                                                                      |

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

Fonts are self-hosted; no page loads a font from a font CDN at runtime. The three faces below are set up with `next/font` in each app. The second mono face, further down, ships inside this package. All four are under the SIL Open Font License 1.1.

| Role                                   | Face           | Weights       | CSS variable the app sets     |
| -------------------------------------- | -------------- | ------------- | ----------------------------- |
| Display, marketing headlines only      | Nunito         | 800           | `--ujira-font-nunito`         |
| Interface and body                     | Inter          | 400, 500, 600 | `--ujira-font-inter`          |
| Amounts, codes, labels, always tabular | JetBrains Mono | 400, 500      | `--ujira-font-jetbrains-mono` |

In each app, load the faces with `next/font/google` (it downloads at build time and serves the files from the app), pass `variable` with the names above and `subsets: ['latin', 'latin-ext']` so Hausa, Yoruba and Igbo diacritics render, and put the three `variable` class names on `<html>`. The token stacks (`--ujira-font-display`, `--ujira-font-sans`, `--ujira-font-mono`) fall back to system faces until then.

Rules the components will enforce: Nunito never below 20px and never in the product interface; every amount in JetBrains Mono with `tabular-nums`; body line height 1.6 or more wherever diacritics appear; the `label` step is set in capitals.

### The second mono face: the naira, cedi, peso and rupee signs

JetBrains Mono draws no naira, cedi, peso or rupee sign, so an amount in one of those currencies would fall through to whatever monospaced face the device happens to have, at whatever width it happens to use. Noto Sans Mono carries those four and only those four:

| Sign | Currencies      | Code point |
| ---- | --------------- | ---------- |
| ₦    | Nigerian naira  | U+20A6     |
| ₱    | Philippine peso | U+20B1     |
| ₵    | Ghanaian cedi   | U+20B5     |
| ₹    | Indian rupee    | U+20B9     |

Unlike the three faces above, this one needs nothing from the app. The subset lives in `fonts/`, `styles/fonts.css` declares it with a `unicode-range` holding exactly those four code points, and `styles/tokens.css` imports that stylesheet, so importing `@ujira/ui/styles/theme.css` (or `tokens.css`) is all it takes. Set the three variables above as described and do nothing else. In particular, do not add Noto Sans Mono to an app's `next/font` call: that fetches a whole family from a font service at build time, and the point of the subset is that nothing is fetched at all.

What makes "nothing from the app" true is the order of `--ujira-font-mono`, which puts this face **first**, ahead of `--ujira-font-jetbrains-mono`:

```css
--ujira-font-mono:
  'Noto Sans Mono', var(--ujira-font-jetbrains-mono, 'JetBrains Mono'), ui-monospace,
  SFMono-Regular, Menlo, monospace;
```

`next/font` does not put one family in that variable. It emits the real face plus a metric compatible fallback family, declared from a local system font so that text does not shift while the real face loads, and sets the variable to both. That fallback carries no `unicode-range`, so it claims every code point, the four signs included. With the signs face second, an amount in naira, peso or cedi is drawn by the local system font at its own width, which is a visibly ragged column next to the digits, and the subset is never reached. The rupee usually slips through only because the local font happens to lack it. Measured in Chrome on macOS with Arial installed: naira 72.22px, peso 66.70px and cedi 72.22px against a 60.00px column, with the signs face second; all four at 60.00px with it first.

Putting it first costs nothing, because its `unicode-range` confines it to the four signs: every other character fails to match it and falls straight through to the brand face. That holds even on a machine with a full Noto Sans Mono installed, since an `@font-face` rule shadows an installed family of the same name for the document (measured, not assumed).

Both faces advance 0.6 em per character, so a column of amounts keeps one width whichever face draws the sign. `font-display: swap` keeps the amount readable while the 2 KB file arrives.

The subset and its `unicode-range` come from the `font.mono.signs` tokens in `tokens/system.json`; run `pnpm --filter @ujira/ui tokens` after changing them. `src/fonts/fonts.test.ts` fails if the range stops being those four code points, if the file grows past 10 KB, if the subset draws anything else, if a sign loses the mono advance, if the licence text goes missing, or if the signs face stops coming before the app variable in the stack, in the typed constants and in `tokens.css` alike. Those last two are what stop the ordering regressing: a test that only looked for the family in the stack passed while the bug was live.

The stack order is a package level guarantee, but only an app can prove it end to end, because the metric fallback family only exists once a font loader has run. The dashboard suite owns that check.

#### Rebuilding the subset

The committed file is Noto Sans Mono 2.014, `NotoSansMono[wdth,wght].ttf` from `google/fonts` at commit `097bc1b8c04c3224087c2ae95f7a923859b778cf` (git blob `07ecc66508b893f34f09d20951039ac9c136f3b5`), with the width axis pinned at its default and the weight axis kept, so one file covers every weight. `fonts/OFL.txt` is that directory's licence file, copied byte for byte.

With fontTools 4.60.1 and Brotli 1.1.0:

```sh
python -m fontTools.varLib.instancer -o pinned.ttf "NotoSansMono[wdth,wght].ttf" wdth=100
SOURCE_DATE_EPOCH=1774573941 python -m fontTools.subset pinned.ttf \
  --output-file=fonts/noto-sans-mono-currency-signs.woff2 \
  --flavor=woff2 \
  --unicodes=U+20A6,U+20B1,U+20B5,U+20B9 \
  --layout-features= \
  --name-IDs=0,1,2,3,4,5,6,13,14
```

`SOURCE_DATE_EPOCH` is the upstream commit date; it fixes the timestamps the font records, so the build repeats byte for byte. The result is 2,264 bytes, SHA-256 `0f30474e0565b456f7ed08867bf2d6a2d7a025c8910654d08e1d6d006944358c`. The name records keep the copyright and the licence, so the file says what it is on its own.

## Brand material

`assets/brand/Tokens.json` and `assets/brand/ujira_icon-sprite_all_currentcolor.svg` are internal UJIRA brand material owned by Qomira Labs. `Tokens.json` is copied byte for byte from the brand kit. The sprite is the brand kit file with its embedded provenance metadata removed (the `<metadata>` element and the `xmlns:c2pa` namespace); every symbol is byte for byte the same, and a test checks both. They are not third party assets and carry no open source license. Update them only from a new brand kit release, then regenerate.
