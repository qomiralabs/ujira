# @ujira/dashboard

The principal dashboard: where mandates are set, funded, approved and watched. This first slice is the shell every screen shares. The sections are in place with what each will show; the screens themselves arrive in later issues.

Next.js App Router, TypeScript strict, Tailwind CSS v4 through the `@ujira/ui` token build, Radix primitives, `cmdk`, `nuqs` and Lucide.

## Run it

```sh
pnpm install
pnpm --filter @ujira/dashboard dev        # http://localhost:3000
```

The root gate builds and checks it with everything else: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. `pnpm build` runs `next build` for this app.

## Layout

| Path                   | What it is                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/app/`             | Routes: Overview at `/`, one folder per section, loading, error and not found                                         |
| `src/shell/`           | The frame: rail, drawer, project switcher, top bar, command palette, theme                                            |
| `src/shell/nav.ts`     | The ten sections, their icons and one line each on what they are for                                                  |
| `src/patterns/`        | Page header, empty state, error state, skeletons and button styles                                                    |
| `public/brand/`        | The reverse colourway lockup and mark from the brand kit, provenance stripped                                         |
| `e2e/`                 | Playwright flows, axe checks and visual snapshots, with the Linux baselines                                           |
| `scripts/e2e-linux.sh` | Runs Playwright in the CI image, or re-renders the baselines with `--update`                                          |
| `lighthouserc.json`    | Lighthouse CI: accessibility and best practices gate at 0.95, CLS at 0.05; performance and blocking time are reported |

## Shell

- **Rail.** Always teal, in both modes, so it carries the brand's reverse colourway and scopes the dark tokens to itself with `data-theme="dark"`. Collapses to icons from the button at its foot; the choice is kept in `localStorage` and applied by an inline script before first paint, so a reload never flashes. Below 768px it becomes a drawer, a native modal `<dialog>`.
- **Icons.** The nine brand ideas use `BrandIcon` from `@ujira/ui`. Everything else is Lucide, always through `src/shell/icon.tsx`, which fixes the 1.5px round stroke.
- **Project.** Every view is scoped to the project in `?project=`, read and written with `nuqs`, and every link keeps it. The default project adds nothing to the URL. The list is sample data until the projects API lands.
- **Theme.** Follows the system setting. The switch in the top bar picks light or dark instead, sets `data-theme` on `<html>` and remembers it; "Match system" removes it again.
- **Command palette.** Cmd K or Ctrl K, or the search button. Jumps to any page today; payout, recipient and receipt search joins it with those screens.
- **Loading and errors.** `loading.tsx` shows a skeleton the shape of the page. `error.tsx` says what happened and what to do, with the reference to quote to support. `global-error.tsx` covers a failure of the frame itself.

## Browser checks

Build first, since Playwright and Lighthouse run against `next start`:

```sh
pnpm build
pnpm --filter @ujira/dashboard exec playwright test   # flows, axe in light and dark, snapshots
pnpm --filter @ujira/dashboard exec lhci autorun      # needs Chrome or CHROME_PATH
pnpm budget:check                                      # 250 kB gzipped per route
pnpm page:report                                       # every sample, median and spread
scripts/replay-page-samples.sh                         # the self test for the arrangement
```

Visual baselines are rendered on Linux x64, the platform CI uses, so they fail on macOS and Windows. Run the suite, or re-render the baselines after an intended change, in the CI image with Docker:

```sh
apps/dashboard/scripts/e2e-linux.sh            # the full suite
apps/dashboard/scripts/e2e-linux.sh --update   # writes e2e/__screenshots__
```

Look at every changed image before committing it.

## Page measurement

Lighthouse CI collects three runs of three routes and judges the median of each metric. Two of its five assertions are warnings rather than errors:

| Metric                      | Bar    | What it does    |
| --------------------------- | ------ | --------------- |
| `categories:accessibility`  | 0.95   | fails the build |
| `categories:best-practices` | 0.95   | fails the build |
| `cumulative-layout-shift`   | 0.05   | fails the build |
| `categories:performance`    | 0.9    | reported only   |
| `total-blocking-time`       | 200 ms | reported only   |

The performance category is a composite, and four audits are scored only inside it: `largest-contentful-paint`, `first-contentful-paint`, `speed-index` and `interactive`. Nothing asserts any of them on its own, so the one line that reports the category rather than failing on it takes the only guard off all four. The report prints that list beside the demotion rather than leaving it to be inferred from a diff.

Those last two are reported because the instrument is noisier than its own margin. Three runs of one route in one job, from bytes proved identical to the branch it was compared against, scored 0.79, 0.75 and 0.91 with 512.5, 651.2 and 136.5 ms of blocking time. The spread of 0.16 is wider than the 0.11 between the failing median and the bar, so a failure said nothing about whether the page had regressed, while teaching everyone to re-run the job until it passed. Those three runs are kept in `scripts/fixtures/page-performance/recorded-samples`, and `scripts/replay-page-samples.sh` replays them through the real assert command in both directions: the committed config must not fail them, and the same samples with both bars set to error must fail, so the first result means something. CI runs it before the measurement.

The gate on page weight is the route bundle budget below, which counts bytes and is deterministic. That is a proxy: a change that slows a route without growing it is reported and not failed. What is still failed is everything that does not depend on a runner's mood, which is the accessibility, best practices and layout stability of every route.

The report also prints `total-byte-weight` and `dom-size` with no bar. Those are the candidates to gate on in place of the two reported metrics: across three runs of one commit, `dom-size` was identical on every route and `total-byte-weight` moved by one to three bytes on each of them, against totals of about 392 kB for the overview and about 388 kB for the other two, while the median blocking time of the same bytes moved by more than three times. They stay unbarred until there is enough spread data to set a tolerance, and printing them is how that data accumulates.

`pnpm page:report` prints every sample of every asserted metric with its median, its spread and its bar, so the next investigation starts from data rather than from a pass or a fail. It also fails when the measurement is incomplete: a route that produced no report, fewer runs than the config asks for, a metric that stopped being collected, or a report file named something the assert command silently ignores. That last group matters more than it looks: `lhci assert` exits 0 against an empty report folder, so the page measurement could pass having measured nothing at all.

## Route bundle budget

`pnpm budget:check` reads the route list `next build` writes to `.next/diagnostics/route-bundle-stats.json`, gzips each route's first load chunks and fails when any route is over 250 kB. It fails closed: missing stats, a missing chunk or a chunk outside `.next/static` is an error, not a skip.

To prove the check can fail, CI builds once more with `UJIRA_BUDGET_FIXTURE=1`. That adds `src/app/budget-fixture/`, a route that imports every Lucide icon and loads about 384 kB, and CI requires the check to reject it by name. Files ending in `.fixture.tsx` are only pages when that variable is set, so the route never exists in a normal build.
