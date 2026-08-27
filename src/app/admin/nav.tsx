import { logOut } from './login/actions';

/**
 * The admin's own navigation.
 *
 * Extracted at the fourth screen, because three copies of a header was already
 * how the orders screen shipped reachable only by typing its URL. A shared list
 * means adding a screen is adding a line here, not remembering three files.
 *
 * Plain anchors, not next/link: every one of these is a full page load anyway —
 * each admin screen reads a cookie and the database on every request — and a
 * client-side navigation would only add a router to the bundle for it.
 */

const chip =
  'rounded-lg border border-hairline px-3 py-2 text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const LINKS = [
  { href: '/admin/orders', label: 'Orders', needsImporter: false },
  { href: '/admin/products', label: 'Products', needsImporter: false },
  { href: '/admin/import', label: 'Import', needsImporter: true },
  { href: '/admin/settings', label: 'Settings', needsImporter: false },
] as const;

export const AdminNav = ({
  current,
  importer,
}: {
  /** The href of the screen this nav is on, so it can mark it and not link to it. */
  readonly current: string;
  /**
   * Whether the Excel importer is switched on.
   *
   * The importer screen 404s when the flag is off, and a nav that offers a link
   * to a 404 is worse than one that offers nothing.
   */
  readonly importer: boolean;
}) => (
  <nav aria-label="Admin" className="flex flex-wrap items-center gap-3">
    {LINKS.filter((link) => importer || !link.needsImporter).map((link) =>
      link.href === current ? (
        <span key={link.href} aria-current="page" className={`${chip} border-accent/60 text-ink`}>
          {link.label}
        </span>
      ) : (
        <a key={link.href} href={link.href} className={chip}>
          {link.label}
        </a>
      ),
    )}

    <form action={logOut}>
      <button type="submit" className={chip}>
        Sign out
      </button>
    </form>
  </nav>
);
