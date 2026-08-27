/**
 * Mapping spreadsheet columns onto product fields.
 *
 * Nobody's catalogue arrives in our column order. A supplier price list, a
 * Shopify export and a hand-kept stock sheet all describe the same products with
 * different headers, so the importer maps rather than dictates.
 *
 * Detection is a starting point, not the answer: the operator confirms or
 * corrects the mapping before anything is imported. Guessing silently is how a
 * "Cost" column ends up imported as the selling price.
 */

export const IMPORT_FIELDS = [
  'slug',
  'titleEn',
  'titleAr',
  'titleFr',
  'descriptionEn',
  'descriptionAr',
  'descriptionFr',
  'brand',
  'status',
  'sku',
  'price',
  'compareAtPrice',
  'offerEndsAt',
  'barcode',
  'weightGrams',
  'option1Name',
  'option1Value',
  'option2Name',
  'option2Value',
  'imageUrl',
  'imageAlt',
  'stock',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/**
 * The three fields without which a row cannot become a sellable thing.
 *
 * Everything else has a defensible default: no brand, no translation, no image,
 * status draft. A row with no price is not a product with a missing field, it is
 * a row we would have to invent a price for.
 */
export const REQUIRED_FIELDS: readonly ImportField[] = ['titleEn', 'sku', 'price'];

/** field -> zero-based column index in the sheet. */
export type ColumnMapping = Partial<Record<ImportField, number>>;

/**
 * Header spellings seen in real exports, normalised.
 *
 * Order matters within a field: the first match wins, so the more specific
 * spelling is listed before the looser one. "compare at price" has to beat
 * "price", or a Shopify export maps its was-price onto the selling price.
 */
const HEADER_ALIASES: Record<ImportField, readonly string[]> = {
  slug: ['slug', 'handle', 'urlkey', 'url'],
  titleEn: ['titleen', 'title', 'productname', 'name', 'product'],
  titleAr: ['titlear', 'arabictitle', 'namear', 'arabicname'],
  titleFr: ['titlefr', 'frenchtitle', 'namefr', 'frenchname'],
  descriptionEn: ['descriptionen', 'bodyhtml', 'longdescription', 'details'],
  descriptionAr: ['descriptionar', 'arabicdescription'],
  descriptionFr: ['descriptionfr', 'frenchdescription'],
  brand: ['brand', 'vendor', 'manufacturer', 'make'],
  status: ['status', 'published', 'active'],
  sku: ['sku', 'variantsku', 'itemcode', 'itemnumber', 'partnumber', 'mpn', 'code'],
  compareAtPrice: ['compareatprice', 'compareprice', 'wasprice', 'rrp', 'listprice', 'msrp'],
  price: ['price', 'variantprice', 'sellingprice', 'unitprice', 'retailprice'],
  offerEndsAt: ['offerendsat', 'offerend', 'saleends', 'promotionends', 'validuntil'],
  barcode: ['barcode', 'ean', 'upc', 'gtin'],
  weightGrams: ['weightgrams', 'weightg', 'grams', 'weight'],
  option1Name: ['option1name', 'optionname1', 'attribute1name'],
  option1Value: ['option1value', 'optionvalue1', 'attribute1value'],
  option2Name: ['option2name', 'optionname2', 'attribute2name'],
  option2Value: ['option2value', 'optionvalue2', 'attribute2value'],
  imageUrl: ['imageurl', 'imagesrc', 'image', 'photo', 'picture'],
  imageAlt: ['imagealt', 'imagealttext', 'alt', 'alttext'],
  /*
   * Stock is a SEPARATE document, but it arrives in the same spreadsheet —
   * because that is how a supplier sends a price list, and asking an operator to
   * maintain two files to describe one delivery is asking them to keep one of
   * them wrong.
   */
  stock: ['stock', 'quantity', 'qty', 'onhand', 'stocklevel', 'inventory', 'available'],
};

/** Lowercase, strip everything that is not a letter or digit. "Compare-at Price" -> "compareatprice". */
export const normaliseHeader = (header: string): string =>
  header.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Detect columns from a header row.
 *
 * Fields are resolved in a fixed order so that a sheet with both "Price" and
 * "Compare at price" claims the specific one first. Each column is claimed at
 * most once — otherwise a single "Price" column would satisfy both fields and
 * every product would import as permanently discounted by zero.
 */
export const detectMapping = (headers: readonly string[]): ColumnMapping => {
  const normalised = headers.map(normaliseHeader);
  const claimed = new Set<number>();
  const mapping: ColumnMapping = {};

  // Specific-before-general: compareAtPrice must resolve before price, and the
  // explicit locale titles before the bare "title".
  const order: ImportField[] = [
    'slug',
    'sku',
    'compareAtPrice',
    'price',
    'titleAr',
    'titleFr',
    'titleEn',
    'descriptionAr',
    'descriptionFr',
    'descriptionEn',
    'brand',
    'status',
    'offerEndsAt',
    'barcode',
    'weightGrams',
    'option1Name',
    'option1Value',
    'option2Name',
    'option2Value',
    'imageUrl',
    'imageAlt',
    'stock',
  ];

  for (const field of order) {
    for (const alias of HEADER_ALIASES[field]) {
      const index = normalised.indexOf(alias);
      if (index !== -1 && !claimed.has(index)) {
        mapping[field] = index;
        claimed.add(index);
        break;
      }
    }
  }

  return mapping;
};

export type MappingProblem = {
  readonly tag: 'missing_required_field';
  readonly field: ImportField;
};

/** Fields the mapping still needs before an import can run. */
export const validateMapping = (mapping: ColumnMapping): MappingProblem[] =>
  REQUIRED_FIELDS.filter((field) => mapping[field] === undefined).map((field) => ({
    tag: 'missing_required_field' as const,
    field,
  }));
