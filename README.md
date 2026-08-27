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

Delivery is a **flat fee** on store settings, zero by default, edited on the
[settings screen](#store-settings). Cost genuinely varies by governorate in
Lebanon, so a per-region table is the obvious next step — what is missing now is
not a screen but the eight prices. The region is recorded on every order, so
they can be set from real deliveries rather than guessed.

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

## Store settings

The shop's own details, and what delivery costs.

**Every box on this screen changes something a customer can see.** The name, the
phone number and the registry number appear on the storefront; the VAT rate is
what the shop quotes; the delivery fee is added to every order. Nothing else is
offered as a field.

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

Changing the delivery fee does not change orders already placed — they are
snapshots — and the screen says so next to the field, because that is the first
thing an operator worries about.

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

- **Stryker** mutation testing on the domain layer was a Phase 1 item and did
  not land. Phase 1 is closed; it is either a Phase 2 task or a decision to drop.
- **VAT.** 11% is configured. Whether this store must register depends on the
  LBP 5bn threshold; advisory sources claim importers must register regardless of
  turnover, but that is not primary-sourced and needs a Lebanese tax adviser.
- **Lighthouse runs the `desktop` preset**, while most Lebanese traffic is mobile
  — the Playwright config already treats a mobile viewport as a first-class
  target. A performance gate measuring desktop is measuring the wrong device.
  Switching it makes the >= 95 bar substantially harder, so it is a deliberate
  decision rather than a quiet change — still outstanding now Phase 1 has closed.
- **The listing is invisible without JavaScript.** The grid sits behind a
  Suspense boundary and React swaps streamed content in with an inline script, so
  a JS-disabled browser sits on the skeleton. The markup is all in the response,
  so a crawler that does not execute JavaScript still sees every tile. Removing
  the boundary would block the page shell on a database query; keeping it leaves
  the one place the storefront does not keep its no-JS promise.
- **Three fields on `StoreSettings` are never read.** `siteUrl`, `locales` and
  `defaultLocale` are written by the seeder and mirrored by nothing: canonical
  links come from `SITE_URL`, and routing is built from the compiled-in locale
  list. The settings screen shows the real values and refuses to offer boxes for
  them, but the stored copies are still there, still able to drift, and still
  looking authoritative to whoever reads the document next. Either wire them up
  or drop them.
- **Delivery is one flat fee for the whole country.** Beirut is not Akkar, the
  region is on every order, and the screen to edit a per-governorate table now
  exists. What is missing is eight real prices — worth setting from deliveries
  that have happened rather than from a guess made today.
- **An order is found only by browsing.** The orders list filters by status and
  pages by cursor, but there is no search. A customer phones, says "I ordered
  yesterday", and the operator pages until they see the name. Searching by phone
  number is the obvious answer — the phone number is already the customer
  identity — and it is not here because nobody has yet run a list long enough to
  need it.
- **The order confirmation URL is guessable.** `/checkout/T4T-26-000042` is
  sequential, and it shows a name, a phone number and an address. There are no
  accounts, so the URL is the only handle a customer has on their order; a signed
  token in the link would fix it and would also break every confirmation already
  pasted into a WhatsApp thread. Worth deciding before the shop is busy enough for
  the numbers to be worth walking.
- **An expired offer blocks every edit to a product.** `createProduct` refuses a
  product whose `offerEndsAt` is in the past, so an old product cannot be
  archived until its offer is cleared. `clear offers` in the bulk editor exists
  to unstick that, and the refusal says so — but this is friction that arrives
  monthly as offers age.

*General information from primary sources, not legal advice.*
