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
| `styles/tokens.css`                  | Generated. CSS custom properties, light and dark, imports `fonts.css`                                                              |
| `styles/theme.css`                   | Generated. Tailwind CSS v4 `@theme` block, imports `tokens.css`                                                                    |
| `styles/fonts.css`                   | Generated. The `@font-face` for the second mono face                                                                               |
| `fonts/`                             | The self hosted subset of that face and its licence                                                                                |
| `src/tokens/tokens.generated.ts`     | Generated. Typed constants with the same values                                                                                    |
| `src/icons/brand-icons.generated.ts` | Generated. The nine icon names and their shapes, read from the sprite                                                              |
| `src/icons/brand-icon.tsx`           | `<BrandIcon name="payout" />`                                                                                                      |
| `src/primitives/`                    | The form primitives, shadcn/ui on Radix restyled to the brand                                                                      |
| `src/money/`                         | `Amount`, `TokenAmount`, `AmountProvider` and `formatMoney`, on the core money model                                               |
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

## Money

Every amount on screen goes through the core money model in `@ujira/core`. Nothing here formats,
rounds or converts on its own, and no amount is ever a JavaScript `number`.

```tsx
import { Amount, AmountProvider, TokenAmount, formatMoney } from '@ujira/ui';

<Amount minor="2000000" currency="NGN" />                  // ₦20,000.00
<Amount value={payout.amount} size="data" />                // a core Money
<Amount minor="2000000" currency="NGN" secondary={usdc} />  // USDC under it, smaller
<TokenAmount value={usdc} />                                // 12.50 USDC
formatMoney(2_000_000n, 'NGN', 'en');                       // the same text, as a string
```

- `Amount` takes a core `Money`, or integer minor units (a `bigint` or its decimal string, as the
  API sends it) with a currency. A number does not compile, and `ujira/no-number-amount` refuses
  one that gets through a cast, in every package and app.
- The text is exactly what the core `formatMoney` returns: the brand symbol, two decimals, the true
  minus sign and no-break spaces. A property test holds the rendered text to it.
- Every amount is set in the mono stack with tabular figures and never wraps. The naira, cedi, peso
  and rupee signs come from the second mono face at the same width, so a column of amounts lines up.
  Right align the cell in a table; `size` picks the step (`data`, `large`, `hero`), and `hero`
  steps down on a phone rather than push the page sideways.
- Each amount is its own bidirectional run with the locale's direction, so in Arabic or Hebrew a
  negative amount is the positive one with a sign, and nothing else moves.
- `signDisplay` is `auto` (a minus when negative), `exceptZero` (a plus too, for a change) or
  `never` (for a column whose heading says the direction).
- `secondary` is the USD or USDC equivalent, shown under the amount in a smaller size. Screen
  readers hear it as "equal to"; `secondaryLabel` changes the words.

`AmountProvider` sets the locale for everything inside it. Principal views also pass the currencies
of the principal's corridors once, at the top:

```tsx
<AmountProvider locale="en" corridorCurrencies={['USD', 'COP', 'NGN']}>
```

When two of those print as `$`, every dollar amount carries its ISO code (`$96.00 USD`,
`$1,500.00 COP`), decided by the core `dollarSignAmbiguous`. It is the corridors and not the rows on
screen, so filtering a table never changes how its amounts read. Recipient surfaces never set the
corridors and keep the plain sign.

When a corridor in a new currency is added, check its sign against JetBrains Mono. The second mono
face carries exactly the four signs the brand face lacks today; a sign neither face draws falls to
a system font at another width, and the column drifts again until the sign is added to the subset.

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

Fonts are self-hosted; no page loads a font from a font CDN at runtime. The three faces below are set up with `next/font` in each app. The second mono face, further down, ships inside this package. All four are under the SIL Open Font License 1.1.

| Role                                   | Face           | Weights       | CSS variable the app sets     |
| -------------------------------------- | -------------- | ------------- | ----------------------------- |
| Display, marketing headlines only      | Nunito         | 800           | `--ujira-font-nunito`         |
| Interface and body                     | Inter          | 400, 500, 600 | `--ujira-font-inter`          |
| Amounts, codes, labels, always tabular | JetBrains Mono | 400, 500      | `--ujira-font-jetbrains-mono` |

In each app, load the faces with `next/font/local`, from files a lockfile pins. Never use `next/font/google`: it downloads at build time, and the same commit has built with different font files, which draws text differently from the visual baselines at random. `apps/dashboard/src/app/layout.tsx` shows how, pass `variable` with the names above and `subsets: ['latin', 'latin-ext']` so Hausa, Yoruba and Igbo diacritics render, and put the three `variable` class names on `<html>`. The token stacks (`--ujira-font-display`, `--ujira-font-sans`, `--ujira-font-mono`) fall back to system faces until then.

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

Both faces advance 0.6 em per character, so once the subset has loaded a column of amounts keeps one width whichever face draws the sign. Before that it does not: a range limited face is not fetched until a character in its range is needed, and `font-display: swap` paints the first amount with the next face in the stack, at that face's width. So the first naira on a cold page can sit a few pixels wide of the column for a frame. Keeping the amount visible is the right trade, and a blocking `font-display` would hide it instead; a page that always shows one of these currencies can preload `@ujira/ui/fonts/noto-sans-mono-currency-signs.woff2` itself.

The subset and its `unicode-range` come from the `font.mono.signs` tokens in `tokens/system.json`; run `pnpm --filter @ujira/ui tokens` after changing them. `src/fonts/fonts.test.ts` fails if the range stops being those four code points, if the file grows past 10 KB, if the subset draws anything else, if a sign loses the mono advance, if the licence text goes missing, or if the signs face stops coming before the app variable in the stack, in the typed constants and in `tokens.css` alike. Those last two are what stop the ordering regressing: a test that only looked for the family in the stack passed while the bug was live.

The stack order is a package level guarantee, but only an app can prove it end to end, because the metric fallback family only exists once a font loader has run. That check belongs with the dashboard font tests in #305, which already load a real page and watch what it fetches.

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
