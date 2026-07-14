/* HoodScope — HoodScore engine.
   Turns on-chain signals into a 0-100 trust score + letter grade + factor breakdown.
   Higher = healthier distribution / lower rug risk. Heuristic, not financial advice. */
(function (global) {
  'use strict';

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // Each factor returns { score:0-100, detail } and carries a weight.
  function score(sig) {
    const holders = sig.holdersCount || sig.nodesCount || 0;
    const conc = sig.top10WalletPct || 0;             // top-10 wallet concentration
    const other = sig.otherContractPct || 0;          // non-pool contracts (multisig/vesting) = hidden supply
    const cluster = sig.largestClusterPct || 0;
    const clusterCount = sig.clusterCount || 0;
    const pool = sig.poolPct || 0;                    // supply sitting in the LP pool only
    const creatorPct = sig.creatorPct;                // null = unknown
    const isNoxa = !!sig.isNoxa;
    const isScam = !!sig.isScam;

    // 1. Distribution — top wallets AND supply parked in non-pool contracts both count as concentration.
    const effConc = conc + other;
    const distribution = clamp(100 - Math.max(0, effConc - 8) * 2.6, 0, 100);
    // 2. Insider clusters.
    const clusters = clamp(100 - cluster * 6 - Math.max(0, clusterCount - 1) * 4, 0, 100);
    // 3. Creator holdings — a dev sitting on a big bag can dump. Unknown = mild neutral.
    const creatorScore = creatorPct == null ? 65 : clamp(100 - Math.max(0, creatorPct - 2) * 5, 0, 100);
    // 4. Holder base — log scale, ~5k = full marks.
    const base = holders > 0 ? clamp((Math.log10(holders) / Math.log10(5000)) * 100, 0, 100) : 0;
    // 5. Liquidity — NOXA locks the LP permanently; real pool share = trustworthy.
    let liquidity;
    if (isNoxa && pool >= 3) liquidity = 92;
    else if (isNoxa) liquidity = 78;
    else if (pool >= 3) liquidity = 55;
    else liquidity = 22;
    // 6. Safety — hard flags.
    const safety = isScam ? 0 : 100;

    const factors = [
      { key: 'distribution', label: 'Distribution', weight: 0.30, score: distribution,
        detail: 'Top 10 wallets ' + conc.toFixed(1) + '%' + (other >= 1 ? ' · ' + other.toFixed(1) + '% in other contracts' : '') },
      { key: 'clusters', label: 'Insider clusters', weight: 0.22, score: clusters,
        detail: clusterCount ? clusterCount + ' cluster(s), largest ' + cluster.toFixed(1) + '%' : 'No linked wallet groups' },
      { key: 'creator', label: 'Creator supply', weight: 0.13, score: creatorScore,
        detail: creatorPct == null ? 'Creator holdings unknown' : 'Creator holds ' + creatorPct.toFixed(2) + '%' },
      { key: 'base', label: 'Holder base', weight: 0.13, score: base,
        detail: holders.toLocaleString() + ' holders' },
      { key: 'liquidity', label: 'Liquidity', weight: 0.15, score: liquidity,
        detail: isNoxa ? 'NOXA LP locked · ' + pool.toFixed(1) + '% in pool' : (pool >= 3 ? pool.toFixed(1) + '% in a pool' : 'No locked LP found') },
      { key: 'safety', label: 'Contract safety', weight: 0.07, score: safety,
        detail: isScam ? 'Flagged as scam' : 'No hard flags' }
    ];

    let overall = factors.reduce((s, f) => s + f.score * f.weight, 0);
    if (isScam) overall = Math.min(overall, 20);
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
