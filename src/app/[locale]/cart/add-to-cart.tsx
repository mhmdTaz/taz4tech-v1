import type { Locale } from '@platform/locale';
import { getTranslations } from 'next-intl/server';
import { addLine } from './actions';

/**
 * The add-to-cart control.
 *
 * A plain <form>, deliberately. It posts as an ordinary request before
 * hydration and with JavaScript unavailable — which on a Lebanese mobile
 * connection is a real slice of the first taps, and a button that silently does
 * nothing is the worst version of this control.
 *
 * `returnTo` sends the customer back where they were rather than to the cart:
 * adding a second thing should not cost a navigation each time.
 */
export const AddToCart = async ({
  sku,
  locale,
  returnTo,
  disabled = false,
  quantityInCart = 0,
}: {
  sku: string;
  locale: Locale;
  returnTo: string;
  /** Out of stock. The control is shown and refused rather than hidden. */
  disabled?: boolean;
  /** How many of this exact variant are already in the cart. */
  quantityInCart?: number;
}) => {
  const t = await getTranslations({ locale, namespace: 'cart' });

  return (
    <form action={addLine} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="sku" value={sku} />
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="quantity" value="1" />

      <button
        type="submit"
        disabled={disabled}
        className="rounded-lg bg-accent px-5 py-3 font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t('addToCart')}
      </button>

      {quantityInCart > 0 && (
        // A status region: it is the answer to the tap that just happened, and
        // after a form post the page has re-rendered around it.
        <span role="status" className="text-sm text-positive">
          {t('inCart', { count: quantityInCart })}
        </span>
      )}
    </form>
  );
};
