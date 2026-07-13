/* HoodScope — app orchestration. CA-only search, HoodScore, premium results page. */
(function (global) {
  'use strict';

  const CLPAL = ['#ff8f3f', '#c77dff', '#4dd2ff', '#ff5d8f', '#ffd23f', '#8f7dff', '#3fe0c5', '#ff6b6b'];
  const CA_RE = /^0x[a-fA-F0-9]{40}$/;
  let CFG = null;
  const state = { token: null, nodes: [], edges: [], clusters: [], nodeCluster: null, clusterColor: new Map(), hideContracts: true, score: null, isNoxa: false, map: null, activeCluster: null };

  async function boot() {
    CFG = await fetch('config.json').then((r) => r.json());
    HoodAPI.init(CFG); HoodGate.init(CFG);
    document.querySelectorAll('[data-brand]').forEach((e) => e.textContent = CFG.brand.name);
    return CFG;
  }

  /* ---------- CA-only search ---------- */
  function wireCA(inputSel, errSel) {
    const input = document.querySelector(inputSel);
    if (!input) return;
    const err = errSel && document.querySelector(errSel);
    const submit = () => {
      const v = input.value.trim();
      if (CA_RE.test(v)) { if (err) err.textContent = ''; go(v); }
      else if (err) err.textContent = v ? 'That is not a valid contract address (0x… 42 chars).' : 'Paste a token contract address.';
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (err) err.textContent = ''; });
    input.addEventListener('paste', () => setTimeout(submit, 30));
    const btn = input.parentElement.querySelector('[data-scan]');
    if (btn) btn.addEventListener('click', submit);
  }
  function go(addr) { location.href = 'app.html?t=' + addr; }

  /* ---------- landing ---------- */
  async function initHome() {
    await boot();
    wireCA('#hero-search', '#hero-err');
    const host = document.querySelector('#recent-strip');
    if (!host) return;
    try {
      const items = (await HoodAPI.noxaLaunches(10)).slice(0, 8);
      host.innerHTML = items.map((t) => {
        const sym = t.symbol || '?';
        return '<button class="chip" data-addr="' + t.address_hash + '"><span class="cd"></span>' + esc(sym) +
          ' <span class="faint">' + (t.holders_count ? U.fmtNum(+t.holders_count, 0) + ' hold' : 'new') + '</span></button>';
      }).join('');
      host.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => go(c.dataset.addr)));
    } catch (e) { host.innerHTML = ''; }
  }

  /* ---------- results page ---------- */
  async function initApp() {
    await boot();
    wireCA('#app-search', '#app-err');
    const addr = U.qs('t');
    if (!addr || !CA_RE.test(addr)) { document.querySelector('#app-root').innerHTML = emptyState(); return; }
    await loadToken(addr);
  }

  async function loadToken(addr) {
    const root = document.querySelector('#app-root');
    root.innerHTML = loading('Reading token…');
    let token;
    try { token = await HoodAPI.token(addr); }
    catch (e) { root.innerHTML = '<div class="empty"><h2 style="color:var(--text)">Token not found</h2><p>No ERC-20 at <span class="mono">' + esc(addr) + '</span> on Robinhood Chain.</p></div>'; return; }
    state.token = token;
    const dec = +token.decimals || 18;
    const supply = U.toUnits(token.total_supply, dec) || 1;

    root.querySelector('.lt') && (root.querySelector('.lt').textContent = 'Fetching holders…');
    const hLimit = HoodGate.limit('holders');
    const [holders, isNoxa] = await Promise.all([HoodAPI.holders(addr, hLimit), HoodAPI.isNoxa(addr).catch(() => false)]);
    state.isNoxa = isNoxa;

    state.nodes = holders.map((h) => {
      const amt = U.toUnits(h.value, dec);
      return { id: h.hash, pct: U.pct(amt, supply), amt, isContract: h.isContract, isScam: h.isScam, label: h.label };
    }).filter((n) => n.pct > 0);

    root.querySelector('.lt') && (root.querySelector('.lt').textContent = 'Mapping wallet connections…');
    const nodeIds = new Set(state.nodes.map((n) => n.id.toLowerCase()));
    const scan = state.nodes.filter((n) => !n.isContract).slice(0, HoodGate.limit('edgeScan'));
    const edgeMap = new Map();
    const funders = new Map();  // funder EOA -> Set(holder wallet) : catches dev-seeded wallets
    let done = 0; const lt = root.querySelector('.lt');
    const addEdge = (a, b) => { const k = a < b ? a + '|' + b : b + '|' + a; edgeMap.set(k, (edgeMap.get(k) || 0) + 1); };
    async function worker(q) {
      while (q.length) {
        const h = q.shift(); const hid = h.id.toLowerCase();
        let tr = [];
        try { tr = await HoodAPI.addrTransfers(h.id, addr, CFG.tracker.transfersPerHolder); } catch (e) {}
        for (const t of tr) {
          const a = (t.from || '').toLowerCase(), b = (t.to || '').toLowerCase();
          if (a === b) continue;
          if (nodeIds.has(a) && nodeIds.has(b) && !t.fromContract && !t.toContract) addEdge(a, b);           // direct wallet↔wallet
          if (b === hid && a && !t.fromContract && a !== hid && !/^0x0+$/.test(a)) (funders.get(a) || funders.set(a, new Set()).get(a)).add(hid); // common funder
        }
        done++; if (lt) lt.textContent = 'Mapping wallet connections… ' + done + '/' + scan.length;
      }
    }
    const q = scan.slice();
    await Promise.all(Array.from({ length: Math.min(6, q.length) }, () => worker(q)));
    for (const [, set] of funders) { if (set.size >= 2 && set.size <= 15) { const arr = [...set]; for (let i = 1; i < arr.length; i++) addEdge(arr[0], arr[i]); } }
    state.edges = [...edgeMap.entries()].map(([k, w]) => { const [s, tt] = k.split('|'); return { source: s, target: tt, weight: w }; });

    const cl = HoodClusters.detect(state.nodes, state.edges, { excludeContracts: true });
    state.clusters = cl.clusters; state.nodeCluster = cl.nodeCluster;
    state.clusterColor = new Map();
    state.clusters.forEach((c, i) => state.clusterColor.set(c.id, CLPAL[i % CLPAL.length]));

    // signals + score
    const walletsSorted = [...state.nodes].filter((n) => !n.isContract).sort((a, b) => b.pct - a.pct);
    const top10Wallet = walletsSorted.slice(0, 10).reduce((s, n) => s + n.pct, 0);
    const lpPct = state.nodes.filter((n) => n.isContract).reduce((s, n) => s + n.pct, 0);
    const isScam = state.nodes.some((n) => n.isScam) || token.reputation === 'scam';
    state.score = HoodScore.score({
      holdersCount: +token.holders_count || state.nodes.length,
      nodesCount: state.nodes.length,
      top10WalletPct: top10Wallet,
      largestClusterPct: state.clusters[0] ? state.clusters[0].supplyPct : 0,
      clusterCount: state.clusters.length,
      lpPct, isNoxa, isScam
    });

    renderTracker(top10Wallet, lpPct);
  }

  function nodeColor(n) {
    if (n.isScam) return '#ff4d4d';
    if (n.isContract) return '#69727d';
    const cid = state.nodeCluster.get(n.id.toLowerCase());
    if (cid && state.clusterColor.has(cid)) return state.clusterColor.get(cid);
    return '#00C805';
  }

  function renderTracker(top10Wallet, lpPct) {
    const t = state.token, root = document.querySelector('#app-root'), sc = state.score;
    const sym = t.symbol || '?';
    const icon = t.icon_url ? '<img src="' + t.icon_url + '">' : esc(sym.slice(0, 3));
    const holders = t.holders_count ? +t.holders_count : state.nodes.length;
    const clPct = state.clusters.reduce((s, c) => s + c.supplyPct, 0);

    root.innerHTML =
      '<div class="app-head">' +
        '<div class="token-id"><div class="ava">' + icon + '</div>' +
        '<div><h1>' + esc(t.name || sym) + ' <span class="faint">' + esc(sym) + '</span>' +
        (state.isNoxa ? ' <span class="badge g">◆ NOXA</span>' : ' <span class="badge n">non-NOXA</span>') + '</h1>' +
        '<div class="addr mono"><span id="copyca" title="copy">' + U.short(t.address_hash, 10) + '</span> · <a target="_blank" href="' + CFG.chain.explorer + '/token/' + t.address_hash + '">explorer ↗</a></div></div></div>' +
        '<div style="flex:1"></div>' +
        (t.circulating_market_cap ? '<div class="hm"><span>Market cap</span><b>' + U.fmtUsd(+t.circulating_market_cap) + '</b></div>' : '') +
        (CFG.coin && CFG.coin.buyUrl ? '<a class="btn primary sm" target="_blank" href="' + CFG.coin.buyUrl + '">Get $' + esc(CFG.coin.symbol) + '</a>' : '') +
      '</div>' +

      '<div class="verdict">' +
        '<div class="gauge">' + gauge(sc) + '</div>' +
        '<div class="vbody">' +
          '<div class="vtop"><span class="vlabel">HoodScore</span><span class="vband" style="color:' + sc.color + '">' + sc.band + '</span></div>' +
          '<div class="signals">' +
            signal(state.isNoxa ? 'ok' : 'warn', 'Liquidity', state.isNoxa ? 'Locked · NOXA' : (lpPct >= 3 ? U.fmtPct(lpPct) + ' in LP' : 'Not locked')) +
            signal(top10Wallet > 40 ? 'bad' : top10Wallet > 22 ? 'warn' : 'ok', 'Top 10 wallets', U.fmtPct(top10Wallet)) +
            signal(clPct > 15 ? 'bad' : state.clusters.length ? 'warn' : 'ok', 'Insider clusters', state.clusters.length ? state.clusters.length + ' · ' + U.fmtPct(clPct) : 'None') +
            signal(holders > 500 ? 'ok' : holders > 80 ? 'warn' : 'bad', 'Holders', U.fmtNum(holders, 0)) +
          '</div>' +
          '<div class="factorstrip">' + sc.factors.map(factorRow).join('') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="layout">' +
        '<div class="panel map-panel">' +
          '<canvas id="bubblemap"></canvas>' +
          clusterOverlay() +
          '<div class="map-controls">' +
            '<label class="chk"><input type="checkbox" id="tgl-contracts" ' + (state.hideContracts ? 'checked' : '') + '> Hide LP / contracts</label>' +
            '<button class="mbtn" id="map-reset" title="Reset view">Reset</button></div>' +
          '<div class="map-legend">' +
            legendItem('#00C805', 'Wallet') + legendItem('#ff8f3f', 'Cluster') +
            legendItem('#69727d', 'LP / contract') +
            '<span class="faint">bubble = % supply · scroll to zoom · drag to pan</span>' +
          '</div></div>' +
        '<div class="side">' + holdersPanel() + '</div>' +
      '</div>';

    drawMap();
    document.querySelector('#tgl-contracts').addEventListener('change', (e) => { state.hideContracts = e.target.checked; state.activeCluster = null; drawMap(); });
    document.querySelector('#map-reset').addEventListener('click', () => { state.activeCluster = null; drawMap(); });
    wireClusterUI();
    const ca = document.querySelector('#copyca');
    if (ca) ca.addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(t.address_hash); ca.textContent = 'copied ✓'; setTimeout(() => ca.textContent = U.short(t.address_hash, 10), 1200); });
  }

  const SIGN = { ok: { c: '#2fd16b', i: '✓' }, warn: { c: '#ffb020', i: '!' }, bad: { c: '#ff4d4d', i: '✕' } };
  function signal(state_, label, val) {
    const s = SIGN[state_];
    return '<div class="sig"><span class="sdot" style="background:' + s.c + '"></span>' +
      '<div class="sig-b"><div class="sig-l">' + label + '</div><div class="sig-v" style="color:' + s.c + '">' + val + '</div></div></div>';
  }

  function clusterOverlay() {
    if (!state.clusters.length)
      return '<div class="map-overlay"><div class="ov-head"><span class="ov-dot ok"></span>No insider clusters</div>' +
        '<div class="ov-note">Top holders were funded independently (mostly bought from the pool). Healthy sign.</div></div>';
    const rows = state.clusters.slice(0, 6).map((c, i) => {
      const col = state.clusterColor.get(c.id);
      return '<button class="ov-cl" data-ci="' + i + '"><span class="cdot" style="background:' + col + '"></span>' +
        '<span class="ov-cl-n">' + c.size + ' wallets</span><span class="ov-cl-p">' + U.fmtPct(c.supplyPct) + '</span></button>';
    }).join('');
    const total = state.clusters.reduce((s, c) => s + c.supplyPct, 0);
    return '<div class="map-overlay"><div class="ov-head"><span class="ov-dot ' + (total > 15 ? 'bad' : 'warn') + '"></span>' +
      state.clusters.length + ' cluster' + (state.clusters.length > 1 ? 's' : '') + ' · ' + U.fmtPct(total) + '</div>' +
      '<div class="ov-note">Linked wallets that may act together. Click to highlight.</div>' +
      '<div class="ov-list">' + rows + '</div>' +
      '<button class="ov-clear hide" id="ov-clear">Clear highlight</button></div>';
  }

  function wireClusterUI() {
    const clear = document.querySelector('#ov-clear');
    document.querySelectorAll('.ov-cl').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.ci;
      const on = state.activeCluster === i;
      document.querySelectorAll('.ov-cl').forEach((x) => x.classList.remove('on'));
      if (on) { state.activeCluster = null; state.map && state.map.setHighlight(null); clear && clear.classList.add('hide'); }
      else {
        state.activeCluster = i; b.classList.add('on');
        const ids = state.clusters[i].members.map((m) => m.id);
        state.map && state.map.setHighlight(ids);
        clear && clear.classList.remove('hide');
      }
    }));
    if (clear) clear.addEventListener('click', () => { state.activeCluster = null; state.map && state.map.setHighlight(null); document.querySelectorAll('.ov-cl').forEach((x) => x.classList.remove('on')); clear.classList.add('hide'); });
  }

  /* ---------- score gauge (SVG ring) ---------- */
  function gauge(sc) {
    const R = 58, C = 2 * Math.PI * R, off = C * (1 - sc.overall / 100);
    return '<svg viewBox="0 0 150 150" width="150" height="150">' +
      '<circle cx="75" cy="75" r="' + R + '" fill="none" stroke="#1e232b" stroke-width="13"/>' +
      '<circle cx="75" cy="75" r="' + R + '" fill="none" stroke="' + sc.color + '" stroke-width="13" stroke-linecap="round" ' +
        'stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 75 75)"/>' +
      '<text x="75" y="70" text-anchor="middle" font-size="40" font-weight="800" fill="#e9edf1">' + sc.overall + '</text>' +
      '<text x="75" y="95" text-anchor="middle" font-size="15" font-weight="700" fill="' + sc.color + '">' + sc.grade + '</text>' +
      '<text x="75" y="112" text-anchor="middle" font-size="9.5" fill="#69727d" letter-spacing="1">/ 100</text>' +
      '</svg>';
  }
  function factorRow(f) {
    const s = Math.round(f.score);
    const col = s >= 70 ? '#2fd16b' : s >= 45 ? '#ffb020' : '#ff4d4d';
    return '<div class="factor" title="' + esc(f.detail) + '"><div class="fh"><span class="fl">' + f.label + '</span><span class="fs" style="color:' + col + '">' + s + '</span></div>' +
      '<div class="fbar"><i style="width:' + s + '%;background:' + col + '"></i></div></div>';
  }

  /* ---------- map ---------- */
  function drawMap() {
    if (state.map) { state.map.destroy(); state.map = null; }
    let nodes = state.nodes.map((n) => ({
      id: n.id, pct: n.pct, isContract: n.isContract, isScam: n.isScam, label: n.label,
      clusterId: state.nodeCluster.get(n.id.toLowerCase()) || null, color: nodeColor(n)
    }));
    if (state.hideContracts) nodes = nodes.filter((n) => !n.isContract);
    const ids = new Set(nodes.map((n) => n.id.toLowerCase()));
    const links = state.edges.filter((e) => ids.has(e.source.toLowerCase()) && ids.has(e.target.toLowerCase()))
      .map((e) => ({ source: e.source, target: e.target }));
    const cv = document.querySelector('#bubblemap');
    state.map = HoodMap.render(cv, { nodes, links }, {
      onHover: (d, e) => tip(d, e),
      onSelect: (d) => window.open(CFG.chain.explorer + '/address/' + d.id, '_blank')
    });
  }

  function clustersPanel() {
    if (!state.clusters.length)
      return '<div class="panel"><div class="phead"><h3>Insider clusters</h3></div><div class="pbody faint">No linked wallet groups in the scanned set — holders look independent. Good sign.</div></div>';
    const body = state.clusters.slice(0, 6).map((c, i) => {
      const col = state.clusterColor.get(c.id);
      const flag = c.supplyPct >= CFG.tracker.clusterMinSupplyPctFlag;
      return '<div class="cluster" style="border-color:' + U.hexa(col, 0.4) + '">' +
        '<div class="ch"><span class="ct"><span class="cdot" style="background:' + col + '"></span>Cluster ' + (i + 1) + ' · ' + c.size + ' wallets</span>' +
        '<span class="badge ' + (flag ? 'a' : 'n') + '">' + U.fmtPct(c.supplyPct) + '</span></div>' +
        '<div class="cw mono">' + c.members.slice(0, 4).map((m) => U.short(m.id)).join(', ') + (c.size > 4 ? ' +' + (c.size - 4) : '') + '</div></div>';
    }).join('');
    return '<div class="panel"><div class="phead"><h3>Insider clusters</h3><span class="faint" style="font-size:12px">' + state.clusters.length + ' found</span></div><div class="pbody">' + body + '</div></div>';
  }

  function holdersPanel() {
    const top = [...state.nodes].sort((a, b) => b.pct - a.pct).slice(0, 20);
    const rows = top.map((n, i) => {
      const cid = state.nodeCluster.get(n.id.toLowerCase());
      const tag = n.isContract ? '<span class="badge n">' + esc(n.label || 'contract') + '</span>' : (cid ? '<span class="badge a">cluster</span>' : '');
      return '<div class="holder"><span class="rk">' + (i + 1) + '</span>' +
        '<span class="dotc" style="background:' + nodeColor(n) + '"></span>' +
        '<a class="h-addr" target="_blank" href="' + CFG.chain.explorer + '/address/' + n.id + '">' + (n.label ? esc(n.label) : U.short(n.id, 6)) + '</a>' +
        tag + '<span class="h-pct">' + U.fmtPct(n.pct) + '</span></div>';
    }).join('');
    return '<div class="panel"><div class="phead"><h3>Top holders</h3></div><div class="pbody scroll">' + rows + '</div></div>';
  }

  function tip(d, e) {
    const el = document.querySelector('#tip');
    if (!d) { el.style.display = 'none'; return; }
    const n = state.nodes.find((x) => x.id === d.id) || d;
    el.innerHTML = '<div class="t-addr">' + (n.label ? esc(n.label) + '<br>' : '') + U.short(d.id, 8) + '</div>' +
      '<div class="t-row"><span>Supply</span><b>' + U.fmtPct(n.pct) + '</b></div>' +
      (n.amt != null ? '<div class="t-row"><span>Balance</span><b>' + U.fmtNum(n.amt) + '</b></div>' : '') +
      '<div class="t-row"><span>Type</span><b>' + (d.isScam ? 'flagged' : d.isContract ? 'contract / LP' : d.clusterId ? 'insider cluster' : 'wallet') + '</b></div>';
    el.style.display = 'block';
    el.style.left = Math.min(e.clientX + 14, innerWidth - 300) + 'px';
    el.style.top = (e.clientY + 14) + 'px';
  }

  const stat = (k, v) => '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  const legendItem = (c, l) => '<span class="li"><span class="sw" style="background:' + c + '"></span>' + l + '</span>';
  const loading = (msg) => '<div class="loader"><div class="spin"></div><div class="lt">' + msg + '</div></div>';
  const emptyState = () => '<div class="empty"><h2 style="color:var(--text)">Paste a contract address to scan</h2><p>HoodScope only tracks token contracts (0x…). Drop a Robinhood Chain / NOXA token address above.</p></div>';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ---------- offline demo (used by HoodScope_Preview.html) ---------- */
  function demo(payload) {
    CFG = payload.cfg;
    HoodAPI.init(CFG); HoodGate.init(CFG);
    state.token = payload.token;
    state.nodes = payload.nodes;
    state.edges = payload.edges || [];
    const cl = HoodClusters.detect(state.nodes, state.edges, { excludeContracts: true });
    state.clusters = cl.clusters; state.nodeCluster = cl.nodeCluster;
    state.clusterColor = new Map();
    state.clusters.forEach((c, i) => state.clusterColor.set(c.id, CLPAL[i % CLPAL.length]));
    const wallets = [...state.nodes].filter((n) => !n.isContract).sort((a, b) => b.pct - a.pct);
    const top10 = wallets.slice(0, 10).reduce((s, n) => s + n.pct, 0);
    const lp = state.nodes.filter((n) => n.isContract).reduce((s, n) => s + n.pct, 0);
    state.isNoxa = !!payload.isNoxa;
    state.hideContracts = payload.hideContracts != null ? payload.hideContracts : true;
    state.score = HoodScore.score({
      holdersCount: +payload.token.holders_count || state.nodes.length, nodesCount: state.nodes.length,
      top10WalletPct: top10, largestClusterPct: state.clusters[0] ? state.clusters[0].supplyPct : 0,
      clusterCount: state.clusters.length, lpPct: lp, isNoxa: state.isNoxa, isScam: false
    });
    renderTracker(top10, lp);
  }

  global.HoodScope = { initHome, initApp, boot, demo };
})(window);
