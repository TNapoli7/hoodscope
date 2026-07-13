/* HoodScope — HoodScore engine.
   Turns on-chain signals into a 0-100 trust score + letter grade + factor breakdown.
   Higher = healthier distribution / lower rug risk. Heuristic, not financial advice. */
(function (global) {
  'use strict';

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // Each factor returns { score:0-100, detail } and carries a weight.
  function score(sig) {
    const holders = sig.holdersCount || sig.nodesCount || 0;
    const conc = sig.top10WalletPct || 0;          // top-10 non-contract concentration
    const cluster = sig.largestClusterPct || 0;    // biggest linked-wallet group
    const clusterCount = sig.clusterCount || 0;
    const lp = sig.lpPct || 0;                      // supply held by contracts/LP
    const isNoxa = !!sig.isNoxa;
    const isScam = !!sig.isScam;

    // 1. Distribution — the single most important signal.
    const distribution = clamp(100 - Math.max(0, conc - 8) * 2.6, 0, 100);
    // 2. Insider clusters — connected wallets holding a big combined slice is the classic red flag.
    const clusters = clamp(100 - cluster * 6 - Math.max(0, clusterCount - 1) * 4, 0, 100);
    // 3. Holder base — more independent holders = harder to manipulate (log scale, 5k ~ full marks).
    const base = holders > 0 ? clamp((Math.log10(holders) / Math.log10(5000)) * 100, 0, 100) : 0;
    // 4. Liquidity — NOXA locks LP permanently; verified + real LP share = trustworthy.
    let liquidity;
    if (isNoxa && lp >= 3) liquidity = 92;
    else if (isNoxa) liquidity = 78;
    else if (lp >= 3) liquidity = 55;
    else liquidity = 22;
    // 5. Safety — hard flags.
    const safety = isScam ? 0 : 100;

    const factors = [
      { key: 'distribution', label: 'Holder distribution', weight: 0.35, score: distribution,
        detail: 'Top 10 wallets hold ' + conc.toFixed(1) + '%' },
      { key: 'clusters', label: 'Insider clusters', weight: 0.24, score: clusters,
        detail: clusterCount ? clusterCount + ' cluster(s), largest ' + cluster.toFixed(1) + '%' : 'No linked wallet groups' },
      { key: 'base', label: 'Holder base', weight: 0.15, score: base,
        detail: holders.toLocaleString() + ' holders' },
      { key: 'liquidity', label: 'Liquidity', weight: 0.16, score: liquidity,
        detail: isNoxa ? 'NOXA LP locked · ' + lp.toFixed(1) + '% in pool' : (lp >= 3 ? lp.toFixed(1) + '% in contracts' : 'No locked LP found') },
      { key: 'safety', label: 'Contract safety', weight: 0.10, score: safety,
        detail: isScam ? 'Flagged as scam' : 'No hard flags' }
    ];

    let overall = factors.reduce((s, f) => s + f.score * f.weight, 0);
    if (isScam) overall = Math.min(overall, 20); // scam flag caps the score hard
    overall = Math.round(overall);

    return Object.assign({ overall }, grade(overall), { factors });
  }

  function grade(s) {
    if (s >= 90) return { grade: 'A+', band: 'Very healthy', color: '#12d18e' };
    if (s >= 80) return { grade: 'A', band: 'Healthy', color: '#2fd16b' };
    if (s >= 70) return { grade: 'B', band: 'Decent', color: '#7ed321' };
    if (s >= 60) return { grade: 'C', band: 'Mixed', color: '#f5c518' };
    if (s >= 45) return { grade: 'D', band: 'Risky', color: '#ff9f1c' };
    return { grade: 'F', band: 'High risk', color: '#ff4d4d' };
  }

  global.HoodScore = { score, grade };
})(window);
