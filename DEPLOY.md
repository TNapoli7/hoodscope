# HoodScope — Deploy

Bubblemap + holder tracker for **Robinhood Chain** tokens (built around the **NOXA Fun** launchpad).
Pure static frontend — no build step, no backend required to go live. Everything is driven by a
single `config.json`.

## Structure
```
HoodScope/
├─ index.html          ← homepage (hero + CA search + recent NOXA chips + coin teaser)
├─ app.html            ← the scan page (CA search → HoodScore + bubblemap + clusters + holders)
├─ HoodScope_Preview.html ← self-contained offline preview (real GOLD scan) — open directly
├─ config.json         ← SINGLE config point (brand, chain, api, feed, coin, monetization)
├─ assets/
│  ├─ style.css        ← Robinhood-inspired design system
│  ├─ util.js          ← formatting / math helpers
│  ├─ api.js           ← Blockscout API client (direct or cached mode)
│  ├─ clusters.js      ← wallet cluster / insider detection (union-find)
│  ├─ score.js         ← HoodScore engine (0-100 trust score + grade + factors)
│  ├─ bubblemap.js     ← custom canvas force renderer (no dependencies)
│  ├─ gate.js          ← premium token-gating (stub, wire at coin launch)
│  └─ app.js           ← orchestration (search, scan pipeline, results render)
└─ supabase/           ← OPTIONAL caching layer (only for "cached" mode)
   ├─ schema.sql
   └─ functions/bs-proxy/index.ts
```

## Data source
Robinhood Chain (EVM L2, chainId **4663**) exposes a **Blockscout** API at
`https://robinhoodchain.blockscout.com/api/v2` with open CORS, so the browser reads holders,
transfers, and token lists directly — the tracker is **live on-chain from day one**, no backend.

## 1. Run locally
```bash
cd HoodScope
npx serve .            # or: python3 -m http.server
```
Open `http://localhost:3000`. Try a token, e.g. search **CASHCAT**.

## 2. Deploy the frontend (Vercel — same as Squirm)
```bash
cd HoodScope
vercel deploy --prod
```
That's the whole site. Point your domain at it in the Vercel dashboard. Done.
(Any static host works too: Netlify, Cloudflare Pages, Hostinger File Manager, GitHub Pages.)

## 3. (Optional) Turn on the caching layer
Only worth it once you have real traffic and start hitting Blockscout rate limits.
1. In Supabase: run `supabase/schema.sql` (SQL editor).
2. Deploy the function: `supabase functions deploy bs-proxy --no-verify-jwt`
   (it uses `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, injected automatically).
3. In `config.json` set:
   ```json
   "api": { "mode": "cached", "supabaseFnUrl": "https://<ref>.supabase.co/functions/v1/bs-proxy" }
   ```
Redeploy the frontend. Reads now flow through the cache and fall back to direct if it's down.

## 4. When the $HSCOPE coin launches on NOXA
Fill the `coin` block in `config.json` (the teaser button + gating read from it):
```json
"coin": {
  "symbol": "HSCOPE", "name": "HoodScope",
  "mint": "0x<TOKEN_ADDRESS>", "decimals": 18,
  "buyUrl": "https://fun.noxa.fi/robinhood/token/0x<TOKEN_ADDRESS>",
  "chartUrl": ""
}
```
The homepage coin section and the "Get $HSCOPE" buttons light up automatically.

## 5. Turn on premium (token-gating) — optional
The whole tracker is free by default. To gate premium limits/alerts behind holding the coin:
```json
"monetization": { "enabled": true, "gateMinBalance": 100000,
  "premiumFeatures": ["deeper-holders","full-cluster-scan","alerts","watchlist","csv-export"] }
```
`assets/gate.js` already implements EVM wallet connect + `balanceOf` on Robinhood Chain and
resolves free-vs-premium scan limits (`config.tracker.*Free` / `*Premium`). Add a "Connect
wallet" button that calls `HoodGate.connect()` and re-runs the load. Free users still get a
full, usable tracker — premium just goes deeper.

## Tuning (`config.json → tracker`)
| Field | Meaning |
|---|---|
| `topHoldersFree/Premium` | how many holders to plot |
| `edgeScanHoldersFree/Premium` | how many top wallets to trace for cluster links (heaviest cost) |
| `transfersPerHolder` | transfers pulled per scanned wallet |
| `clusterMinSupplyPctFlag` | cluster supply % that gets the amber "insider" flag |
| `hideKnownContracts` | hide LP pools / routers from the map by default |

## Feed: NOXA-only (and going multi-chain later)
The landing feed is **NOXA-only**. It reads the `TokenLaunched` events from NOXA's
`LauncherFactory` (`0xd9ec…fccb`, confirmed on-chain) and shows the newest launches, enriched
with live holder/market data. Token pages also show a **◆ NOXA verified** badge when the token's
`launchFactory()` matches the factory — proof it's a genuine NOXA launch, not a lookalike.

Controlled in `config.json → feed`:
```json
"feed": { "source": "noxa", "sort": "new", "limit": 24 }
```
- `source: "noxa"` → only NOXA launches. `source: "chain"` → all Robinhood Chain ERC-20s by volume.
- `sort: "new"` (launch order) or `"holders"` (traction).

**Expanding to other chains later:** NOXA runs the same factory pattern on every chain it supports.
To add a chain, point `chain.*` + `launchpad.factory` at that network (chain IDs and factory
addresses are in NOXA's docs), or generalize `config` into a per-chain list and add a chain switcher.
The whole data layer is chain-agnostic — only these config values change.

## Notes
- **Not affiliated** with Robinhood Markets, Inc. — this is independent analytics. The footer
  disclaimer says so; keep it.
