# @ujira/embed

The onboarding widget recipients use inside the integrator's own product. One script tag, one custom element, no framework needed on the page.

```html
<script type="module" src="/ujira-embed.js"></script>

<ujira-onboarding mode="light" locale="en"></ujira-onboarding>
```

The file is built from `src/index.ts`; the hosted address integrators point at arrives with the release pipeline.

This first slice is the shell: the step framework, the theme contract, the English copy and the browser tests. The answers are handed to the page through an event; saving them through the API comes with the recipient endpoints.

## Layout

| Path                              | What it is                                                                 |
| --------------------------------- | -------------------------------------------------------------------------- |
| `src/index.ts`                    | The script tag entry point. Loading it defines the element                 |
| `src/onboarding-element.ts`       | The element: state, events, mode and locale                                |
| `src/steps.ts`                    | Step order, progress and the check that runs before a step is left         |
| `src/methods.ts`                  | The payout methods and the one field each of them needs                    |
| `src/views/`                      | One view per step, plus the pieces they are built from                     |
| `src/i18n/en.ts`                  | Every word a person reads                                                  |
| `src/theme/defaults.generated.ts` | Generated. The default value of every custom property                      |
| `src/brand/mark.generated.ts`     | Generated. The 16px mark for the footer line                               |
| `tokens/generate.ts`              | Turns the shared tokens and the vendored mark into the two generated files |
| `tools/`                          | The bundler, the size check, the test server and the screenshot script     |
| `e2e/`                            | A plain HTML host page and the browser tests                               |

After changing the shared tokens or the mark, regenerate and commit the output:

```sh
pnpm --filter @ujira/embed brand
```

## Theming

The integrator owns the look. Every colour, radius and font is a custom property set on the element or on any ancestor of it, so a rule on the host page always wins:

```css
#payout-setup {
  --ujira-embed-accent: #005ab4;
  --ujira-embed-on-accent: #ffffff;
  --ujira-embed-radius-card: 2px;
  --ujira-embed-font: 'Graphik', system-ui, sans-serif;
}
```

| Property                          | What it paints                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ujira-embed-surface`           | The card and the inputs                                                                                                                                                                                                                                                                                                                                                               |
| `--ujira-embed-rule`              | Hair lines between parts of the card                                                                                                                                                                                                                                                                                                                                                  |
| `--ujira-embed-field-border`      | The edge of an input or a choice, kept at 3:1 on the surface                                                                                                                                                                                                                                                                                                                          |
| `--ujira-embed-text`              | Four things: headings and answers, and the three marks on a chosen payout method, its dot, its border and its inner ring. Keep it clear of your field border or chosen and unchosen will look alike; the radio changes shape when chosen, so selection is never colour alone                                                                                                          |
| `--ujira-embed-text-secondary`    | Hints, labels and the footer line                                                                                                                                                                                                                                                                                                                                                     |
| `--ujira-embed-accent`            | The fill of the one action on each step                                                                                                                                                                                                                                                                                                                                               |
| `--ujira-embed-accent-hover`      | The fill of that action under the pointer. A brand value, never mixed from your text colour                                                                                                                                                                                                                                                                                           |
| `--ujira-embed-link`              | Text links, back and change. The body text colour, not the accent: saffron marks the one thing to do, and these go back                                                                                                                                                                                                                                                               |
| `--ujira-embed-on-accent`         | The label on the action                                                                                                                                                                                                                                                                                                                                                               |
| `--ujira-embed-error`             | The problem message and its border                                                                                                                                                                                                                                                                                                                                                    |
| `--ujira-embed-focus`             | The focus ring. There are two layers so the ring survives any ground: this one carries it on dark, the band carries it on light. A colour your page cannot resolve, such as a var() naming a token you never defined, is ignored and the default ring is drawn. A valid colour is always used, so setting both to your surface colour, or to transparent, hides the ring on your page |
| `--ujira-embed-focus-inner`       | The band drawn in the gap behind the ring. Between the two, one of them must reach 3:1 against the surface and against the action's fill, which are the grounds a ring has to work on                                                                                                                                                                                                 |
| `--ujira-embed-focus-width`       | How thick the ring is. Floored at 2px where it is used: thicker is yours to choose, absent is not, because zero would remove the keyboard focus indicator                                                                                                                                                                                                                             |
| `--ujira-embed-focus-offset`      | How far the ring sits from the control. This is the gap only; it does not size the band. Held between 0 and 8px where it is used, so a negative value cannot pull the ring inside the control                                                                                                                                                                                         |
| `--ujira-embed-focus-inner-width` | How thick the band is. Floored at 1px where it is used, because a band of nothing takes the ring's contrast with it on a light ground. Its default is generated from the offset, so the two start equal and the gap is filled; they are not linked at runtime, so changing the offset does not move the band. Set both if you want a tighter ring that still has one                  |
| `--ujira-embed-radius-card`       | The card                                                                                                                                                                                                                                                                                                                                                                              |
| `--ujira-embed-radius-control`    | Inputs, choices and the action                                                                                                                                                                                                                                                                                                                                                        |
| `--ujira-embed-font`              | Everything except codes                                                                                                                                                                                                                                                                                                                                                               |
| `--ujira-embed-font-mono`         | Codes, addresses and small capital labels                                                                                                                                                                                                                                                                                                                                             |
| `--ujira-embed-ease`              | The one easing curve                                                                                                                                                                                                                                                                                                                                                                  |

Every property above is painted by something, and a test fails if one stops being: a property you can set that changes nothing is a promise the widget cannot keep. One was removed for that reason, the ground behind the card, since that ground belongs to your page and the widget never touches it.

That table is checked against the code too, both ways, so a property cannot be added without being documented or documented without existing. The undocumented property that found worth adding this check was one added in the same change that introduced the rule.

Defaults are the UJIRA light tokens. `mode="dark"` switches to the dark set, and `mode="system"` follows the reader's setting. Set the properties yourself and the mode stops mattering.

Parts are exposed for anything the properties do not cover: `widget`, `chrome`, `progress`.

The widget carries no UJIRA branding beyond one footer line, "Payouts by UJIRA", with the mark at 16px in the surrounding text colour.

## What the shadow root does and does not do

The widget runs in your page's realm, not in a sandbox. Its shadow root is open. It scopes our rules so they do not land on your page, and it stops your page's selectors reaching our elements, but it is not a wall: inherited properties and custom properties cross into it by design, which is exactly how the theming above works. And it hides nothing: your page can reach into the root, read what a recipient types as they type it, and observe every event the widget fires. Nothing is hidden from you, which is the point, since the answers are yours to save.

If you need a recipient's answers kept from your own page, a shadow root is not the mechanism and no option here provides one. Load the widget in a cross origin iframe instead.

## Attributes and properties

| Name     | Type                      | Default | What it does                                                |
| -------- | ------------------------- | ------- | ----------------------------------------------------------- |
| `mode`   | `light`, `dark`, `system` | `light` | Which set of default colours to use                         |
| `locale` | language tag              | `en`    | Which language file to read. Unknown languages give English |
| `busy`   | boolean                   | `false` | Holds the step and says the answer is being saved           |
| `error`  | string                    | empty   | A message from the integrator, shown in place of ours       |

`reset()` starts again from the first question. `finish()` moves to the confirmation screen. `currentStep` and `currentAnswers` read the state.

## Events

| Event                       | Detail                          | When                       |
| --------------------------- | ------------------------------- | -------------------------- |
| `ujira-step-change`         | `{ step, position, total }`     | The step on screen changed |
| `ujira-onboarding-complete` | `{ name, method, destination }` | The last answer is given   |

Both bubble and cross the shadow boundary. Cancel `ujira-onboarding-complete` to keep the widget on the review step while you save:

```js
const widget = document.querySelector('ujira-onboarding');

widget.addEventListener('ujira-onboarding-complete', async (event) => {
  event.preventDefault();
  widget.busy = true;
  try {
    await save(event.detail);
    widget.finish();
  } catch (problem) {
    widget.error = 'We could not save that. Try again in a moment.';
  } finally {
    widget.busy = false;
  }
});
```

## Payout methods

One method is open today: USDC to the recipient's own wallet. Bank transfer, mobile money and cash pickup are built behind the same step and switched off, so opening one is a change to `open` in `src/methods.ts` and nothing else. The step states a single method rather than offering a choice of one.

Recipients paid in local currency see only their own currency. The wallet method is the one place USDC appears, because that is what the person chose.

## Copy

Every string is in `src/i18n/en.ts`. A test fails if any word a person reads is typed into a template, and another fails if a key in the catalogue is never used. Other languages are a file next to `en.ts`, registered in `catalogue.ts`, each with native speaker review before it ships.

## Checks

```sh
pnpm --filter @ujira/embed size          # 60 KB gzipped budget
pnpm --filter @ujira/embed test          # flow, views, copy and tokens
pnpm --filter @ujira/embed e2e           # theming, axe, 320px, 3G
pnpm --filter @ujira/embed screenshots <folder>
```

The browser tests run against the built file on a plain HTML page.

The visual baseline is rendered on Linux and only the Linux one is committed, because that is the platform CI compares on. CI is the only thing that renders it: the `embed` job writes the image when it is missing or changed, and uploads it in the `embed-playwright-report` artifact. To refresh it after an intended change, let CI run, download that artifact, look at the image, and commit it with what changed and why. A run on macOS or Windows writes its own baseline next to it, which git ignores.

The baseline is Linux only, so it cannot show a difference that appears solely with a font the CI image does not carry. Seeing that class of defect needs rendering on the platforms people actually use, which is tracked separately and not solved here.
