# Go Live — Steady Decker AI Assistant

Two steps: (1) deploy the backend to Render, (2) paste one line into your Shopify theme.

Your repo is already clean and deploy-ready: `.env` is gitignored (your secrets never leave your machine), and `render.yaml` is set up as a Render Blueprint.

---

## Step 1 — Push the code to GitHub

Render deploys from a Git repo. Create an empty repo on GitHub (no README/gitignore), then from the project folder run:

```bash
cd "/Users/alisinasabet/Desktop/SHsS_AGent"
git add -A && git commit -m "Deploy: storefront AI assistant" --allow-empty
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Only the source is pushed — `.env` and `node_modules/` stay local.

---

## Step 2 — Deploy on Render (Blueprint)

1. Go to https://dashboard.render.com → **New** → **Blueprint**.
2. Connect your GitHub account and pick the repo you just pushed.
3. Render reads `render.yaml` and proposes a web service named **storefront-ai-agent** (free plan, `npm install` → `npm start`). Click **Apply**.
4. When prompted, fill in the two secret env vars (these are marked `sync: false`, so Render asks for them — they are NOT in the repo):

   | Key | Value |
   |-----|-------|
   | `ANTHROPIC_API_KEY` | your `sk-ant-...` key (same one from your local `.env`) |
   | `SHOPIFY_STOREFRONT_TOKEN` | your Storefront API token (same one from your local `.env`) |

   `SHOPIFY_STORE_DOMAIN` is already set to `steadydecker.myshopify.com` in the blueprint. No `PORT` needed — Render sets it automatically.

5. Wait for the first deploy to finish. You'll get a public URL like:

   ```
   https://storefront-ai-agent.onrender.com
   ```

6. Verify it's up — open in a browser (or curl):

   ```
   https://storefront-ai-agent.onrender.com/health      → {"ok":true}
   https://storefront-ai-agent.onrender.com/widget.js    → serves the widget script
   https://storefront-ai-agent.onrender.com/preview      → live test page with the chat bubble
   ```

   Open `/preview` and try a message like "what products do you have?" — if it replies, the backend is fully live.

> **Free-plan note:** Render's free service sleeps after ~15 min idle, so the first request after a nap takes ~50s to wake (subsequent requests are instant). Fine for testing; upgrade to the paid Starter plan if you want it always-on for real shoppers.

---

## Step 3 — Add the widget to your Shopify store

Once you have your live Render URL, add this single line to your theme. In Shopify admin:

**Online Store → Themes → (your theme) → ⋯ → Edit code → `layout/theme.liquid`**

Paste this just before the closing `</body>` tag, replacing the URL with your actual Render URL:

```html
<script src="https://storefront-ai-agent.onrender.com/widget.js" defer></script>
```

Save. That's it — the chat bubble appears bottom-right on every storefront page. The widget auto-loads its own CSS and points its API calls back to whatever domain served `widget.js`, so there's nothing else to configure.

To remove it later, just delete that one line.

---

## Quick checklist

- [ ] GitHub repo created and pushed
- [ ] Render Blueprint applied, both secret env vars entered
- [ ] `/health` returns `{"ok":true}`
- [ ] `/preview` chat replies to a test message
- [ ] `<script>` line added before `</body>` in `theme.liquid`
- [ ] Chat bubble visible and working on the live store
