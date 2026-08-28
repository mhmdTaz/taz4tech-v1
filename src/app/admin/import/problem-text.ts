import type { CellProblem, ImportField, ProductError } from '@modules/catalog';

/**
 * Turning the importer's error unions into something an operator can act on.
 *
 * Every message names the thing to change. "Invalid date" tells the operator
 * there is a problem; "could be a day or a month first — write it as 2026-08-27"
 * tells them what to type, which is the only version that gets the sheet fixed.
 *
 * The switches are exhaustive by construction: the `never` in the default arm
 * means adding a new error tag to the domain fails the TYPE CHECK here rather
 * than rendering an empty cell in production. That is the whole reason this is a
 * switch and not a lookup table with a fallback string.
 */

/** Column headings as an operator thinks of them, not as the code spells them. */
export const FIELD_LABELS: Record<ImportField, string> = {
  slug: 'URL slug',
  titleEn: 'Title (English)',
  titleAr: 'Title (Arabic)',
  titleFr: 'Title (French)',
  descriptionEn: 'Description (English)',
  descriptionAr: 'Description (Arabic)',
  descriptionFr: 'Description (French)',
  brand: 'Brand',
  status: 'Status',
  sku: 'SKU',
  price: 'Price',
  compareAtPrice: 'Compare-at price',
  offerEndsAt: 'Offer ends',
  barcode: 'Barcode',
  weightGrams: 'Weight (g)',
  option1Name: 'Option 1 name',
  option1Value: 'Option 1 value',
  option2Name: 'Option 2 name',
  option2Value: 'Option 2 value',
  imageUrl: 'Image URL',
  imageAlt: 'Image alt text',
  stock: 'Stock',
};

const localeName = (locale: string): string =>
  ({ en: 'English', ar: 'Arabic', fr: 'French' })[locale] ?? locale;

const describeTextProblem = (
  reason: { tag: 'fallback_empty' } | { tag: 'translation_blank'; locale: string },
): string =>
  reason.tag === 'fallback_empty'
    ? 'the English value is empty'
    : `the ${localeName(reason.locale)} value is blank — leave the cell empty rather than typing a space`;

export const describeCellProblem = (problem: CellProblem): string => {
  switch (problem.tag) {
    case 'required_cell_empty':
      return 'This cell is required and is empty.';
    case 'unparsable_money':
      return `"${problem.value}" is not a price. Write it as 1299.00 or 1,299.00.`;
    case 'ambiguous_date':
      // The importer refuses rather than guessing: 03/04/2026 is two different
      // dates depending on who wrote the sheet, and guessing wrong ends an offer
      // a month early or late.
      return `"${problem.value}" could be day-first or month-first. Write it as 2026-08-27.`;
    case 'unparsable_date':
      return `"${problem.value}" is not a date. Write it as 2026-08-27.`;
    case 'date_already_past':
      // The row still imports; it imports WITHOUT the offer, because an offer
      // that has ended is no offer. Said plainly so a mistyped year is caught
      // here rather than noticed as a discount that never appeared.
      return `"${problem.value}" has already passed, so this offer will not be applied.`;
    case 'unknown_status':
      return `"${problem.value}" is not a status. Use active, draft or archived.`;
    case 'unparsable_number':
      return `"${problem.value}" is not a whole number.`;
    case 'duplicate_sku':
      return `This SKU is already used on row ${problem.firstSeenAtRow}. Every SKU must be unique.`;
    default: {
      const unhandled: never = problem;
      return String(unhandled);
    }
  }
};

export const describeProductError = (error: ProductError): string => {
  switch (error.tag) {
    case 'slug_invalid':
      return `"${error.slug}" is not a usable URL slug. Use lowercase letters, digits and hyphens.`;
    case 'title_invalid':
      return `The title is rejected because ${describeTextProblem(error.reason)}.`;
    case 'description_invalid':
      return `The description is rejected because ${describeTextProblem(error.reason)}.`;
    case 'no_variants':
      return 'No usable rows were left for this product.';
    case 'sku_empty':
      return `Row ${error.index + 1} of this product has an empty SKU.`;
    case 'sku_duplicated':
      return `The SKU "${error.sku}" appears twice in this product.`;
    case 'option_names_duplicated':
      return `The option "${error.name}" is listed twice. Use two different option names.`;
    case 'option_name_empty':
      return 'An option has a value but no name.';
    case 'variant_options_mismatch':
      return `SKU ${error.sku} does not use the same options as the rest of the product (${error.expected.join(', ')}). Every row of one product must fill in the same option columns.`;
    case 'variant_option_value_empty':
      return `SKU ${error.sku} has no value for "${error.name}".`;
    case 'variant_combination_duplicated':
      return `Two rows describe the same combination (${error.combination}). One of them is a duplicate.`;
    case 'price_negative':
      return `SKU ${error.sku} has a negative price.`;
    case 'compare_at_not_higher':
      return `SKU ${error.sku} has a compare-at price that is not above the selling price, so it would advertise a discount of zero or less.`;
    case 'offer_without_end_date':
      return `SKU ${error.sku} has a compare-at price but no offer end date. Lebanese consumer rules expect a stated end; add one.`;
    case 'offer_end_date_in_past':
      return `SKU ${error.sku} has an offer that has already ended.`;
    case 'offer_end_date_without_offer':
      return `SKU ${error.sku} has an offer end date but no compare-at price.`;
    case 'media_url_empty':
      return `Image ${error.index + 1} has an empty URL.`;
    case 'media_alt_invalid':
      return `Image ${error.index + 1} has unusable alt text because ${describeTextProblem(error.reason)}.`;
    case 'spec_invalid':
      return `Spec ${error.index + 1} is unusable because ${describeTextProblem(error.reason)}.`;
    default: {
      const unhandled: never = error;
      return String(unhandled);
    }
  }
};
