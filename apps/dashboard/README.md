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

| Path                   | What it is                                                                      |
| ---------------------- | ------------------------------------------------------------------------------- |
| `src/app/`             | Routes: Overview at `/`, one folder per section, loading, error and not found   |
| `src/shell/`           | The frame: rail, drawer, project switcher, top bar, command palette, theme      |
| `src/shell/nav.ts`     | The ten sections, their icons and one line each on what they are for            |
| `src/patterns/`        | Page header, empty state, error state, skeletons and button styles              |
| `public/brand/`        | The reverse colourway lockup and mark from the brand kit, provenance stripped   |
| `e2e/`                 | Playwright flows, axe checks and visual snapshots, with the Linux baselines     |
| `scripts/e2e-linux.sh` | Runs Playwright in the CI image, or re-renders the baselines with `--update`    |
| `lighthouserc.json`    | Lighthouse CI: performance 0.9, accessibility and best practices 0.95, CLS, TBT |

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
```

Visual baselines are rendered on Linux x64, the platform CI uses, so they fail on macOS and Windows. Run the suite, or re-render the baselines after an intended change, in the CI image with Docker:

```sh
apps/dashboard/scripts/e2e-linux.sh            # the full suite
apps/dashboard/scripts/e2e-linux.sh --update   # writes e2e/__screenshots__
```

Look at every changed image before committing it.

## Route bundle budget

`pnpm budget:check` reads the route list `next build` writes to `.next/diagnostics/route-bundle-stats.json`, gzips each route's first load chunks and fails when any route is over 250 kB. It fails closed: missing stats, a missing chunk or a chunk outside `.next/static` is an error, not a skip.

To prove the check can fail, CI builds once more with `UJIRA_BUDGET_FIXTURE=1`. That adds `src/app/budget-fixture/`, a route that imports every Lucide icon and loads about 384 kB, and CI requires the check to reject it by name. Files ending in `.fixture.tsx` are only pages when that variable is set, so the route never exists in a normal build.
