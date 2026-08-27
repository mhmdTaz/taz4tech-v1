import { redirect } from 'next/navigation';
import { PRODUCTS_PATH, requireAdminEnabled } from './session';

/**
 * Dynamic, because whether the admin area exists at all is a RUNTIME question.
 * Prerendered, this page would bake in the answer from build time — a deploy
 * that adds ADMIN_PASSWORD would still serve the 404 that was frozen without it.
 */
export const dynamic = 'force-dynamic';

/**
 * A signpost rather than a dashboard. The product list is where the work starts
 * — importing is something you do occasionally, editing is continuous — so that
 * is where a bare /admin lands. A landing page offering two links is a page
 * nobody would read twice.
 */
export default function AdminIndex() {
  requireAdminEnabled();
  redirect(PRODUCTS_PATH);
}
