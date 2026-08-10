# NetShift — standalone version

This is NetShift converted to run outside Claude.ai: a static site (`public/`)
plus one small serverless function (`api/claude.js`) that holds your real
Anthropic API key so the browser never sees it. Storage that used to live in
the artifact's `window.storage` now lives in your browser's `localStorage`
instead — same idea, just tied to your own browser instead of Claude's.

Follow these steps in order. No coding required, but a couple of steps use
a terminal — copy/paste is all you need.

## Step 1 — Get an Anthropic API key

1. Go to **console.anthropic.com** and sign in (or create an account).
2. Go to **Settings → API Keys**.
3. Click **Create Key**, name it something like `netshift`, and copy the key
   it gives you (starts with `sk-ant-...`). You won't be able to see it again
   after you leave the page, so save it somewhere safe for now — you'll paste
   it into Vercel in Step 4.
4. This key is billed separately from your Claude.ai subscription — API use
   is pay-as-you-go. NetShift's calls (parsing a stub, refreshing prices, a
   market report) are small and cheap individually, but check
   **console.anthropic.com/settings/billing** to add a card and see current
   pricing before relying on this daily.

## Step 2 — Put this project on GitHub

1. Go to **github.com** and sign in (or create a free account).
2. Click the **+** in the top right → **New repository**. Name it `netshift`,
   leave it public or private (either works), and click **Create repository**.
3. On your computer, download this whole project folder from Claude (the
   file browser/download option where you got this from), then upload it to
   the new repo — easiest way: on the empty repo's page, click
   **uploading an existing file**, drag in every file and folder from this
   project, and commit.

   *(If you're comfortable with a terminal instead: `git init`, `git add .`,
   `git commit -m "netshift"`, then follow GitHub's "push an existing
   repository" instructions on your new repo's page.)*

## Step 3 — Deploy it on Vercel

1. Go to **vercel.com** and sign up using your GitHub account (this makes
   Step 3 and future updates one-click).
2. Click **Add New → Project**.
3. Find your `netshift` repo in the list and click **Import**.
4. Vercel will show build settings — you don't need to change anything, it
   auto-detects the `api/` folder and the `public/` static site. Don't hit
   Deploy yet — go to Step 4 first so the app has its API key from the start.

## Step 4 — Add your API key

1. Still on that import screen (or afterward under
   **Project → Settings → Environment Variables**), add a new variable:
   - Name: `ANTHROPIC_API_KEY`
   - Value: the `sk-ant-...` key from Step 1
2. Click **Deploy**.

## Step 5 — Open your app

1. Once the deploy finishes (takes under a minute), Vercel gives you a URL
   like `netshift-yourname.vercel.app`. Open it.
2. You should see NetShift exactly as it looked in Claude. Try uploading a
   pay stub or generating a market report to confirm the API key is wired up
   correctly.
3. Bookmark it, or add it to your phone's home screen (Safari/Chrome →
   Share → Add to Home Screen) so it opens like an app.

## What's different from the Claude.ai version

- **Your data now lives in this browser's storage**, not Claude's. It won't
  show up if you open the app on a different device or browser — it's
  local to wherever you're using it. If you clear your browser data, it's
  gone, so don't rely on it as your only copy of anything important.
- **Every AI feature (stub parsing, pay profile parsing, live prices, market
  reports) now costs a small amount of real money** via your Anthropic API
  key, since there's no Claude.ai subscription covering it anymore.
- **You own this now.** Want to change the colors, add a feature, fix a bug?
  Edit `public/app.jsx` directly, commit, push — Vercel redeploys
  automatically within a minute of every push to GitHub.

## Updating it later

Any time you want to change something: edit the files in your GitHub repo
(directly on github.com, or by pushing from your computer), and Vercel
redeploys automatically. No need to repeat the steps above.
