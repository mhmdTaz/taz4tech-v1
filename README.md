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
pnpm seed                      # creates the store settings document, once
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
src/platform/     Result, Money, ids, clock, logger, config, flags, mongo, phone, regions
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

**A vocabulary two modules both need belongs in platform, not in one of them.**
Lebanon's eight governorates started in the orders domain, where an order records
where it is going. Then delivery got a price per governorate, which is a shop
policy and lives in store settings — and a module may not reach into another
module's domain. Importing the orders *barrel* would have worked and been worse:
a barrel pulls a module's infrastructure with it, so the store domain would have
depended, transitively, on the Mongo driver. `@platform/regions` is the answer
the boundary rule already suggests, and it sits beside `@platform/phone`, which
has known Lebanon's calling code since Phase 0.

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
| `pnpm build:offline` | `pnpm build` with no database reachable, the way CI builds it |
| `pnpm seed` | Creates the store settings document if there is none, and otherwise leaves it alone |
| `pnpm seed --reset` | Overwrites it with the defaults. Local databases only unless `TAZ_SEED_TARGET` names the database |
| `pnpm seed:demo` | Loads demo products. Local databases only, same override |
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

Twelve checks per PR (`.github/workflows/ci.yml`). Five of them exist because a
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
- **Mutation testing runs on the domain layer** (`pnpm test:mutation`). Line
  coverage there has been 100% since Phase 0, which answers "was this line run"
  rather than "would anyone notice if it were wrong". Stryker answers the second
  by changing the code and failing if the suite still passes. It found a real one
  immediately: the E.164 pattern on the shop's own contact number was anchored
  only at the end, so `"call me on +96170000000"` validated — and would have gone
  into a `tel:` link on every page. Nothing else in the suite noticed.
- **The mutants Stryker cannot reach are proven separately**
  (`pnpm test:mutation:static`). Code that runs once at module load — a folding
  table, a synonym index — is cached by vitest before the mutant is switched on,
  so Stryker reports it as surviving whether or not the tests would catch it.
  This applies each one to the file for real and requires the suite to fail.
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

**Indexes are created at boot, in the composition root** — not by a seed script
someone remembers to run. They were script-only until a fresh database showed
what that costs: `$text` search throws `text index required for $text query`, a
500 on the search box; and, silently, the *unique* indexes on `(storeId, slug)`
and `(storeId, variants.sku)` do not exist, so two products can hold one SKU.
Every create-versus-update decision the importer makes rests on those constraints
actually being enforced. `createIndex` is idempotent, so this is a few no-op
round trips once per process; if it fails, the container fails, the health check
fails, and the deploy is rejected while the previous version is still serving.


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
/[locale]                      the home page
/[locale]/products             listing, cursor-paginated
/[locale]/products/[slug]      product detail
/[locale]/collections          collections, and one collection
/[locale]/cart                 the cart, a cookie
/[locale]/checkout             checkout, and the confirmation
/[locale]/delivery /returns    what it costs, and what happens if it is wrong
/[locale]/terms /privacy       the written pages
/[locale]/contact              one number
/media/<sha256>                the shop's own copy of a catalogue picture
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

## Mutation testing, and three decisions closed

Four items had been sitting in *Open decisions*, one of them since Phase 1. They
do not get better by ageing.

### Would anyone notice if the domain were wrong?

Line coverage on the domain layer has been 100% since Phase 0, and that answers
*was this line run* — not *would anyone notice if it were wrong*. Stryker answers
the second by changing the code and failing if the suite still passes.

```bash
pnpm test:mutation
```

**91% of 1,322 mutants killed** when it was switched on. It found a real hole
immediately: the E.164
pattern validating the shop's own contact number was anchored at the end but not
the start, so `"call me on +96170000000"` passed — and would have gone into a
`tel:` link at the bottom of every page. Every test still passed with the `^`
removed. That one is fixed and the store domain is now at 100%.

The survivors were recorded rather than chased in that change. Every module has
since had a pass of its own — `cart`, `orders`, then `catalog` and `media`
together — and the four write-ups below are what each one turned up. Mutation
testing is a CI job with a floor that gets raised as the score does, **currently
97**, so the number can only go up.

It runs against `vitest.mutation.config.ts` — the unit project with its wrapper
removed, because Stryker's vitest runner takes a config file rather than a
project name, and a run that needed a real MongoDB for each of 1,322 mutants
would take hours.

### What mutation testing found in the cart

`cart.ts` was the weakest file on the domain layer at 84%, with forty-one
mutants no test could kill. It is at **97%** now, and the interesting part is
that only twelve of those forty-one were missing tests.

**Six were error tags nobody asserted.** Every refusal was checked as
`{ ok: false }` and never for *which* failure it was, so emptying the error
object entirely — `{ tag: 'quantity_out_of_range', quantity, max }` to `{}` —
broke nothing. A caller switching on `error.tag` to choose a message would have
silently shown the wrong one.

**Four were the base64url alphabet swap.** `+` and `/` are not safe in a cookie
value, so they are swapped for `-` and `_` and swapped back on the way in. Every
existing round-trip test happened to produce base64 containing neither
character, so either replacement could be deleted and nothing noticed. The test
now encodes bytes that force both, and asserts the premise as well as the
result — that the unswapped value really would be illegal in a cookie.

**One was a documented behaviour nobody checked.** Past the thirty-line cap a
new SKU is dropped, but a second helping of something already in the cart is not
a new line and still merges. The comment said so; nothing tested it.

**One was a copy nobody could see.** Setting a quantity on a SKU that is not in
the cart returns early. Deleting that early return still produces an *equal*
cart, because rebuilding the lines changes nothing — equal, but rebuilt for
nothing. The test asserts identity rather than equality.

#### Sixteen were a loop that did nothing

`fromBase64Url` began with a loop checking every character against the base64url
alphabet. Sixteen separate changes to it — inverting its comparisons, emptying
its body, deleting it outright — left every test passing, because `atob` already
throws on anything outside the alphabet and the `catch` below already answers
null.

**Sixteen mutants nothing could kill is not a coverage gap.** It is a statement
that the code has no observable behaviour of its own, and the honest response is
to delete it rather than to write sixteen tests that assert nothing. That is the
same rule this codebase already applies to unreachable branches; mutation
testing is just the tool that found this one.

#### The seven that remain are equivalent, and stay

Each is a guard made redundant by a later check: an absent cookie, a `null`
decode, an empty `catch`, `typeof entry !== 'object'`, `typeof q !== 'number'`.
Remove any one and the value still ends up rejected a few lines further down, so
no test can tell the difference.

They are **not** deleted, and the difference from the loop above is the point.
Dropping `if (cookie === undefined)` would make the commonest case — a visitor
with no cart — travel through base64 decoding to reach a thrown exception, and
would leave control flow depending on that throw. A guard that states the
intended case plainly is worth more than a mutation score. The loop had no such
case to state.

### And what it found in the order

`orders/order.ts` was the next weakest at 87%, and it is at **99%** now. The
distribution was nothing like the cart's: twenty-one of its twenty-three
survivors were plain missing tests, with no dead code among them.

**Ten were error tags nobody asserted** — the same shape as the cart. Every
refusal checked `{ ok: false }` and never which failure it was, including
`total_wrong`, which is the arithmetic nobody notices until the cash is counted
at the door.

**Eleven were boundaries.** `>` could become `>=` on the name, city, street,
notes and line-count limits, and the `.trim()` could be deleted from four of
them, with every test still passing. Both refuse an order that fits: a name of
exactly 120 characters, or an address submitted with trailing spaces. **An order
refused at checkout is an order that does not happen**, which makes these the
most expensive mutants found so far — and they survived behind tests that only
ever tried a value far past the limit.

The two that remain replace `delivered: []` with `["Stryker was here"]` in the
transition table. Nothing can kill them: the value is not an `OrderStatus`, so
no `canTransition` call with a real status can tell the difference. A mutation
the type system forbids is not a gap in the tests.

### And what it found in the catalogue

The catalogue was the last weak module at 93%, with fifty survivors across four
files. It is at **97%** now, `media` went from 89% to **100%** in the same pass,
and the domain as a whole is at **97.79% of 1,265 mutants**.

**Six were a test shape that asserts nothing.** Written out:

```ts
expect(result.ok).toBe(false);
if (!result.ok && result.error.tag === 'price_range_reversed') {
  expect(result.error.minCents).toBe(5000);   // never runs if the tag is wrong
}
```

The guard is there to narrow the type, and it also decides whether the assertion
happens at all. Break the tag and the `if` is simply false: nothing is checked,
the test passes, and in review it reads like a test that checks the tag. **The
same shape was in eighteen further places** across catalog, media, store and
platform — none of them measured by Stryker, all of them equally hollow. Every
one is now a single whole-value assertion:

```ts
expect(result).toEqual({
  ok: false,
  error: { tag: 'price_range_reversed', minCents: 5000, maxCents: 1000 },
});
```

**Four were price bounds.** Every test of `priceMinCents`/`priceMaxCents` passed
exactly one bound, so `min > max` — the entire subject of `price_range_reversed`
— was never once evaluated with two real numbers, and could be inverted, made
non-strict or deleted unnoticed. A `priceMaxCents` of exactly zero was never
tried either, though a minimum of zero was.

**Six were offers half-set.** `compareAtPrice` without `offerEndsAt`, or the
reverse. `createProduct` refuses both, so no test built one — but `isOnOffer`
runs on every variant read back from Mongo, including documents written before
that rule existed, and one of these mutants reads `.getTime()` off `null`. That
is a crashed product page rather than a wrong price. The same gap let
`clear_offer` report **unchanged** for exactly the products it exists to repair,
leaving them permanently unsavable.

**Six were search behaviour.** The removable-mark set is built from a range, and
every test used marks from the bottom of it, so the range could be built one
short. A query is truncated at 120 characters and then trimmed — with the cut
landing on a space, dropping the trim puts an empty term into the `$text` query.
The whole phrase and each of its words are searched for separately, which only
a two-word query can distinguish. And synonyms match whole terms, not
substrings: `laptops` must not expand, or `case` would expand inside
`staircase`.

**Three were a slug, an option key, and a tie.** A title long enough for the cut
to land *on* a hyphen produces `...aaa-`, which `isValidSlug` refuses — the
existing test for it was off by one character and never reached the case.
Variant options are joined with `|` before comparison, and without the separator
`Colour=Black` + `Storage=256GB` reads identically to a single colour named
`Black|Storage=256GB`: one customer's selection quoted at another variant's
price. And two variants at the same price could swap which one the page opens
on.

**One was a brand fold nobody could see.** Setting a brand to `"   "` on a
product that has no brand must report *unchanged*. It did — but only because
`createProduct` normalises blanks to null a moment later, so the bulk-edit code
that also does it could be deleted with every test still passing. The one thing
that changes is `updatedAt`, which is the field the storefront sorts and caches
on. This is the one I reasoned my way to the wrong answer on, twice, before
running it.

**And two in `media` were a boundary measuring itself.** The five-megabyte
upload cap is tested as `MAX_BYTES` and `MAX_BYTES + 1`, so a cap of five
*bytes* satisfies both assertions — while refusing every product photograph ever
uploaded. A boundary test that reads the boundary from the thing it is testing
cannot detect a wrong boundary. It is asserted as `5_242_880` now, written out,
once.

#### Two pieces of code were deleted rather than tested

`isValidSlug` began `slug.length > 0 && …`, and the regex on the same line
already requires a character. `MULTI_WORD_ENTRIES` was sorted longest-first "so
that `hard drive` is matched before `hard` would be" — which is a rule for a
first-match-wins loop, and this loop has no `break`, expands every match, and
collects into a Set. Neither had behaviour left to test. Five mutants went with
them, and a comment describing a precedence rule the code does not have is worse
than no comment at all.

#### The nineteen that remain are equivalent

**Five** are guards TypeScript requires and JavaScript does not: `min !== undefined
&& min < 0` cannot lose its first half in the source, though `undefined < 0` is
already false either way. **Three** are `-+` where only a single hyphen can ever
occur, because the line above collapses runs of anything else into one. **Two**
choose between two prices that compare equal, where *which object* is not a
question any caller can ask. **One** is a `?? []` whose fallback could hold any
non-blank string and behave the same.

**One is an artifact of how the report is written.** Stryker prints a
`LogicalOperator` survivor on `collection.ts:122` as `min !== undefined || max
!== undefined`; applied as printed, `&&` binds tighter and the meaning changes,
and the suite catches it immediately. Stryker parenthesises what it substitutes,
so the mutant it actually ran was the equivalent one. Both tools are right about
different mutations — which is worth knowing before chasing a survivor that the
report describes and the runner did not test.

The last **seven** are Stryker's own blind spot, below.

### The mutants Stryker cannot kill

Stryker switches one mutant on and re-runs the tests. That works for code inside
a function, which re-executes on every call. It does not work for code that runs
**once, at module load**, to build a constant: vitest imports a module once per
worker and caches it, so the mutated line may never run again. No test fails, and
Stryker reports **Survived**.

Seven of the catalogue's survivors are this — the alef/ya/ta-marbuta folding
table, the NFKC pass, the synonym index. Every one of them is caught by the
suite. Stryker simply could not see it happen.

The obvious switch, `ignoreStatic: true`, is worse than the problem: on
`search.ts` alone it drops 137 of 176 mutants — the entire synonym vocabulary
and every character table — and reports 100% for the 39 that are left. A score
that excludes the lookup tables is not a score.

```bash
pnpm test:mutation:static
```

So the mutants are proven the only way left. The script reads the report, edits
the file on disk, applies one static survivor for real, runs the whole unit
suite, and requires it to fail. It restores the file on every path including
Ctrl-C. Two mutants are declared equivalent in the script itself, with the
argument written next to them — and they are still replayed, so a claim that
stops being true fails the build. **This is a CI step, next to Stryker.**

It answers the question Stryker's number cannot: a static mutant is now either
proven caught, or a hole. `--all` replays the non-static survivors too, as a
survey — with the caveat that it applies each replacement as *written*, where
Stryker parenthesises it, so a swapped operator can bind differently under the
two. `collection.ts` has one that disagrees for exactly that reason.

#### The rule underneath all of it

Every gap in this pass was a check that could not fail: an assertion inside a
guard that the assertion's own subject controls, a boundary expressed in terms
of the boundary, a comparison never given two operands, a mutation score that
excludes the tables. **A gate that passes because it has no jurisdiction looks
exactly like a gate that passes because the code is right** — and only something
that deliberately breaks the code can tell the two apart.

### An expired offer no longer freezes a product

`createProduct` used to refuse any product whose `offerEndsAt` was in the past.
That made every product **unwritable a month after its own promotion ended** — an
operator could not archive a discontinued product, correct a price, or fix a typo
in a title, because a stale date failed the whole write.

It was never protecting anything: `isOnOffer` already answers false for an
expired offer, so the storefront never showed it either way. **The offer is
cleared instead of refused**, which makes the stored data agree with the page.

The guard that did matter — an operator typing 2025 where they meant 2026 — moved
to the importer, which can name the row and the cell. The row still imports; it
imports without the offer, and the receipt says so. A silent clear would have
been a discount that simply never appeared.

### An order can be found by phone

The operator's most common question is *"what did this number order?"*, and the
answer used to be paging through a list until the name appeared.

The phone number is already the customer identity, so this is a **lookup, not a
search**: exact match on the stored E.164, no partial matching, no regex,
nothing that could turn a typo into a collection scan. The index for it has
existed since Phase 2.4.

The operator types what the customer says — `03 123 456` — and every order was
stored through the same normaliser, so the search goes through it too. An
unreadable number is its own answer rather than an empty page: *"no orders for
+961 3 123 456"* and *"that is not a phone number"* are different sentences, and
somebody is on the phone while they read one.

### Three fields that governed nothing

`siteUrl`, `locales` and `defaultLocale` are gone from `StoreSettings`. Nothing
read them: canonical links come from `SITE_URL` on the deploy and routing from
the compiled-in locale list. They were three values that looked authoritative,
could drift from the real ones, and controlled nothing — and the settings screen
showing the *real* values beside them was the clearest sign.

They are `$unset` on the next save, like the flat `deliveryFeeCents` before them.
A superseded field left in a document is a stale answer sitting there looking
official to whoever opens it next.

## Measured on a phone

The performance gate ran the `desktop` preset from Phase 0 to Phase 3, while
almost every visitor to a Lebanese electronics shop is on a phone on a mobile
network. Playwright had treated a mobile viewport as a first-class target since
Phase 1; the thing that could actually fail a build was looking at the wrong
device. **A gate green against a device nobody uses is a gate with no
jurisdiction** — the same shape as a test that passes because it asserts nothing.

Lighthouse's default emulation is a mid-range Android with 4× CPU throttling on
a slow connection, so switching is a deletion: `lighthouserc.json` no longer asks
for `desktop`, and the CI job says `lighthouse (mobile, >= 95)` so nobody has to
open a config file to know what the number means.

**It found two real defects, and neither was performance.**

- **The site had no icon.** `/favicon.ico` 404ed on every page, in every locale —
  a browser tab with no mark on it, and a console error on every load. There is
  now an `icon.png`: the shop's accent on the shop's ground, generated rather
  than drawn so it is reproducible.
- **The listing skipped a heading level.** The facet panel's group headings were
  `h3` under the page's `h1`, with no `h2` between them. Somebody navigating by
  structure hits a missing rung on the ladder. They are `h2` now, which is what
  they always were in the document's outline.

Both had been true for three phases. The desktop preset never surfaced either.

`modern-image-formats` also went from `off` to `error`. It was switched off
because catalogue pictures were plain `<img>` tags pointed at supplier hosts and
the audit could only ever fail; they are `next/image` on our own origin now, the
audit passes, and an assertion that passes is worth enforcing.

### Where it landed

```
                perf   a11y   best   seo
/en               99    100    100   100
/ar               99    100    100   100
/en/products      98    100    100   100
/en/products/…    99    100    100   100
```

Every category clears the ≥ 95 bar on a throttled phone. What is left below 1.00
is Largest Contentful Paint, between 0.92 and 0.97 — which on a 4× throttled CPU
over slow 4G is a hero image arriving in a couple of seconds, and is the honest
number rather than one to chase.

## The product page as a shop front

The page was already correct — variants, stock, offers, structured data — and it
showed one picture with no way to see the others, no path back out, and nothing
to look at next.

**The gallery is a URL, like the variant picker beside it.** `?image=2` is
shareable, crawlable, survives a reload and works with JavaScript disabled or
still downloading. That is not a coincidence; it is the same decision the variant
picker made, for the same reasons, and a gallery built on client state would have
been the one part of the storefront that broke the rule.

Three details that are not obvious:

- **Every thumbnail is shown, including the one on display.** A strip that
  removes the current image reshuffles as you move through it, and you lose your
  place. The current one is marked with `aria-current` rather than dropped.
- **The chosen variant rides along.** Changing picture keeps `?variant=`, because
  silently resetting somebody's colour and size shows up later as an order for
  the wrong SKU.
- **Image 0 omits the parameter.** The first picture is the bare product URL —
  the one that is canonical and the one that gets shared — so there is never a
  second URL for the same page.

The index is **clamped, not validated**: `?image=99`, `?image=-1` and
`?image=two` all show the first picture. A query string a customer can edit
should never be able to produce a page with no photograph on it.

### The breadcrumb

An ordered list, because the order is the information — it is a path — and the
last crumb is the page you are on, marked `aria-current` and not a link to
itself. The separators are decoration and hidden from screen readers, so a
breadcrumb is not read out as "Home slash Products slash".

It is also published as `BreadcrumbList` JSON-LD, which is what turns
`taz4tech.com › en › products › lenovo-ideapad-3` in a search result into
**Taz4Tech › Products › Lenovo IdeaPad 3**. Every item carries an absolute URL:
Google ignores a relative `item` exactly as it ignores a relative canonical —
silently, while the markup looks perfectly correct.

**Two script blocks, not one `@graph`.** Both are valid, and two means a
malformed Product cannot take the BreadcrumbList down with it — the breadcrumb
being the one that actually appears in the result.

### More from the same brand

Brand, not a recommendation engine. A shop with a few hundred products and no
purchase history has nothing to build a recommendation from, and the brand is
what somebody looking at a Lenovo laptop is most likely to want more of. The
heading says so — *More from Lenovo* — rather than implying a cleverness that is
not there.

A product with no brand gets no strip at all. There is no honest fallback
heading for four products that have nothing in common.

It asks for one more product than it shows, because the product being read is
almost certainly in its own results; asking for four and filtering would leave
three whenever it is. And it sits behind its own Suspense boundary, so a second
query never delays the product the customer came to read.

### What the fixtures could not do

The demo catalogue has three active products under three different brands, and
the collections spec pins their counts exactly — so a fourth active product
breaks two assertions somewhere else. The related-products test therefore imports
its own pair under a brand nothing else uses, publishes them, and archives them
again, which is the same shape the stock spec has used since Phase 2.

The Lenovo fixture did gain a second image, because that costs no count anywhere
and a one-image gallery exercises nothing at all: no strip, no `?image=` link, no
question of which one you are looking at.

## The home page

It used to be the Phase 0 skeleton: an eyebrow reading `Phase 0 · skeleton`, and
a panel printing the shop's VAT rate, its configured locales and its own phone
number — a configuration dump on the page that decides whether a stranger trusts
this shop with their address. That panel is gone. The seller identity it was
accidentally carrying moved to the footer in 3.1, which is where the law expects
it and where it appears on every page rather than one.

**What a cold visitor needs, in order.** This shop has no reviews, no brand
recognition and no card payments, and it asks somebody to let a driver come to
their house. So the page leads with what it sells, then answers the three
questions that decide whether the rest of the site is worth reading — *is
anything charged now, do you reach me, will somebody call* — before it shows a
single product. Then the collections, then the newest arrivals, then how buying
works, with the numbered steps that end at "pay in cash".

**The hero and those three answers are outside every Suspense boundary.** They
are static per locale, so they are in the first response and survive a slow
catalogue query or a browser with JavaScript disabled. Only the two strips that
read the database are behind boundaries, and each fails to nothing rather than to
an error: a home page missing a row is a home page, while a home page showing an
error where the products should be is a shop that looks broken to somebody
deciding whether to trust it.

**Nothing here is a hand-edited feature list.** The collections strip is
`listCollections`, so what the operator curates in the admin is what appears —
and drafts stay out, which the demo's draft collection is there to prove. The
arrivals strip is `listProducts`, which sorts by a ULID `_id` and is therefore
newest-first for free, with no extra field to keep in step.

There is no "on offer" strip, and that is a decision rather than an oversight:
the catalogue has no query for it. Collection rules filter on brand, option and
price, not on whether a variant is discounted today. Filtering one page of
products in the page would produce a row called "our offers" that quietly is not
all of them, which is worse than not having one.

### What the tests caught

Two specs were both editing the store settings document, in parallel, and raced —
one restored the delivery fees while the other was still asserting on them.
Settings are now mutated in `admin-settings.spec.ts` and nowhere else.

And a count assertion bit for the second time. `toHaveCount(3)` on the arrivals
strip is a claim about a catalogue that other specs publish into and archive out
of; it is briefly wrong, exactly as the facets spec was. Naming the product that
must be there says the same thing and stays true.

## Images the shop owns

Every catalogue picture used to be served by somebody else's machine. The
importer reads an image URL straight out of a supplier's spreadsheet, so the
storefront pointed at supplier CDNs — and that was two problems wearing one coat.

The day a supplier tidies up a folder, products go blank. And **`next/image`
cannot optimise a host it does not trust**, so using it would have meant listing
every supplier domain in `remotePatterns` — turning the image optimiser into a
proxy for anything nameable in a spreadsheet. That is why five `<img>` tags
carried a lint suppression reading *"media hosts are a Phase 3 settings
decision"*.

**The shop now takes its own copy at import time.** Fetch once, check it is
really an image, hash the bytes, store them, and rewrite the URL to
`/media/<sha256>`. One origin, ours, that cannot disappear.

### Content-addressed, which decides three other things

The id is the SHA-256 of the bytes, and that single choice answers questions
that would otherwise each need their own mechanism:

- **Deduplication is free.** Forty spreadsheet rows sharing one photograph store
  one image. Re-importing last month's sheet stores nothing at all — there is no
  "have I done this already" flag to drift out of step with the data, because the
  data is the answer.
- **The URL is immutable, so it caches for a year.** Bytes that change are a
  different id. There is nothing to invalidate and no revalidation to pay for.
- **The write is idempotent by construction.** `$setOnInsert`, so storing the
  same image twice is not a rewrite and does not move its timestamp.

### What it refuses

**SVG, deliberately.** An SVG is a document, not a picture: it can carry script
and external references, and serving one from our own origin would run a
supplier's markup inside the shop's security context. Every raster format
accepted is inert by comparison. AVIF is refused for a duller reason — Next
16.3.3 disables its AVIF decoder to patch an RCE, so accepting one would mean
storing a picture the optimiser then refuses.

Also refused: anything over 5 MB, an empty body behind a 200, and an HTML error
page served as an image — which every CDN does eventually, and which without the
content-type check would be stored as a product photograph.

**A failure costs one picture, never the import.** A supplier CDN having a bad
afternoon must not stop four hundred products from arriving. The product lands
without that image, and the receipt names the slug, the URL and the reason, so
the sheet can be fixed and re-imported.

**A dry run fetches nothing.** A preview that pulled four hundred images off a
supplier's CDN every time an operator adjusted a column mapping would be a
preview with a cost.

### Why the database, and why that is not forever

Because the shop already has one. Atlas is provisioned, paid for, backed up and
in the same region as the app; an object store is a second vendor, a second set
of credentials and a second thing to be down. Product photographs are far below
the 16 MB document cap, so a document each — not GridFS, which would add a
chunking layer and a second collection for a case this shop does not have.

That is a starting point, not a conviction. `ImageRepository` has three methods;
an R2 adapter implements the same three and the composition root changes one
line. **The port is what makes the decision reversible, which is the reason not
to buy a vendor before there is a problem to solve.**

### Two things the tests found that reading would not have

**The middleware was swallowing every image.** `/media/<sha256>` has no file
extension, and the locale matcher excluded only paths containing a dot — so
next-intl redirected each one into the locale tree and every stored picture
404ed. The e2e asked for one and got a 404.

**`next/image` with `fill` needs a positioned parent.** Without it the image is
laid out against the nearest positioned ancestor instead of its frame — which in
the quick view meant the picture covered the dialog and intercepted every click
on the variant buttons. Three containers needed `relative`.

### The bundle budget went up, once

From 200 KB to 215 KB. `next/image` costs about 11 KB of client runtime, loaded
once and shared. A supplier photograph is 200-800 KB; served at tile size as
WebP it is a few tens of KB, on every product page, for every visitor, most of
them on a phone on a mobile network. That is the trade, and it is not close —
but it is written down in `scripts/check-bundle-budget.mjs` rather than nudged,
because forcing that argument is the entire job of a budget.

## The footer, and the pages a shop needs

```
/delivery   what it costs, per governorate, read live from settings
/returns    at the door, and after
/terms      prices, ordering, payment, cancelling
/privacy    what is kept, why, and what is not
/contact    the number, and the same number on WhatsApp
```

**The footer is where the shop says who it is.** Law 81/2018 Art. 31 wants the
seller identified on the storefront, and until this existed the only place that
happened was a configuration panel on the home page — a panel that exists to be
deleted. The name, the commercial registry number and a number a customer can
actually ring now sit on every page, read from the settings the admin edits, so
changing the shop's phone number is one form and not a deploy. The registry line
appears only once there is a number to show, because an empty label is clutter
rather than compliance.

**The footer is deliberately not behind a Suspense boundary, and the header is.**
That looks inconsistent until you look at what each waits on. The header reads a
cookie, which is instant, so its boundary resolves before the response flushes.
The footer waits on a database round trip — so React flushes the fallback and
streams the real content in afterwards with an inline script, and **a browser
with JavaScript disabled never sees it at all**. That is merely annoying for a
product grid. For the one place the shop states its legal identity, a disclosure
that needs JavaScript is not a disclosure.

This was found rather than reasoned about: the e2e spec loads a page with
JavaScript off and reads the footer out of the HTML, and it failed. The cost of
the fix is one indexed lookup by `storeId` before the response flushes, and no
prerendered shell is given up for it — every route under this layout is already
server-rendered on demand.

Taking the boundary away had a second consequence that `pnpm build` on a
developer's machine cannot see. The boundary was also what kept this component
out of the BUILD's render pass; without it the build tried to prerender the
footer, and a build machine has no business connecting to a database to generate
a page. It passed locally because Mongo happens to be running here, and died in
CI — which deliberately builds with no database — on `ECONNREFUSED` while
exporting `/ar`. The fix is `await connection()`, the same opt-out the store
summary gets for free from the boundary around it. **`pnpm build:offline`** is
that failure kept as a command: the same build with nothing listening, so the
next component that reads a database at build time is caught here rather than in
a pipeline.

**The delivery page prices itself.** The eight governorate fees are read from
store settings, so the page a customer reads and the number checkout charges
cannot drift apart. A hand-written table would have been a second answer to a
question the settings screen already answers, and the one customers read would
be the one nobody remembers to update.

### The written copy

The pages describe **how this shop actually works**, not how shops generally
work, and most of it is checkable against the code: an order is a request until
the operator confirms it by phone (that is the `pending → confirmed` transition);
the price at checkout is the price the order is written with (orders are
snapshots); one cookie holds the basket and nothing else is stored (there is no
analytics in this codebase, so there is nothing to consent to).

Three things in it are **business promises rather than facts about the system** —
the seven-day return window, what cannot be taken back, and inspecting the box
with the driver before paying. They are drafted, not authoritative. The
statutory part — what a Lebanese distance seller owes a consumer regardless of
what these pages say — is not written here and needs the same treatment the VAT
question already gets: a professional, not a guess.

### A language switcher, finally

Three links, one per language, pointing at the page you are already on. The
storefront has been trilingual since Phase 0 with no way to change language
except editing the URL.

It is the storefront's only client component, and only because staying on the
same page needs the current path, which a Server Component in a layout cannot
read. It costs nothing at runtime: `usePathname` resolves during the server
render, so the real hrefs are in the HTML and the switcher works with JavaScript
disabled — which the e2e spec checks, because that claim is exactly the kind
that is easy to make and easy to be wrong about.

## Checkout and orders

Name, phone, address, cash on delivery. No accounts — **the phone number is the
customer identity**, so it is normalised to one shape on the way in and every
Lebanese way of typing it lands on the same record.

**An order is a SNAPSHOT, not a set of references.** Every line carries the
title, the options and the price as they were when the customer agreed to them,
and nothing is looked up again. Change a price tomorrow and yesterday's order
still says what was agreed; archive a product and last month's order is still
readable. For a cash business that is the difference between a receipt and a
guess, at the door, with the customer holding the money. The totals are
**checked** rather than trusted: a line total that does not equal price ×
quantity is refused, because that is the one error nobody notices until the cash
is counted.

**The order of operations is the design:**

```
validate the customer   cheap, and rejects most bad input
re-price the cart       live, from the catalogue, never from the browser
TAKE THE STOCK          atomically, one line at a time
allocate a number       only once the goods are secured
write the order         snapshotting everything above
```

Stock is taken before the number so a failed checkout does not burn one, and
before the write so an order never exists for goods the shop does not have. If
any later step fails, **everything taken is given back**.

That compensation stands in for a transaction. Atlas would give us one, and it
would be tidier — but the databases the tests run against are standalone
servers where transactions are unavailable, and a correctness mechanism that
cannot be exercised in tests is one nobody should trust. The residual risk is a
process dying between taking and giving back, which understates stock until
someone recounts a shelf: visible and recoverable for a shop whose operator
handles the goods.

**A double-tapped submit produces one order.** The form carries a key generated
when it was rendered, a unique index refuses the second write, and the customer
is shown the order they already placed rather than an error about having placed
it. The constraint does the work, not a check that two requests could both pass.

**The order number comes from an atomic counter**, per store and per year. Two
customers checking out in the same second cannot be handed one number — it is
spoken on the phone and printed on a box.

Delivery is priced **per governorate** — Beirut is not Akkar — from a table on
store settings, edited on the [settings screen](#store-settings). The table is
complete: all eight, no default and no overrides, because a fallback is a second
answer to what delivery to Akkar costs and that is how a checkout quotes one
number and an order charges another.

The checkout page is rendered before the customer has chosen where they live, so
what it can honestly quote depends on the table. **When every governorate costs
the same — which is what a flat rate looks like here — it quotes the exact
total.** When they differ it says *From $21.00* and puts each price inside its
own option in the governorate list: `Akkar — $8.00`. The price is in the dropdown,
so it is in front of the customer at the moment they choose, with no JavaScript
and no reload. The order itself is always priced from the region that was
actually posted, so the total on the confirmation is never a number the checkout
page invented.

## The cart

**It is a cookie, not a document.** A cart is a list of SKUs and quantities — a
few hundred bytes — and a server-side one would buy a collection, a TTL sweep for
abandoned rows, an id cookie anyway, and a database read on every page that shows
a cart count. None of that is paid for by anything a customer notices. It also
fails safe: a corrupted cookie is an empty cart the customer refills, not a 500.

**What is deliberately not in it: prices.** The cookie is under the customer's
control, so a cart carrying its own prices is a cart the customer can set the
price in. Every amount is read live from the catalogue at render time, through
the same status gate the listing uses — so a product archived while a cart sat
open stops being purchasable, and a SKU asked for directly cannot reach around
it.

**Nothing is reserved.** Reserving at add-to-cart would let anyone empty the shop
by filling a cart, and a COD shop with one operator has no basket-expiry process
to release them again. Stock moves exactly once, atomically, when an order is
placed. Until then the cart tells the truth about availability and refuses
nothing.

**Every control is a plain `<form>`.** Adding, updating and removing all post as
ordinary requests before hydration and with JavaScript unavailable — a button
that silently does nothing is the worst version of this control on a slow
connection. Each form carries where it came from, so adding a second thing costs
no navigation.

A line that no longer resolves is **reported, and cleared by a button** rather
than by rendering the page. The technical reason is that a Server Component
cannot set a cookie; the better one is that a cart which quietly shrinks while
you look at it is a customer wondering what they forgot.

**Prices are VAT-inclusive.** Lebanese retail quotes what the customer pays, so
nothing is added on top. Whether a "of which VAT" line can be broken out depends
on registration, which is not settled — and it is derivable from the same totals
later without changing what anybody pays.

## Stock

Stock is a **separate document in a separate module**, and both halves of that
are load-bearing.

Variants live inside the product; their counts do not. Storing them there would
mean every sale rewrites the whole product document — and with it the derived
`searchText` field and every index entry depending on it, so a shop that sells
well would spend its write budget re-indexing descriptions that did not change.

More importantly, **selling the last unit twice is a database problem.** It is
prevented by a conditional update on one small document — *decrement where at
least this many remain* — which is only available if that document is the unit of
contention. Read the level, decide, then write, and the race is back whatever the
application layer does in between. The integration test fires twenty-five
concurrent decrements at ten units and asserts that exactly ten succeed.

**Absence means untracked, not zero.** A SKU with no record is not out of stock —
it is a SKU nobody chose to count. The opposite default would make importing a
catalogue render every product unbuyable on day one; tracking is opted into per
SKU, which is how a small shop works. A blank cell in the importer's `Stock`
column therefore writes *nothing*, while an explicit `0` writes sold out.

The storefront says what it can stand behind: a count only below a low-stock
threshold ("Only 2 left"), nothing at all for an uncounted SKU, and a sold-out
badge on a tile only when **every** variant has run out — a product with one size
left is still one the customer can buy. JSON-LD follows the same rule, because
marking a whole product `OutOfStock` because one colour ran out delists something
that can be bought.

The `_id` is the natural key, length-prefixed: `8:taz4tech:SKU-1`. A plain
`storeId:sku` join is ambiguous the moment a SKU contains the separator, and SKUs
come from other people's spreadsheets.

## Quick view

A peek at a product from the listing, without losing your place in the grid.

**No fetch and no endpoint.** The listing has already loaded every product on
the page in order to render the tiles, so the dialog's data is shipped *with* the
page rather than fetched when it opens. That removes a round trip from the one
interaction whose entire point is not waiting for one — measured at about 1.4 KB
gzipped per product, paid whether or not anyone opens a dialog.

**The trigger is a link to the product page, always.** Before hydration — a real
slice of the first interactions on a Lebanese mobile connection — and with
JavaScript unavailable, clicking it navigates. Modifier-clicks are left alone
too, so "open in a new tab" keeps working the way a link is supposed to.

**A native `<dialog>`**, opened with `showModal()`. Focus trapping, Escape to
dismiss, an inert background and focus restored to the trigger are all free and
none of them are re-implemented slightly wrong. A hand-written focus trap is
where keyboard users actually get stuck.

**The URL does not change while it is open.** It is a transient peek; the tile
link is the thing that is shareable, indexable and back-navigable. Making the
dialog a history entry would mean a client navigation, and on a route that
renders from the database that is a wasted round trip every time one is closed.

Inside the dialog, variant selection is **client state** — there is no address
here to own. The product page does the opposite, deliberately: there the
combination has to be shareable and crawlable, so each option value is a link.
Offer expiry is applied on the **server**, so a device with a wrong clock cannot
show a discount that ended last month.

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
/admin/orders      the day's work: call, confirm, deliver, cancel
/admin/products    the catalogue, and the bulk editor
/admin/import      a price list in, behind its own flag
/admin/settings    the shop's own details, and what delivery costs
```

One navigation, in `src/app/admin/nav.tsx`, shared by all four. It was extracted
at the fourth screen because three copies of a header was already how the orders
screen shipped reachable only by typing its URL — and it omits the importer link
when that flag is off, since a link to a 404 is worse than no link.

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

## Seeding

```bash
pnpm seed             # creates the settings document, or leaves the existing one alone
pnpm seed --reset     # overwrites it — test databases only
```

**`pnpm seed` is create-only, and that is deliberate.** The shop's name, its
phone number, the VAT rate and the eight delivery prices are edited by an
operator in the admin. They get set once, quietly, and then relied on. A seeder
that rewrote them from constants in a file would turn *run the seed again* —
something anyone would do to a database that looks empty, or that a deploy
runbook might do on every release — into *undo everything anyone configured*,
with no error and a cheerful success message.

So the values in `scripts/seed.ts` are what a store **starts** with, not what it
is kept at. Delivery is free everywhere until somebody prices it, because a
made-up price is charged to a real customer at their door.

Overwriting is still possible and still needed: a test database has to be put
back to a known state. That is `--reset`, asked for by name, and it prints which
database it is about to overwrite — the sentence somebody needs to read when they
typed it in the wrong terminal. CI uses it explicitly rather than relying on the
database being fresh.

The decision lives in `ensureStoreSettings`, not in the script, so "does this
already exist" is unit-tested rather than trusted. `saveStoreSettings` is the
separate door that overwrites, and nothing reaches it by accident.

### Two commands that must not reach production

`pnpm seed:demo` writes three fake laptops and a cable, three of them **active**,
so on a real catalogue that is four products a customer can buy. `pnpm seed
--reset` replaces the settings document, discarding the shop's name, phone
number, VAT rate and eight delivery prices.

The mistake has a specific shape. These scripts do **not** read `.env.local`, so
`MONGODB_URI` has to be in the environment — which is exactly what an operator
does to run `pnpm seed` against Atlas the one time a real store is created. Every
command in that shell then inherits it, and `pnpm seed:demo` is the next thing
anyone types when the storefront looks empty. Nothing else would catch it: the
write succeeds, reports success, and the fixtures are live.

So both refuse any database that is not on this machine:

```
Refusing to write demo fixtures: "taz4tech" is not a local database.

  host      cluster0.xxxxx.mongodb.net
  database  taz4tech

If that really is the database you meant, name it and run again:

  TAZ_SEED_TARGET=taz4tech pnpm seed:demo
```

**The override names the database.** A plain `--force` gets typed from muscle
memory and rides along in a command recalled from shell history; naming the
database means the override only works for the one it was written for. Recall it
against a different database and it refuses again, which is precisely when it
should.

`isLocalMongo` **parses** the connection string rather than searching it, and
that distinction is the guard. `uri.includes('localhost')` says yes to
`mongodb://user:localhost@cluster.mongodb.net` — a password — and waves
production straight through. Being wrong here is silent in exactly the direction
that costs something, so it sits in `src/platform/mongo/uri.ts` with tests, and
the coverage exclusion for that folder was narrowed to the client lifecycle so it
is actually gated. Anything it cannot read counts as remote: "I don't know" has
to mean "assume it is production".

Plain `pnpm seed` is **not** guarded. It is create-only, it is how a real store
comes into existence, and it leaves an existing one alone — so pointing it at
Atlas is the intended workflow rather than the accident.

## Store settings

The shop's own details, and what delivery costs.

**Every box on this screen changes something a customer can see.** The name, the
phone number and the registry number appear on the storefront; the VAT rate is
what the shop quotes; the delivery prices are what every order is charged.
Nothing else is offered as a field.

That rule is the whole design of the screen. `StoreSettings` also holds the
locales, the default locale and a site URL — and none of those are read at
runtime from the database. Routing is built from a compiled-in list of locales,
and every canonical link comes from `SITE_URL` on the deploy. **A box that
accepts an edit and changes nothing is worse than no box**: the operator believes
they changed something, and nobody finds out until a customer does. So those
appear in a *Set by the deploy* panel, as values with a note saying where they
come from, and the form carries them through untouched.

**The parsing lives in a use case, not in the Server Action.** An action cannot
be unit tested, and turning "11.5" into 1150 is exactly the kind of code that is
wrong by a factor of ten in a way nobody notices. `updateStoreSettings` takes the
raw strings a browser posts and is held at 100% by the coverage gate.

**A percentage and an amount are the same parser.** Basis points are percent ×
100 exactly as cents are dollars × 100, so "11.25" becomes 1125 either way, and
reusing the money parser buys the thing it was written for: the fractional digits
are read as characters rather than through a float, so `11.15` does not arrive as
`11.149999999999999` and truncate to 1114. It also inherits the refusal to guess
at a comma — `11,5` is rejected as ambiguous rather than silently read as eleven
and a half or a hundred and fifteen.

**The shop's own phone goes through the same door as a customer's.** `03 123 456`
and `+961 3 123 456` are one number, stored one way, so the storefront never
shows two spellings of it.

A refused save **comes back with everything still typed**. A settings form that
empties itself because one field was wrong is a form nobody fills in twice. The
error names the box rather than the failure, so the page can outline the field
that is wrong instead of printing a paragraph asking the operator to find it.

### Delivery, by governorate

Eight boxes, one per governorate, rather than one fee plus a list of exceptions.
A default that applies "unless" is a second answer to what delivery to Akkar
costs, and the whole point of an order being a snapshot is that there is exactly
one. A shop with a single price everywhere types it eight times, which is cheap;
a shop with a wrong price for one governorate is not.

**All eight save or none do.** One unreadable box refuses the whole form — and
the refusal names the governorate, because "the delivery fee could not be read"
on a screen with eight of them sends the operator hunting. Saving seven and
rejecting the eighth would leave the shop charging a mixture of what the operator
meant and what it used to be.

Changing a price does not change orders already placed — they are snapshots — and
the screen says so above the fields, because that is the first thing an operator
worries about.

The old flat `deliveryFeeCents` still exists in documents written before this,
and is **read as "that much, everywhere"**: the number always meant that, and now
it says so. It is `$unset` the first time settings are saved, because a
superseded field left in the document is a second, stale answer sitting there
looking authoritative.

## The admin order screen

The list, then one order: call the customer, confirm, mark it delivered — or
cancel it, which puts the stock back.

```
pending ──▶ confirmed ──▶ delivered
   │            │
   └────────────┴────────▶ cancelled
```

Delivered and cancelled are terminal, and **cancelled is deliberately not
reachable from cancelled**: cancelling returns stock, and a second cancellation
would credit the shelf for a unit nobody sold.

**The status the operator was looking at is part of the write.** Every button
carries the status the screen was rendered from, and the update is a
`findOneAndUpdate` filtered on it. Two operators looking at the same pending
order both press Cancel; the filter matches once, so the shelf is credited once.
Nothing here is a read, a decision and then a write that another request could
slip between.

That hidden status is also what makes the *message* right. A screen left open
while somebody else confirmed the order says **"somebody moved this order first
— it is confirmed now"**, not "that transition is not allowed". Both are true.
Only one of them tells the operator what to do next, and only one of them
declines to blame them for pressing a button that was legal when it was drawn.

**The flip happens before the stock is returned.** A crash in between understates
stock, which a shelf count reveals. The opposite order would let two cancellations
both credit the shelf, which nothing reveals until a customer is promised
something that is not there.

The list filters by status through **links, not a form** — "today's pending
orders" is a URL worth bookmarking — and pages by cursor. Times are Beirut,
always. Money is `tabular-nums`, so a column of totals lines up. Status is a
colour **and** the word, because colour alone fails a colour-blind reader and
disappears in a printed picking slip.

### WhatsApp, tap to send

Behind the `whatsappTapToSend` flag: a `wa.me` link that opens WhatsApp with the
message already written. **A person presses send.** Nothing is delivered
automatically, no business API is involved, and the message comes from the
operator's own number, which the customer can reply to.

It is written **in the language the customer shopped in** — the order records its
locale at checkout, and this is the only place that fact is ever used. The admin
screens around it are English; the message that leaves the shop is not.

Long orders list twelve lines and then say `• +N`. Silently truncating would send
a customer a confirmation missing items they ordered, which is worse than a
message that admits there are more.

## The bulk editor

```
/admin/products
```

Select products, choose one change, look at exactly what it would do, apply it.
Same two-mode shape as the importer, and for the same reason: the preview is
produced by the code a commit runs, not by a second implementation's guess at it.

**The selection is a list of ids, never "everything matching this filter."**
Apply-to-all is one mistyped filter away from repricing the catalogue, and what
the operator would have approved is a *count* rather than a list. Wholesale
change is what the importer is for; this is for the forty products someone is
looking at. The cap is 100.

**Four operations**: set status, set brand, change price by a percentage, and
clear offers.

**A percentage arrives as basis points**, not as a float. `1999 * 1.05` is
`2098.9500000000003` before rounding — the multiplier itself is not
representable. An integer multiplier keeps the multiplication exact and leaves
exactly one rounding step, half away from zero, where it can be seen.

**A price rise does not move the was-price.** A `compareAtPrice` is a claim about
what the product used to cost, on the field Lebanese consumer protection rules
care about; scaling it in step would keep the advertised discount looking
identical while rewriting history. Leaving it means the discount shrinks
honestly — and where the new price would meet or pass it, the product is refused
by name rather than published advertising a discount of zero. `clear offers` is
the operation that resolves those, and the one that rescues a product whose offer
has already expired.

**Three outcomes, not two**: changed, unchanged, refused. Setting status to
active on a product that is already active is not a change — counting it would
inflate the number the operator approves, and writing it would move `updatedAt`,
which the storefront sorts and caches on.

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

- **VAT.** 11% is configured. Whether this store must register depends on the
  LBP 5bn threshold; advisory sources claim importers must register regardless of
  turnover, but that is not primary-sourced and needs a Lebanese tax adviser.
- **The listing is invisible without JavaScript.** The grid sits behind a
  Suspense boundary and React swaps streamed content in with an inline script, so
  a JS-disabled browser sits on the skeleton. The markup is all in the response,
  so a crawler that does not execute JavaScript still sees every tile. Removing
  the boundary would block the page shell on a database query; keeping it leaves
  the one place the storefront does not keep its no-JS promise. The footer hit
  the same wall and was decided the other way — a legal disclosure that needs
  JavaScript is not a disclosure — which is the argument for looking at the
  listing again rather than for leaving it.
- **The eight delivery prices are all zero.** The table exists and the screen
  edits it; nobody has priced a governorate yet. Worth setting from deliveries
  that have actually happened rather than from a guess — until then the shop
  delivers free, which is at least a number it can honour.
- **The e2e suite has flaked twice, and both times the evidence was gone.**
  `quick-view.spec.ts` failed once during Phase 3.1, and the checkout
  confirmation's axe check once during this pass; each passed in isolation and
  on every run since, and each was unreproducible. Both times the artefacts were
  destroyed by the next `playwright test`, which clears `test-results/` before
  it starts — so the fix is procedural as much as technical: **copy the failure
  directory before re-running**. Until one is caught with its report intact,
  neither has a diagnosis, and neither should be assumed gone.
- **The order confirmation URL is guessable.** `/checkout/T4T-26-000042` is
  sequential, and it shows a name, a phone number and an address. There are no
  accounts, so the URL is the only handle a customer has on their order; a signed
  token in the link would fix it and would also break every confirmation already
  pasted into a WhatsApp thread. Worth deciding before the shop is busy enough for
  the numbers to be worth walking.
- **28 mutants survive on the domain layer, and every one has an argument.** The
  score is 97.79% against a floor of 97, so it cannot regress. Every module has
  had its pass; `store`, `media`, `inventory` and `bulk-edit.ts` are at 100%. Of
  what is left, nine are static — Stryker's blind spot, and
  `pnpm test:mutation:static` proves or fails each of them — and the rest are
  guards the type system requires, a `-+` that can only ever match one
  character, and ties between values that compare equal.

  The four passes split completely differently from one another: the cart was a
  third real gaps, a third code worth deleting, a third equivalent; the order was
  almost entirely real gaps; the catalogue was mostly tests that could not fail.
  There is no rule to apply in advance, which is the argument for reading the
  survivors rather than reporting the number.

*General information from primary sources, not legal advice.*
