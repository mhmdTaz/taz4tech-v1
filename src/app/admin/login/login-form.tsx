'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { attemptLogin, type LoginState } from './actions';

const initial: LoginState = { error: null };

const SubmitButton = () => {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-accent px-4 py-2.5 font-medium text-void transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
    >
      {pending ? 'Checking…' : 'Sign in'}
    </button>
  );
};

export const LoginForm = () => {
  const [state, formAction] = useActionState(attemptLogin, initial);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label htmlFor="password" className="flex flex-col gap-2 text-sm text-muted">
        Password
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="rounded-lg border border-hairline bg-raised px-3 py-2.5 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          // Described by the error when there is one, so a screen reader reads
          // the reason with the field rather than leaving it to be found.
          aria-describedby={state.error === null ? undefined : 'login-error'}
          aria-invalid={state.error !== null}
        />
      </label>

      {state.error !== null && (
        // assertive: the operator has just submitted and is waiting on this
        // exact answer, so interrupting is the correct behaviour.
        <p id="login-error" role="alert" aria-live="assertive" className="text-sm text-negative">
          {state.error}
        </p>
      )}

      <SubmitButton />
    </form>
  );
};
