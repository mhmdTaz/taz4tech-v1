import { redirect } from 'next/navigation';
import { hasAdminSession, IMPORT_PATH, requireAdminEnabled } from '../session';
import { LoginForm } from './login-form';

/** Reads a cookie, so there is nothing here to prerender. */
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  requireAdminEnabled();

  // Already signed in: show the work, not a login form. Without this, a
  // bookmark to /admin/login is a dead end for someone who is already in.
  if (await hasAdminSession()) redirect(IMPORT_PATH);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Taz4Tech admin</h1>
        <p className="text-sm text-muted">Sign in to manage the catalogue.</p>
      </header>

      <LoginForm />
    </main>
  );
}
