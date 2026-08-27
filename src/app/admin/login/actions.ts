'use server';

import { redirect } from 'next/navigation';
import { IMPORT_PATH, LOGIN_PATH, requireAdminEnabled, signIn, signOut } from '../session';

export type LoginState = { readonly error: string | null };

export const attemptLogin = async (
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> => {
  requireAdminEnabled();

  const password = formData.get('password');
  // Not a string means the form was not the form — a hand-rolled POST. Same
  // answer as a wrong password; there is nothing to tell them.
  if (typeof password !== 'string') return { error: 'Wrong password.' };

  const result = await signIn(password);

  if (!result.ok) {
    if (result.reason === 'too_many_attempts') {
      const minutes = Math.ceil(result.retryAfterSeconds / 60);
      return { error: `Too many attempts. Try again in ${minutes} minute(s).` };
    }
    return { error: 'Wrong password.' };
  }

  // Outside the try/catch pattern deliberately: redirect() signals by throwing,
  // so it must be the last thing and must not sit inside anything that catches.
  redirect(IMPORT_PATH);
};

export const logOut = async (): Promise<void> => {
  await signOut();
  redirect(LOGIN_PATH);
};
