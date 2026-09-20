/**
 * The "set a new password" form reached from a reset email.
 *
 * Supabase signs the user in when they follow the link, so this screen is
 * shown *instead of* the app until a new password is set — otherwise a user
 * clicking a reset link would land on the dashboard with no way to finish.
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { Button, Callout, ErrorMessage, Panel, TextField } from '@/components/ui';
import './auth.css';

const MIN_PASSWORD_LENGTH = 8;

export function ResetPasswordScreen() {
  const { updatePassword, signOut, user } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Passwords need to be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await updatePassword(password);
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update your password.');
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <main className="ns-auth">
        <Panel title="Reset link expired">
          <p>
            This password reset link is no longer valid. Request a new one from the sign-in screen.
          </p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to sign in
          </Button>
        </Panel>
      </main>
    );
  }

  return (
    <main className="ns-auth">
      <Panel title="Choose a new password">
        {done ? (
          <>
            <Callout tone="success">Your password has been updated.</Callout>
            <Button variant="primary" full onClick={() => navigate('/')}>
              Continue to NetShift
            </Button>
          </>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            />
            <TextField
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
            <ErrorMessage>{error}</ErrorMessage>
            <Button type="submit" variant="primary" full loading={busy}>
              Update password
            </Button>
            <div className="ns-auth__switch">
              <Button variant="link" onClick={() => void signOut()}>
                Cancel and sign out
              </Button>
            </div>
          </form>
        )}
      </Panel>
    </main>
  );
}
