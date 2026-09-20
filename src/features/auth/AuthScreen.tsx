/**
 * Sign in, sign up, and password reset.
 *
 * One screen with three modes rather than three routes, because the common
 * case — "I typed the wrong password and actually need to register" — should
 * not lose what has already been typed.
 */

import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { Button, Callout, ErrorMessage, Panel, TextField } from '@/components/ui';
import { Disclaimer } from '@/app/AppShell';
import './auth.css';

type Mode = 'signin' | 'signup' | 'forgot';

const MIN_PASSWORD_LENGTH = 8;

export function AuthScreen() {
  const { signIn, signUp, requestPasswordReset } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (!email.trim()) {
      setError('Enter your email address.');
      return;
    }
    if (mode !== 'forgot' && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Passwords need to be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
      } else if (mode === 'signup') {
        const { needsConfirmation } = await signUp(email, password);
        if (needsConfirmation) {
          setNotice(
            'Account created. Check your email for a confirmation link, then come back and sign in.',
          );
        }
      } else {
        await requestPasswordReset(email);
        // Deliberately the same message whether or not the address exists —
        // otherwise this endpoint tells an attacker who has an account here.
        setNotice(
          'If there is an account for that address, a reset link is on its way. Check your inbox.',
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<Mode, string> = {
    signin: 'Sign in',
    signup: 'Create your account',
    forgot: 'Reset your password',
  };

  return (
    <main className="ns-auth">
      <div className="ns-auth__brand">
        <h1 className="ns-auth__title">
          Net<span>Shift</span>
        </h1>
        <p className="ns-auth__tagline">
          Pay, overtime, and paycheck planning built for shift work.
        </p>
      </div>

      <Panel title={titles[mode]}>
        <form onSubmit={handleSubmit} noValidate>
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          {mode !== 'forgot' && (
            <TextField
              label="Password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint={mode === 'signup' ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
            />
          )}

          <ErrorMessage>{error}</ErrorMessage>
          {notice && <Callout tone="success">{notice}</Callout>}

          <Button type="submit" variant="primary" full loading={busy}>
            {mode === 'signin'
              ? 'Sign in'
              : mode === 'signup'
                ? 'Create account'
                : 'Send reset link'}
          </Button>
        </form>

        <div className="ns-auth__switch">
          {mode === 'signin' && (
            <>
              <Button
                variant="link"
                onClick={() => {
                  setMode('signup');
                  setError(null);
                  setNotice(null);
                }}
              >
                Create an account
              </Button>
              <Button
                variant="link"
                onClick={() => {
                  setMode('forgot');
                  setError(null);
                  setNotice(null);
                }}
              >
                Forgot your password?
              </Button>
            </>
          )}
          {mode !== 'signin' && (
            <Button
              variant="link"
              onClick={() => {
                setMode('signin');
                setError(null);
                setNotice(null);
              }}
            >
              Back to sign in
            </Button>
          )}
        </div>
      </Panel>

      <div className="ns-auth__footer">
        <Disclaimer inline />
      </div>
    </main>
  );
}
