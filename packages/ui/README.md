# @ujira/ui

The UJIRA design system, shared by the dashboard and the website. This first slice holds the design tokens, the nine brand icons and the font setup notes. Primitives, charts and payment components come later.

## Layout

| Path                                 | What it is                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `assets/brand/Tokens.json`           | Brand colour tokens, copied unchanged from the brand kit                                                                           |
| `assets/brand/ujira_icon-sprite_...` | Brand icon sprite, copied unchanged from the brand kit                                                                             |
| `tokens/system.json`                 | Design system tokens on top of the brand: density, radius, focus, shadow, motion, fonts, type scale and data visualisation colours |
| `tokens/generate.ts`                 | Turns the three sources into the generated files below                                                                             |
| `tokens/build.ts`                    | Writes the generated files                                                                                                         |
| `styles/tokens.css`                  | Generated. CSS custom properties, light and dark                                                                                   |
| `styles/theme.css`                   | Generated. Tailwind CSS v4 `@theme` block, imports `tokens.css`                                                                    |
| `src/tokens/tokens.generated.ts`     | Generated. Typed constants with the same values                                                                                    |
| `src/icons/brand-icons.generated.ts` | Generated. The nine icon names and their shapes, read from the sprite                                                              |
| `src/icons/brand-icon.tsx`           | `<BrandIcon name="payout" />`                                                                                                      |

## Tokens

Never type a brand hex value by hand. Colours come from `assets/brand/Tokens.json`; `tokens/system.json` refers to them as `{core.teal}`, `{neutral.mist-300}`, `{status.paid.fill}` or `{mode.rule}`. The only literal hex values in `system.json` are the data visualisation steps the brand palette does not have, and a test fails if one of them duplicates a brand colour.

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

### Tailwind CSS v4

```css
@import 'tailwindcss';
@import '@ujira/ui/styles/theme.css';
```

The theme drops the Tailwind default colours, fonts, type sizes, radii, shadows and easings, so only brand values produce utilities: `bg-surface`, `text-text-secondary`, `border-rule`, `bg-accent`, `text-paid`, `rounded-control`, `rounded-card`, `rounded-overlay`, `shadow-overlay`, `font-mono`, `text-amount-xl`, `h-row`, `ease-out`, `ease-settle`, `outline-focus`. Utilities read the `--ujira-*` variables directly, so they switch with the mode without a rebuild.

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

`name` accepts only the nine brand icons: `mandate`, `payout`, `recipient`, `approval`, `receipt`, `rail`, `local-currency`, `agent`, `pause`. The icon draws with a 1.5px round stroke in `currentColor` on the 24px grid; set its colour with a text colour class. The shapes are rendered inline from the sprite, so the icon works in server components and inside shadow DOM without a sprite request. Apps that prefer the sprite file can import `@ujira/ui/assets/brand-icons.svg`. For every other interface icon use Lucide with `strokeWidth={1.5}`.

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

`assets/brand/Tokens.json` and `assets/brand/ujira_icon-sprite_all_currentcolor.svg` are internal UJIRA brand material owned by Qomira Labs, copied byte for byte from the brand kit. They are not third party assets and carry no open source license. Update them only from a new brand kit release, then regenerate.
