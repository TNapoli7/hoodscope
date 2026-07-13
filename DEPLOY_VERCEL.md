# HoodScope — go live on Vercel

The project is deploy-ready: static site, `vercel.json` configured, git repo committed,
previews and scratch files excluded via `.vercelignore`. No build step.

## Fastest — Vercel CLI (live in ~2 min)
Open Terminal and run:

```bash
cd "/Users/tomasnapoles/Desktop/ClaudeTN/CLAUDE OUTPUTS/SolanaSlither/HoodScope"
npx vercel@latest --prod
```

First run asks a few questions — just accept the defaults:
- **Set up and deploy?** → `y`
- **Which scope?** → your account
- **Link to existing project?** → `n`
- **Project name?** → `hoodscope` (Enter)
- **In which directory is your code?** → `./` (Enter)
- It auto-detects "Other / static". Accept.

It prints a live URL like `https://hoodscope.vercel.app`. Done. Re-deploy anytime with
the same command.

## GitHub + Vercel (auto-deploy + easy domain) — chosen path
Every `git push` auto-deploys, and adding the domain later is one click.

**1. Fresh git repo (run on your Mac).** Start clean to avoid any stale locks:
```bash
cd "/Users/tomasnapoles/Desktop/ClaudeTN/CLAUDE OUTPUTS/SolanaSlither/HoodScope"
rm -rf .git
git init -b main
git add -A
git commit -m "HoodScope — initial deploy build"
```

**2. Create the repo + push.**
- If you have the GitHub CLI (`gh`), one command does it all:
  ```bash
  gh repo create hoodscope --public --source=. --remote=origin --push
  ```
- Otherwise: create an empty repo at github.com/new named `hoodscope` (no README), then:
  ```bash
  git remote add origin https://github.com/<your-username>/hoodscope.git
  git push -u origin main
  ```

**3. Import on Vercel.** vercel.com → **Add New → Project → Import** `hoodscope` →
Framework preset **Other**, Root directory `./` → **Deploy**. Live in ~30s, and every
push from now on redeploys automatically.

## Add your real domain (later)
Vercel dashboard → your project → **Settings → Domains → Add**. Enter the domain
(e.g. `hoodscope.xyz`), then point DNS at Vercel:
- `A` `@` → `76.76.21.21`, or
- `CNAME` `www` → `cname.vercel-dns.com`

Vercel issues SSL automatically. Same flow whether the domain is bought on Vercel,
Hostinger, Namecheap, etc.

## Notes
- The site reads **live** on-chain data client-side (Blockscout, open CORS) — nothing to
  configure server-side. It works the instant it's deployed.
- No secrets in the repo. `config.json` only holds public endpoints.
- The optional Supabase caching layer (`supabase/`) is separate and NOT needed to go live.
- When the $SCOPE token launches, fill `config.json → coin` and the teaser + buttons light up.
