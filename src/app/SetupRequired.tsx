/**
 * Shown when the app is deployed without Supabase credentials.
 *
 * A blank screen or a cryptic console error is the worst possible outcome of a
 * missing environment variable, so this names exactly what is missing and
 * where to set it.
 */

import { Callout, Panel } from '@/components/ui';

export function SetupRequired() {
  return (
    <main className="ns-setup">
      <Panel title="NetShift needs connecting to Supabase">
        <p>
          The app loaded, but it has no database to talk to. Two environment variables are missing:
        </p>
        <ul className="ns-setup__list">
          <li>
            <code>VITE_SUPABASE_URL</code>
          </li>
          <li>
            <code>VITE_SUPABASE_ANON_KEY</code>
          </li>
        </ul>
        <Callout tone="info">
          Locally, put them in <code>.env.local</code> (copy <code>.env.example</code>). On Vercel,
          set them under <strong>Project → Settings → Environment Variables</strong> and redeploy.
          Both values are safe to expose to the browser — row-level security, not key secrecy, is
          what protects your data.
        </Callout>
        <p className="ns-setup__footer">
          Full setup instructions are in the project&rsquo;s <code>README.md</code>.
        </p>
      </Panel>
    </main>
  );
}
