'use server';

import { isLocale, type Locale } from '@platform/locale';
import { redirect } from 'next/navigation';
import { getContainer } from '@/composition';
import { clearCart, readCart } from '../cart/cookie';

/**
 * Placing the order.
 *
 * A plain form post, like everything else on the storefront, so it works before
 * hydration and with JavaScript unavailable. On success the customer is
 * redirected to the confirmation page — post/redirect/get, so a refresh cannot
 * re-submit and the back button cannot re-order.
 *
 * Failures come back as a query parameter rather than a rendered response,
 * because a redirect is the only way to end a form post without leaving a
 * re-submittable page in history. The form is re-rendered from the cart, which
 * is still intact, so nothing the customer typed is lost except the fields
 * themselves — and those come back too, echoed from the query.
 */

const text = (formData: FormData, field: string): string => {
  const value = formData.get(field);
  return typeof value === 'string' ? value : '';
};

const readLocale = (formData: FormData): Locale => {
  const locale = formData.get('locale');
  return typeof locale === 'string' && isLocale(locale) ? locale : 'en';
};

/** Everything the customer typed, so a refused checkout does not empty the form. */
const echo = (formData: FormData): string =>
  new URLSearchParams({
    name: text(formData, 'name'),
    phone: text(formData, 'phone'),
    region: text(formData, 'region'),
    city: text(formData, 'city'),
    street: text(formData, 'street'),
    notes: text(formData, 'notes'),
  }).toString();

export const placeOrder = async (formData: FormData): Promise<void> => {
  const locale = readLocale(formData);
  const container = await getContainer();

  const result = await container.orders.placeOrder({
    cart: await readCart(),
    locale,
    name: text(formData, 'name'),
    phone: text(formData, 'phone'),
    region: text(formData, 'region'),
    city: text(formData, 'city'),
    street: text(formData, 'street'),
    notes: text(formData, 'notes'),
    /*
     * Generated when the FORM was rendered, not here.
     *
     * That is what makes it identify one checkout: a customer who taps twice
     * sends the same key twice, and the unique index refuses the second write.
     * Generating it here would produce two keys and two orders.
     */
    idempotencyKey: text(formData, 'idempotencyKey'),
  });

  if (result.ok) {
    /*
     * The cart is cleared only after the order is safely written. Clearing
     * first would lose the cart of every checkout that then failed, which is
     * the worst possible moment to lose one.
     */
    await clearCart();

    container.logger.info('order placed', {
      number: result.value.number,
      lines: result.value.lines.length,
      totalCents: result.value.total.cents,
      region: result.value.delivery.region,
    });

    redirect(`/${locale}/checkout/${encodeURIComponent(result.value.number)}`);
  }

  const params = new URLSearchParams(echo(formData));

  switch (result.error.tag) {
    case 'phone_invalid':
      params.set('error', 'phone');
      break;
    case 'region_invalid':
      params.set('error', 'region');
      break;
    case 'invalid':
      params.set('error', 'required');
      break;
    case 'cart_changed':
    case 'cart_empty':
      params.set('error', 'cart');
      break;
    case 'out_of_stock':
      params.set('error', 'stock');
      params.set('sku', result.error.sku);
      params.set('available', String(result.error.available));
      break;
    default:
      params.set('error', 'generic');
  }

  redirect(`/${locale}/checkout?${params.toString()}`);
};
