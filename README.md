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
| `pnpm seed:demo` | Loads demo products (fixtures, never for Atlas) |
| `pnpm import:catalogue <file.xlsx>` | Dry-run a catalogue import; add `--commit` to apply |

### Running the integration tests

They need a real MongoDB — they assert on `explain()` output, which no in-memory
fake reproduces.

```bash
docker run -d --rm --name taz4tech-mongo -p 27017:27017 mongo:8.0
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 pnpm test:integration
```

---

## The quality gate

Eleven checks per PR (`.github/workflows/ci.yml`). Four of them exist because a
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
- **Design tokens are contrast-checked in the unit suite**
  (`src/ui/palette-contrast.test.ts`). `--color-faint` shipped at 3.18:1 and was
  only caught by axe five minutes into CI, inside a Playwright shard that first
  needed a Mongo container and a Chromium download. The arithmetic needs none of
  that and now runs in 200ms.

The build artifact is deliberately **not** passed between jobs. `.next` is a
hidden directory and `upload-artifact` skips hidden files by default — reporting
it as a *warning*, so the build job goes green having uploaded nothing and every
downstream job dies on a missing artifact. Each job that needs a running app
builds its own; at ~25s in parallel that is also faster than one upload and five
downloads.

The blocking `pnpm audit` covers **production dependencies only**. The current
high advisories are all transitive through `@lhci/cli`, which never leaves the
runner, and one of them (`extract-zip`) has no patched version at all. A second
non-blocking step keeps the dev findings visible rather than suppressed.

---

## Things worth knowing

**Next 16.** `next` is pinned exact at `16.3.3` — the release that patches an AVIF
decoder RCE. AVIF is disabled as part of that patch, so `images.formats` lists
WebP only, and Lighthouse's `modern-image-formats` audit is turned off because it
would penalise the app for the security fix.

**Cache Components is OFF**, reversing the plan's original choice — on evidence.
Partial prerendering flushes a shell before the dynamic part runs, so on a product
page the HTTP status is committed as 200 before the database says whether the
product exists. Measured here:

```
cacheComponents: true   ->  200 + "not found" body   (a SOFT 404)
cacheComponents: false  ->  404
```

A storefront that answers 200 for every archived or mistyped product URL teaches
search engines that its 404s are real pages. Neither escape hatch works:
`dynamic: 'force-dynamic'` is rejected as incompatible, and `instant: false`
controls *prefetching*, not response blocking — it silences the build error while
leaving the soft 404 in place, which is worse than no fix. The plan's actual goal
survives: it wanted caching opt-in "because a stale price is worse than a slower
render", and Next 15+ already defaults to uncached data, so this costs the
prerendered shell rather than price freshness.

`setRequestLocale(locale)` is still called in every layout and page. next-intl
otherwise resolves the locale through `headers()`, which makes the route dynamic
for a reason that has nothing to do with the data it renders.

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

## The storefront

```
/[locale]/products             listing, cursor-paginated
/[locale]/products/[slug]      product detail
```

**Variant selection is a URL, not client state.** Each option value is a link
setting `?variant=<sku>`, so every combination is shareable, crawlable and works
with JavaScript disabled or still downloading. An unavailable combination renders
as disabled rather than disappearing — a customer who picks Silver should see
that 512GB does not exist, not watch an option vanish.

**The canonical URL never points at a variant.** Every variant renders
substantially the same page; letting them compete as separate URLs splits the
ranking signals between them.

**JSON-LD is built by a tested pure function**, not assembled in the component.
A multi-variant product emits `AggregateOffer` with the real low/high — a single
`Offer` would advertise a price most buyers cannot get, which is the mismatch
Merchant Center suspends accounts over. Availability is passed in rather than
assumed, so wiring real stock in Phase 2 is a parameter change in one place.

Demo fixtures live in `pnpm seed:demo`, deliberately separate from `pnpm seed`:
store settings are real configuration, three fake laptops are not. The fixtures
cover the awkward shapes on purpose — an incomplete variant matrix, a live offer,
a product with no imagery, and a draft that must stay hidden.

## Collections

```
/en/collections
/en/collections/laptops?brand=Lenovo&q=ideapad
```

**A collection is a saved query plus pinned products** — not a copy of a product
list. It holds the same filter vocabulary the listing page uses, so a collection
page inherits search, facets, pagination and every empty state unchanged rather
than growing a second listing path that drifts from the first. Import fifty new
Lenovo laptops and "Laptops" contains them, with nobody editing anything.

**Membership is `(matches the rules) OR (is pinned)`; the customer's filters are
ANDed on top.** That nesting is the whole design: a pinned product must appear in
its collection even though no rule selects it, and must still disappear when the
customer filters to something it does not match. A pinned Dell cannot survive
"Lenovo only".

**A collection with neither rules nor pinned products is rejected** — it can never
contain anything, and publishing navigation that leads to an empty page reads to
a customer as a broken site rather than an empty category.

Pinned ids are checked to exist on write. A dangling id is otherwise silent: the
collection just shows one product fewer than the curator arranged.

## Search and facets

```
/en/products?q=laptop&brand=Lenovo&opt.Colour=Black&min=100&max=500
```

**Every filter is a link, and every filtered view is a URL.** Nothing needs
JavaScript: the search box is a plain GET form and each facet value is an anchor.
That makes filtered views shareable, bookmarkable and crawlable, and it means the
filters work before the JS bundle has arrived.

**Cross-language synonyms are the point.** The catalogue arrives from suppliers
in English; a large share of customers search in Arabic. Without expansion,
"لابتوب" returns nothing at all from a catalogue full of laptops — not a ranking
problem, an empty shop. Arabic is normalised as well as expanded: أ إ آ all fold
to ا, ة folds to ه, and diacritics are stripped, because "شاشه" and "شاشة" are
the same word typed two ways rather than a typo.

**A facet's counts ignore that facet's own selection.** Choosing Lenovo must not
collapse the brand list to Lenovo alone, or the customer cannot switch to Dell
without first clearing the filter. Every *other* facet does narrow, which is what
makes browsing feel responsive.

**A price range requires ONE variant to satisfy both bounds.** A product with a
$200 and a $900 variant does not match "between $400 and $500" — a naive filter
matches it because one variant clears the lower bound and a different one clears
the upper, showing a product with nothing in the range asked for.

Search rides a MongoDB text index over a `searchText` field derived on write.
`default_language: 'none'` turns stemming off deliberately: the stemmers are
per-language, Arabic is not among them, and normalisation has already folded both
sides into the same shape.

Relevance ranking is **not** implemented — results are newest-first, cursor
paginated like the rest of the listing. Recall matters more than ordering at this
catalogue size, and one pagination model is worth keeping.

## The admin area

```
/admin/import
```

**It exists only when it is configured.** `ADMIN_PASSWORD` and
`ADMIN_SESSION_SECRET` are set together or not at all: unset, every `/admin` URL
is a 404 and there is no write surface on the internet. Set only one and the app
refuses to boot — treating that as "admin off" would silently ignore a password
the operator believes is protecting the site, and treating it as "admin on"
would run the session signer with no secret.

**One operator, one password, one signed cookie.** There are no user accounts to
model yet, and a users collection built before knowing who else will ever log in
is the wrong shape guessed early. Sessions are HMAC-signed tokens rather than
rows in a table: with one operator, revocation means rotating
`ADMIN_SESSION_SECRET`, which invalidates every outstanding token at once.

**The check lives on the page and on the action, never only in a layout or in
middleware.** A layout is not a security boundary — client-side navigation can
render a page without re-running it, and a Server Action is invoked by URL with
no page render at all. Middleware is not one either; CVE-2025-29927 was a header
that made Next skip it entirely. `requireAdmin()` sits where nothing in the
framework's routing can route around it.

Login is throttled per address **and** globally, because `X-Forwarded-For` is
client-supplied and an attacker with many addresses defeats the first limit. The
global limit means a determined attacker can lock the operator out for fifteen
minutes — a denial of service accepted deliberately, in exchange for the password
not being guessable.

## The Excel importer

The admin screen at `/admin/import`, and the same thing from a terminal:

```bash
pnpm import:catalogue catalogue.xlsx            # dry run — prints the plan, writes nothing
pnpm import:catalogue catalogue.xlsx --commit   # applies it
```

Named `import:catalogue` rather than `import` because **`pnpm import` is a
built-in pnpm command** — it replaces the pnpm lockfile with one imported from
npm or yarn, and it deletes the existing lockfile before it fails.

**One row is one VARIANT, not one product.** Rows sharing a slug — explicit, or
derived from the English title — become one product with several variants, which
is how real catalogue sheets are shaped.

**Nothing is written without `--commit`.** The dry run produces exactly the plan
a commit would apply: same parsing, same grouping, same validation. The preview
is the truth, not a rehearsal of it.

**The parsers refuse to guess.** `03/04/2026` is 3 April to a Lebanese supplier
and 4 March to an American one, and nothing in the file says which — so it is
rejected as *ambiguous* with its own message, rather than silently setting an
offer expiry eight months wrong on the field consumer protection law requires to
be accurate. Status defaults to **draft**, never active: importing four hundred
rows must not publish four hundred products because the sheet had no status
column.

**Bad rows do not block good ones.** Three bad rows out of four hundred import
three hundred and ninety-seven, with the three reported by Excel row number.

Column detection is a starting point the operator confirms, and it resolves
specific headers before general ones — "Compare at price" claims its column
before "Price" does, or every Shopify export would sell at the was-price. On the
admin screen the mapping is editable, and each field shows real values from the
sheet beside it so the right column can be recognised rather than guessed. A
mapping the server cannot parse is **refused**, never quietly re-detected:
falling back would import with a mapping the operator did not choose, which is
exactly how a "Cost" column ends up loaded as the selling price.

**A SKU already owned by another product is caught in the plan.** Rename a
product and keep its SKU: the slug changes, so the sheet reads as a create, while
the SKU still belongs to the product under the old slug. That used to reach the
unique index and fail as `E11000` *halfway through the write*, leaving a
partly-imported catalogue behind a 500. The plan now looks the SKUs up in bulk
alongside the slugs and reports the conflict with the product that owns it.

`save()` returns a `Result` rather than throwing on a uniqueness conflict, so
even a genuine race — someone else taking a SKU between the preview and the
write — costs one product and a line in the receipt, not the whole import. The
translation from Mongo's error code happens in the repository, because nothing
above it should know what 11000 means. Anything that is not a uniqueness
conflict still throws: a dropped connection must never be reported as
"397 of 400 imported".

## Open decisions

- **`allocate()`** in `src/platform/money/allocate.ts` is unimplemented. Splitting
  a cart discount across line items without losing a cent is an accounting policy
  choice, not a mathematical one. The tests in `allocate.test.ts` already pin
  every invariant and are marked `describe.skip` until it is written.
- **VAT.** 11% is configured. Whether this store must register depends on the
  LBP 5bn threshold; advisory sources claim importers must register regardless of
  turnover, but that is not primary-sourced and needs a Lebanese tax adviser.
- **Stryker** mutation testing on the domain layer lands in Phase 1, per the plan.
- **Lighthouse runs the `desktop` preset**, while most Lebanese traffic is mobile
  — the Playwright config already treats a mobile viewport as a first-class
  target. A performance gate measuring desktop is measuring the wrong device.
  Switching it makes the >= 95 bar substantially harder, so it is a deliberate
  Phase 1 decision rather than a quiet change.

*General information from primary sources, not legal advice.*
