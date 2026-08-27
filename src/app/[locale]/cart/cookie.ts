import type { Cart } from '@modules/cart';
import { formatCart, parseCart } from '@modules/cart';
import { getConfig } from '@platform/config';
import { cookies } from 'next/headers';

/**
 * The cart cookie.
 *
 * Reading and writing live here rather than in each action, so the attributes
 * are stated once and cannot drift apart between "add" and "remove".
 */

const COOKIE_NAME = 'taz_cart';

/** Long enough that a customer can come back after the weekend. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const readCart = async (): Promise<Cart> =>
  // parseCart never throws and never returns something out of bounds, so a
  // hand-edited cookie costs the customer their cart and costs us nothing.
  parseCart((await cookies()).get(COOKIE_NAME)?.value);

export const writeCart = async (cart: Cart): Promise<void> => {
  (await cookies()).set(COOKIE_NAME, formatCart(cart), {
    /*
     * httpOnly even though this is not a secret.
     *
     * Nothing in the browser reads the cart — every page that shows it is
     * rendered on the server — so there is no reason to leave it available to
     * script, and one less thing an XSS anywhere on the storefront can read or
     * rewrite.
     */
    httpOnly: true,
    // Off over plain HTTP, or the cookie is dropped and local development
    // becomes a cart that never fills.
    secure: getConfig().isProduction,
    /*
     * 'lax' rather than 'strict'. A customer arriving from a WhatsApp link — the
     * main way this shop is shared — must still have their cart, and 'strict'
     * withholds the cookie on exactly that navigation.
     */
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
};

export const clearCart = async (): Promise<void> => {
  (await cookies()).delete({ name: COOKIE_NAME, path: '/' });
};
