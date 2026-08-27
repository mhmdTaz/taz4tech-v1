import { redirect } from 'next/navigation';
import { IMPORT_PATH, requireAdminEnabled } from './session';

/**
 * Dynamic, because whether the admin area exists at all is a RUNTIME question.
 * Prerendered, this page would bake in the answer from build time — a deploy
 * that adds ADMIN_PASSWORD would still serve the 404 that was frozen without it.
 */
export const dynamic = 'force-dynamic';

/**
 * There is one admin screen so far, so /admin is a signpost rather than a
 * dashboard. When there are several this becomes the index; until then a
 * landing page listing one link is a page nobody would read.
 */
export default function AdminIndex() {
  requireAdminEnabled();
  redirect(IMPORT_PATH);
}
