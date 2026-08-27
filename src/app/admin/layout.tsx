import type { Metadata } from 'next';
import '../globals.css';

/**
 * A second root layout, alongside the storefront's.
 *
 * `/admin` sits outside `[locale]` on purpose. The storefront is trilingual
 * because its customers are; there is one operator, and translating an admin
 * into three languages for one reader would triple the copy for no reader at
 * all. It also keeps the admin out of the sitemap, the hreflang graph and the
 * message-bundle parity test, none of which have anything to say about it.
 *
 * Same stylesheet as the storefront, so the design tokens stay in one place.
 */
export const metadata: Metadata = {
  title: 'Taz4Tech admin',
  // Belt and braces with the Disallow in robots.txt: robots.txt asks a crawler
  // not to fetch, this tells one that fetched anyway not to index. A login page
  // in search results is an invitation.
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
