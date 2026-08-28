/**
 * Turning what a customer typed into terms worth searching for.
 *
 * Pure and framework-free, like the rest of the domain — which matters here
 * because this is the layer that decides whether an Arabic speaker finds
 * anything at all.
 *
 * WHY NORMALISATION, NOT JUST lowercase()
 * ---------------------------------------
 * Arabic is written with optional diacritics and several interchangeable letter
 * forms. Someone typing "شاشه" will not match a product titled "شاشة" under a
 * plain comparison, and neither will "احمد" match "أحمد". These are not typos —
 * they are how the language is actually typed. Normalising both sides collapses
 * the variants so the match works.
 *
 * WHY SYNONYMS
 * ------------
 * The catalogue arrives from suppliers in English. A large share of customers
 * search in Arabic. Without cross-language synonyms, "لابتوب" returns nothing at
 * all from a catalogue full of laptops — which is not a ranking problem, it is
 * an empty shop.
 */

/*
 * Arabic code points, written as numbers rather than literal characters.
 *
 * The letters are invisible-ish in a diff and easy to corrupt through an
 * encoding change; a code point is unambiguous and greppable. The literal text
 * that IS readable — the synonym vocabulary below — stays literal.
 */
const ARABIC_ALEF = String.fromCharCode(0x0627); // ا
const ARABIC_YA = String.fromCharCode(0x064a); // ي
const ARABIC_HA = String.fromCharCode(0x0647); // ه

/** آ أ إ ٱ all normalise to ا. */
const ALEF_VARIANTS = new Set([0x0622, 0x0623, 0x0625, 0x0671]);
/** ى (alef maqsura) normalises to ي. */
const YA_VARIANTS = new Set([0x0649]);
/** ة (ta marbuta) normalises to ه. */
const HA_VARIANTS = new Set([0x0629]);

/** Tashkeel (fatha, kasra, shadda, …), superscript alef, and the tatweel stretch mark. */
const REMOVABLE: ReadonlySet<string> = new Set(
  [...Array.from({ length: 0x065f - 0x064b + 1 }, (_, i) => 0x064b + i), 0x0670, 0x0640].map(
    (code) => String.fromCharCode(code),
  ),
);

/** Letter forms that fold onto a single canonical letter. */
const FOLDED: ReadonlyMap<string, string> = new Map([
  ...[...ALEF_VARIANTS].map((code) => [String.fromCharCode(code), ARABIC_ALEF] as const),
  ...[...YA_VARIANTS].map((code) => [String.fromCharCode(code), ARABIC_YA] as const),
  ...[...HA_VARIANTS].map((code) => [String.fromCharCode(code), ARABIC_HA] as const),
]);

/**
 * Fold a string into its searchable form.
 *
 * Applied to BOTH the query and the indexed text, so the two always meet in the
 * same shape.
 *
 * Compares characters rather than code points on purpose: codePointAt returns
 * `number | undefined`, and the undefined arm is unreachable here but would sit
 * forever as an untested branch in a layer gated at 100%.
 */
export const normaliseSearchText = (input: string): string => {
  let out = '';
  for (const character of input.normalize('NFKC')) {
    if (REMOVABLE.has(character)) continue;
    out += FOLDED.get(character) ?? character.toLowerCase();
  }
  return out.replace(/\s+/g, ' ').trim();
};

/**
 * Groups of terms that mean the same thing to a customer.
 *
 * Cross-language on purpose: the catalogue is written in English and a large
 * share of searches are not. Each group is bidirectional — matching any member
 * expands to all of them.
 *
 * Deliberately small and hand-kept. A generated thesaurus produces confident
 * nonsense ("mouse" the animal), and for a catalogue this size a short list of
 * terms people actually type beats coverage.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['laptop', 'notebook', 'ordinateur portable', 'لابتوب', 'كمبيوتر محمول', 'حاسوب محمول'],
  ['phone', 'mobile', 'smartphone', 'telephone', 'téléphone', 'هاتف', 'جوال', 'موبايل'],
  ['tablet', 'tablette', 'تابلت', 'لوحي'],
  ['charger', 'adapter', 'power supply', 'chargeur', 'شاحن', 'محول'],
  ['cable', 'cord', 'lead', 'câble', 'كابل', 'وصلة'],
  ['headphones', 'earphones', 'headset', 'earbuds', 'écouteurs', 'سماعات', 'سماعة'],
  ['mouse', 'souris', 'فأرة', 'ماوس'],
  ['keyboard', 'clavier', 'لوحة مفاتيح', 'كيبورد'],
  ['screen', 'monitor', 'display', 'écran', 'moniteur', 'شاشة'],
  ['memory', 'ram', 'mémoire', 'ذاكرة', 'رام'],
  ['storage', 'ssd', 'hdd', 'hard drive', 'disque dur', 'تخزين', 'قرص صلب'],
  ['battery', 'batterie', 'بطارية'],
  ['case', 'cover', 'sleeve', 'coque', 'housse', 'غطاء', 'حافظة', 'جراب'],
  ['printer', 'imprimante', 'طابعة'],
  ['camera', 'appareil photo', 'كاميرا'],
  ['speaker', 'haut-parleur', 'مكبر صوت', 'سماعة خارجية'],
  ['router', 'modem', 'routeur', 'راوتر', 'موجه'],
  ['watch', 'smartwatch', 'montre', 'ساعة'],
];

/** Normalised term -> every term in its group, including itself. */
const SYNONYM_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const index = new Map<string, readonly string[]>();
  for (const group of SYNONYM_GROUPS) {
    const normalised = group.map(normaliseSearchText);
    // A term in two groups would silently take the second group's meaning. That
    // is prevented by a test over the vocabulary rather than by merge logic
    // here, which would otherwise be a branch nothing can reach.
    for (const term of normalised) index.set(term, normalised);
  }
  return index;
})();

/*
 * The synonym phrases that contain a space, in no particular order.
 *
 * They are matched against the whole query rather than word by word, so "hard
 * drive" expands as storage instead of as "hard" plus "drive".
 *
 * Deliberately unsorted. This list used to be sorted longest-first, to match a
 * longer phrase "before" a shorter one — which is a rule for a first-match-wins
 * loop, and the loop below is not one: it has no break, every matching phrase
 * expands, and the results land in a Set. Order changed nothing a caller could
 * see, and the comment describing it made the code look like it had a
 * precedence rule to reason about.
 */
const MULTI_WORD_ENTRIES: readonly (readonly [string, readonly string[]])[] = [
  ...SYNONYM_INDEX.entries(),
].filter(([term]) => term.includes(' '));

export type SearchTerms = {
  /** What the customer typed, normalised. Empty when they typed nothing usable. */
  readonly query: string;
  /** Every term to search for, including synonym expansions. Never contains duplicates. */
  readonly terms: readonly string[];
};

/** Queries longer than this are truncated; nobody types a real search this long. */
const MAX_QUERY_LENGTH = 120;

/**
 * Expand a raw query into the terms to search for.
 *
 * Multi-word synonyms are matched against the whole query first, so "hard drive"
 * expands as one concept rather than as "hard" plus "drive".
 */
export const expandSearchTerms = (raw: string): SearchTerms => {
  const query = normaliseSearchText(raw).slice(0, MAX_QUERY_LENGTH).trim();
  if (query.length === 0) return { query: '', terms: [] };

  const terms = new Set<string>([query]);

  for (const [phrase, synonyms] of MULTI_WORD_ENTRIES) {
    if (query.includes(phrase)) for (const synonym of synonyms) terms.add(synonym);
  }

  // The query is already collapsed and trimmed, and empty queries returned
  // above, so split cannot yield an empty token.
  for (const word of query.split(' ')) {
    terms.add(word);
    for (const synonym of SYNONYM_INDEX.get(word) ?? []) terms.add(synonym);
  }

  return { query, terms: [...terms] };
};

/** True when the query is worth running at all. */
export const isSearchable = (raw: string): boolean => expandSearchTerms(raw).query.length > 0;
