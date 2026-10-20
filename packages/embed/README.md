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

| Property                       | What it paints                                               |
| ------------------------------ | ------------------------------------------------------------ |
| `--ujira-embed-bg`             | The ground behind the card                                   |
| `--ujira-embed-surface`        | The card and the inputs                                      |
| `--ujira-embed-rule`           | Hair lines between parts of the card                         |
| `--ujira-embed-field-border`   | The edge of an input or a choice, kept at 3:1 on the surface |
| `--ujira-embed-text`           | Headings and answers                                         |
| `--ujira-embed-text-secondary` | Hints, labels and the footer line                            |
| `--ujira-embed-accent`         | The fill of the one action on each step                      |
| `--ujira-embed-accent-text`    | Text links, such as back and change                          |
| `--ujira-embed-on-accent`      | The label on the action                                      |
| `--ujira-embed-error`          | The problem message and its border                           |
| `--ujira-embed-focus`          | The focus ring, with `--ujira-embed-focus-inner` behind it   |
| `--ujira-embed-radius-card`    | The card                                                     |
| `--ujira-embed-radius-control` | Inputs, choices and the action                               |
| `--ujira-embed-font`           | Everything except codes                                      |
| `--ujira-embed-font-mono`      | Codes, addresses and small capital labels                    |
| `--ujira-embed-ease`           | The one easing curve                                         |

Defaults are the UJIRA light tokens. `mode="dark"` switches to the dark set, and `mode="system"` follows the reader's setting. Set the properties yourself and the mode stops mattering.

Parts are exposed for anything the properties do not cover: `widget`, `chrome`, `progress`.

The widget carries no UJIRA branding beyond one footer line, "Payouts by UJIRA", with the mark at 16px in the surrounding text colour.

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

The browser tests run against the built file on a plain HTML page. Visual baselines are kept per platform and only the Linux ones are committed, because those are the ones CI compares against.
