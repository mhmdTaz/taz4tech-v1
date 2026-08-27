'use server';

import { addToCart, keepOnly, MAX_QUANTITY, removeFromCart, setQuantity } from '@modules/cart';
import { isLocale, type Locale } from '@platform/locale';
import { redirect } from 'next/navigation';
import { getContainer } from '@/composition';
import { readCart, writeCart } from './cookie';

/**
 * Changing the cart.
 *
 * Every one of these is reached by a plain <form action={...}>, which submits as
 * an ordinary POST before hydration and with JavaScript unavailable. That is why
 * they take FormData and redirect rather than returning a value: a form that
 * needs a client to interpret its answer is a form that does nothing on the
 * first tap of a slow connection.
 *
 * Server Actions also verify the request origin, so the CSRF question is closed
 * without a token of our own.
 */

/** Bounded here as well as in the domain, so a crafted post cannot allocate. */
const readQuantity = (value: FormDataEntryValue | null, fallback: number): number => {
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_QUANTITY) return fallback;
  return parsed;
};

const readSku = (formData: FormData): string | null => {
  const sku = formData.get('sku');
  return typeof sku === 'string' && sku.trim().length > 0 ? sku : null;
};

const readLocale = (formData: FormData): Locale => {
  const locale = formData.get('locale');
  // The locale comes from a hidden field rather than from headers: the action
  // has no route of its own, so there is no segment to read it from.
  return typeof locale === 'string' && isLocale(locale) ? locale : 'en';
};

/**
 * Where to send the browser afterwards.
 *
 * The form carries the page it was submitted from so a no-JavaScript customer
 * lands back where they were rather than on the cart. Validated against a
 * prefix, because an open redirect is one unchecked form field away.
 */
const readReturnTo = (formData: FormData, locale: Locale): string => {
  const returnTo = formData.get('returnTo');
  if (typeof returnTo !== 'string') return `/${locale}/cart`;
  // Must be a path on this site: no scheme, no host, and no protocol-relative
  // "//evil.example" — which is a URL a browser will happily follow off-site.
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return `/${locale}/cart`;
  return returnTo;
};

export const addLine = async (formData: FormData): Promise<void> => {
  const locale = readLocale(formData);
  const sku = readSku(formData);
  if (sku === null) redirect(`/${locale}/cart`);

  const quantity = readQuantity(formData.get('quantity'), 1);
  const result = addToCart(await readCart(), sku, quantity);

  /*
   * A refusal is not an error page.
   *
   * The only ways to get one are asking for more than ninety-nine of a thing or
   * a thirty-first line, both of which mean the cart stays as it was. The
   * customer is returned to the page they were on, where the cart count has not
   * moved — which is the honest outcome.
   */
  if (result.ok) await writeCart(result.value);

  redirect(readReturnTo(formData, locale));
};

export const updateLine = async (formData: FormData): Promise<void> => {
  const locale = readLocale(formData);
  const sku = readSku(formData);
  if (sku === null) redirect(`/${locale}/cart`);

  // No fallback quantity here: an unreadable value means the form did not come
  // from this page, and leaving the line alone is safer than guessing.
  const quantity = readQuantity(formData.get('quantity'), -1);
  if (quantity >= 0) {
    const result = setQuantity(await readCart(), sku, quantity);
    if (result.ok) await writeCart(result.value);
  }

  redirect(readReturnTo(formData, locale));
};

export const removeLine = async (formData: FormData): Promise<void> => {
  const locale = readLocale(formData);
  const sku = readSku(formData);
  if (sku !== null) await writeCart(removeFromCart(await readCart(), sku));

  redirect(readReturnTo(formData, locale));
};

/**
 * Drop the lines that no longer resolve to anything sellable.
 *
 * A button rather than a side effect of rendering the cart, for two reasons.
 * The technical one: a Server Component cannot set a cookie, only an action can.
 * The better one: a cart that silently shrinks while you look at it is a
 * customer wondering what they forgot. They are told what went, and they clear
 * it themselves.
 */
export const clearUnavailable = async (formData: FormData): Promise<void> => {
  const locale = readLocale(formData);
  const cart = await readCart();

  const container = await getContainer();
  const priced = await container.cart.priceCart(cart, locale);

  await writeCart(keepOnly(cart, new Set(priced.lines.map((line) => line.sku))));

  redirect(`/${locale}/cart`);
};
