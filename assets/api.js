/* HoodScope — Blockscout API client for Robinhood Chain.
   All reads go through here. Direct mode calls Blockscout (CORS open); cached mode
   tries the Supabase edge function first, then falls back to direct. */
(function (global) {
  'use strict';

  let CFG = null;
  const cache = new Map();

  function base() { return CFG.api.blockscoutBase; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function buildUrl(path, params) {
    // cached mode: route through the Supabase edge proxy (adds caching); else direct to Blockscout.
    if (CFG.api.mode === 'cached' && CFG.api.supabaseFnUrl) {
      const u = new URL(CFG.api.supabaseFnUrl);
      u.searchParams.set('path', path);
      if (params) Object.entries(params).forEach(([k, v]) => v != null && u.searchParams.set(k, v));
      return u;
    }
    const u = new URL(base() + path);
    if (params) Object.entries(params).forEach(([k, v]) => v != null && u.searchParams.set(k, v));
    return u;
  }

  async function raw(path, params) {
    const url = buildUrl(path, params);
    const key = url.toString();
    if (cache.has(key)) return cache.get(key);
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('API ' + res.status + ' ' + path);
    const json = await res.json();
    cache.set(key, json);
    return json;
  }

  // Retry wrapper (Blockscout occasionally 500s transiently).
  async function get(path, params, tries = 3) {
    let err;
    for (let i = 0; i < tries; i++) {
      try { return await raw(path, params); }
      catch (e) { err = e; await sleep(250 * (i + 1)); }
    }
    throw err;
  }

  const API = {
    init(cfg) { CFG = cfg; return this; },
    clearCache() { cache.clear(); },

    /* ---- token metadata ---- */
    async token(addr) {
      return get('/tokens/' + addr);
    },

    /* ---- trending / explore: top ERC-20 tokens ---- */
    async tokens(q) {
      const p = { type: 'ERC-20' };
      if (q) p.q = q;
      const r = await get('/tokens', p);
      return (r.items || []);
    },

    /* ---- NOXA-only feed: recent launches from the LauncherFactory ----
       Reads TokenLaunched logs (topic1 = token) newest-first, dedupes, then enriches
       each with token metadata. Returns [{address_hash, symbol, name, holders_count, ...}]. */
    async noxaLaunches(limit) {
      const lp = CFG.launchpad;
      const r = await get('/addresses/' + lp.factory + '/logs');
      const topic = lp.tokenLaunchedTopic.toLowerCase();
      const seen = new Set();
      const addrs = [];
      for (const l of (r.items || [])) {
        const t0 = l.topics && l.topics[0] && l.topics[0].toLowerCase();
        if (t0 !== topic || !l.topics[1]) continue;
        const token = '0x' + l.topics[1].slice(-40);
        if (seen.has(token)) continue;
        seen.add(token);
        addrs.push(token);
        if (addrs.length >= limit) break;
      }
      // enrich with limited concurrency, preserving launch order
      const out = new Array(addrs.length);
      let i = 0;
      async function worker() {
        while (i < addrs.length) {
          const idx = i++;
          try { const t = await get('/tokens/' + addrs[idx]); out[idx] = t && t.address_hash ? t : { address_hash: addrs[idx], symbol: '?', name: 'New token' }; }
          catch (e) { out[idx] = { address_hash: addrs[idx], symbol: '?', name: 'New token' }; }
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, addrs.length) }, worker));
      return out.filter(Boolean);
    },

    /* ---- creator/dev holdings: deployer from the TokenLaunched event + its live balance ----
       Returns { deployer, balanceRaw } or null (non-NOXA / not found). */
    async creator(tokenAddr) {
      const lp = CFG.launchpad;
      if (!lp || !lp.factory) return null;
      const padded = '0x' + tokenAddr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      let deployer = null;
      try {
        const r = await get('/addresses/' + lp.factory + '/logs', { topic: padded });
        const topic0 = (lp.tokenLaunchedTopic || '').toLowerCase();
        const log = (r.items || []).find((l) => l.topics && (l.topics[0] || '').toLowerCase() === topic0 && (l.topics[1] || '').toLowerCase() === padded);
        if (log && log.topics[2]) deployer = '0x' + log.topics[2].slice(-40);
      } catch (e) { return null; }
      if (!deployer || /^0x0+$/.test(deployer)) return null;
      let balanceRaw = '0';
      try {
        const data = '0x70a08231' + deployer.slice(2).padStart(64, '0');
        const res = await fetch(CFG.chain.rpcUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddr, data }, 'latest'] })
        }).then((r) => r.json());
        if (res.result && res.result !== '0x') balanceRaw = BigInt(res.result).toString();
      } catch (e) {}
      return { deployer, balanceRaw };
    },

    /* ---- resolve the token's LP pool address on-chain (NOXA liquidityPool()) ---- */
    async poolAddress(tokenAddr) {
      const sel = CFG.launchpad && CFG.launchpad.liquidityPoolSelector;
      if (!sel) return null;
      try {
        const res = await fetch(CFG.chain.rpcUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddr, data: sel }, 'latest'] })
        }).then((r) => r.json());
        if (res.result && res.result !== '0x') {
          const a = '0x' + res.result.slice(-40).toLowerCase();
          if (!/^0x0+$/.test(a)) return a;
        }
      } catch (e) {}
      return null;
    },

    /* ---- verify a token was launched via NOXA (token.launchFactory() == factory) ---- */
    async isNoxa(tokenAddr) {
      try {
        const res = await fetch(CFG.chain.rpcUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
            params: [{ to: tokenAddr, data: CFG.launchpad.launchFactorySelector }, 'latest'] })
        }).then((r) => r.json());
        if (!res.result || res.result === '0x') return false;
        const got = '0x' + res.result.slice(-40).toLowerCase();
        return got === CFG.launchpad.factory.toLowerCase();
      } catch (e) { return false; }
    },

    /* ---- search by name / symbol / address ---- */
    async search(q) {
      const r = await get('/search', { q });
      return (r.items || []).filter((i) =>
        (i.type === 'token' || i.token_type === 'ERC-20' || i.is_smart_contract_address) &&
        i.address_hash);
    },

    /* ---- holders (paged). Returns [{address, hash, isContract, label, value}] ---- */
    async holders(addr, limit) {
      const out = [];
      let params = { items_count: 50 };
      let guard = 0;
      while (out.length < limit && guard < 12) {
        const r = await get('/tokens/' + addr + '/holders', params);
        const items = r.items || [];
        for (const it of items) {
          const a = it.address || {};
          out.push({
            hash: a.hash,
            isContract: !!a.is_contract,
            isScam: !!a.is_scam,
            label: labelOf(a),
            value: it.value
          });
          if (out.length >= limit) break;
        }
        if (!r.next_page_params || items.length === 0) break;
        params = Object.assign({ items_count: 50 }, r.next_page_params);
        guard++;
        await sleep(CFG.api.requestDelayMs);
      }
      return out;
    },

    /* ---- transfers of a token for one address (for graph edges) ----
       Returns [{from, to, value, ts}] limited to `perHolder`. */
    async addrTransfers(addr, token, perHolder) {
      const r = await get('/addresses/' + addr + '/token-transfers', { token, type: 'ERC-20' });
      const items = (r.items || []).slice(0, perHolder);
      return items.map((t) => ({
        from: (t.from && t.from.hash) || null,
        to: (t.to && t.to.hash) || null,
        fromContract: !!(t.from && t.from.is_contract),
        toContract: !!(t.to && t.to.is_contract),
        value: t.total ? t.total.value : t.value,
        ts: t.timestamp,
        method: t.method
      })).filter((t) => t.from && t.to);
    },

    /* ---- recent transfers of the whole token (activity) ---- */
    async tokenTransfers(addr, n) {
      const r = await get('/tokens/' + addr + '/transfers');
      return (r.items || []).slice(0, n || 20).map((t) => ({
        from: (t.from && t.from.hash) || null,
        to: (t.to && t.to.hash) || null,
        fromLabel: t.from ? labelOf(t.from) : null,
        toLabel: t.to ? labelOf(t.to) : null,
        value: t.total ? t.total.value : t.value,
        ts: t.timestamp
      }));
    }
  };

  function labelOf(a) {
    if (!a) return null;
    if (a.name) return a.name;
    const tags = a.metadata && a.metadata.tags;
    if (tags && tags.length) { const nm = tags.find((t) => t.tagType === 'name'); if (nm) return nm.name; }
    if (a.ens_domain_name) return a.ens_domain_name;
    return null;
  }

  API.labelOf = labelOf;
  global.HoodAPI = API;
})(window);
