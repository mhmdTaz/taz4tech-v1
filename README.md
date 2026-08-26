# Taz4Tech

Electronics retail for Lebanon. USD, cash on delivery, `en` / `ar` / `fr`.

Single store, multi-tenant-ready: every document carries a `storeId` and every
repository filters on it, so a second store is configuration rather than a
migration.

---

## Getting started

```bash
pnpm install
cp .env.example .env.local     # fill in MONGODB_URI
pnpm seed                      # creates the store settings document
pnpm dev
```

Then open <http://localhost:3000> — you will be redirected to `/en`.

Requires Node 24.11.x (see `.nvmrc`) and pnpm 9.

---

## Architecture

Four rings. **Dependencies point inward only**, and CI fails the build if one
points outward.

```
src/app/          Next.js. Delivery only: parse input, call one use case, render.
src/composition/  The one place that knows everything. Builds the object graph.
src/modules/      Per-domain business logic. domain / application / infrastructure / contracts
src/platform/     Result, Money, ids, clock, logger, config, flags, mongo
src/ui/           Design system. Pure components, no data fetching.
src/i18n/         Locale routing and message loading.
```

Inside a module the same rule applies again:

```
domain  <-  application  <-  infrastructure
```

The **domain** knows nothing — no framework, no IO, no database driver. It is the
layer that carries genuine 100% coverage, because it is the layer where being
wrong is silent.

The **application** layer holds every decision. This is deliberate: async Server
Components cannot be unit tested (Next.js says so outright), so a page component
is kept to "await one use case, render the Result" and everything that could be
wrong lives one file away, where it is testable with no framework at all.

**Infrastructure** implements ports defined in `contracts/`. Swapping MongoDB for
anything else touches one folder.

### Crossing a boundary

A module is only ever visible through its barrel:

```ts
import { createStoreModule } from '@modules/store';        // yes
import { makeGetStoreSettings } from '@modules/store/application/…';  // build fails
```

Each module exposes a `createXModule({ db, storeId })` factory that wires its own
adapters. The composition root passes in platform services and gets use cases
back — it never sees a repository or a collection name.

### Errors

```
Expected failure    ->  Result.err(...)   "that variant is out of stock"
Unexpected failure  ->  throw             "Atlas is unreachable", "bug"
```

Expected failures are part of a use case's contract, so they belong in its type
signature where the compiler forces the caller to handle them.

### Money

Never a float. Every amount is an integer count of cents, because `0.1 + 0.2`
is not `0.3` and an order total that is off by a cent is an argument at the
customer's door. Parsing reads fractional digits as characters rather than
through `parseFloat`, which would turn `"1.115"` into 111 cents instead of 112.

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server |
| `pnpm build` | Production build |
| `pnpm verify` | typecheck + lint + boundaries + boundary probes + unit tests |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` / `pnpm lint:fix` | Biome |
| `pnpm boundaries` | Architecture rules |
| `pnpm boundaries:verify` | Proves each architecture rule can still fail |
| `pnpm test` | Unit tests |
| `pnpm test:unit` | Unit tests with per-directory coverage gates |
| `pnpm test:integration` | Against a real MongoDB (see below) |
| `pnpm test:e2e` | Playwright, all locales, axe included |
| `pnpm bundle:budget` | Fails if client JS crosses its ceiling |
| `pnpm seed` | Writes the store settings document |

### Running the integration tests

They need a real MongoDB — they assert on `explain()` output, which no in-memory
fake reproduces.

```bash
docker run -d --rm --name taz4tech-mongo -p 27017:27017 mongo:8.0
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 pnpm test:integration
```

---

## The quality gate

Eleven checks per PR (`.github/workflows/ci.yml`). Three of them exist because a
green check is not the same as a working check:

- **`pnpm boundaries:verify`** plants a deliberate violation per architecture rule
  and fails if any rule stays silent. Two of the sixteen rules were inert when
  first written — they matched the import specifier while dependency-cruiser
  matches the *resolved* path, which under pnpm is
  `node_modules/.pnpm/mongodb@7.6.0_…/node_modules/mongodb/lib/index.js`. Both
  passed on a codebase that violated them.
- **Coverage is gated per directory**, not globally. A single global threshold
  lets fully-covered utility code pay for an untested use case. The exclude list
  is `src/modules/*/index.ts` — *not* `src/**/index.ts`, which would silently
  exclude every platform primitive, since `result`, `money`, `ids`, `clock`,
  `logger`, `config` and `flags` are all `index.ts`.
- **The integration suite carries a negative control** that asserts an unindexed
  query *does* produce a `COLLSCAN`. Without it, a plan walker returning the
  wrong shape would make every "no COLLSCAN" assertion pass vacuously.

---

## Things worth knowing

**Next 16.** `next` is pinned exact at `16.3.3` — the release that patches an AVIF
decoder RCE. AVIF is disabled as part of that patch, so `images.formats` lists
WebP only, and Lighthouse's `modern-image-formats` audit is turned off because it
would penalise the app for the security fix.

**Cache Components** is on, so nothing is cached unless a boundary says so — the
right default for a storefront where a stale price is worse than a slower render.
It also forbids reading a dynamic source outside `<Suspense>`. next-intl resolves
the locale through `headers()`, which counts, so both the layout and the page
call `setRequestLocale(locale)` to supply it from the route param instead. Without
that call every route drops from `◐` (partial prerender) to `ƒ` (dynamic) and the
static shell is lost — silently, with a green build.

**`middleware.ts` is `proxy.ts`** in Next 16. The old name still works but is
deprecated.

**Phone number is the customer identity** — order lookup, history, loyalty and
referrals all key on it. That makes it the most sensitive field in the database,
so the logger redacts it by default and keeps only the last two digits.

**Time.** Everything is stored in UTC and displayed in `Asia/Beirut`, which
observes DST. `storeDate()` builds the store-local day from `Intl` parts rather
than slicing an ISO string, so "Tuesday's deliveries" means Tuesday in Beirut
regardless of where the server runs.

---

## Open decisions

- **`allocate()`** in `src/platform/money/allocate.ts` is unimplemented. Splitting
  a cart discount across line items without losing a cent is an accounting policy
  choice, not a mathematical one. The tests in `allocate.test.ts` already pin
  every invariant and are marked `describe.skip` until it is written.
- **VAT.** 11% is configured. Whether this store must register depends on the
  LBP 5bn threshold; advisory sources claim importers must register regardless of
  turnover, but that is not primary-sourced and needs a Lebanese tax adviser.
- **Stryker** mutation testing on the domain layer lands in Phase 1, per the plan.

*General information from primary sources, not legal advice.*
