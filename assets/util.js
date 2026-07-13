/* HoodScope — formatting + helpers */
(function (global) {
  'use strict';

  function short(addr, l) {
    if (!addr) return '';
    l = l || 4;
    return addr.slice(0, 2 + l) + '…' + addr.slice(-l);
  }

  // BigInt-safe: value string / 10^decimals -> Number (fine for display/ratios)
  function toUnits(value, decimals) {
    try {
      const v = BigInt(value || '0');
      const d = BigInt(decimals || 0);
      const div = 10n ** d;
      const whole = v / div;
      const frac = v % div;
      return Number(whole) + Number(frac) / Number(div);
    } catch (e) { return Number(value) / Math.pow(10, decimals || 0); }
  }

  function pct(part, whole) {
    if (!whole) return 0;
    return (part / whole) * 100;
  }

  function fmtNum(n, dp) {
    if (n == null || isNaN(n)) return '–';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(dp ?? 2) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(dp ?? 2) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(dp ?? 1) + 'K';
    if (abs >= 1) return n.toFixed(dp ?? 2);
    return n.toPrecision(2);
  }

  function fmtUsd(n) {
    if (n == null || isNaN(n)) return '–';
    return '$' + fmtNum(n);
  }

  function fmtPct(n) {
    if (n == null || isNaN(n)) return '–';
    return n.toFixed(n < 1 ? 2 : 1) + '%';
  }

  function ago(ts) {
    if (!ts) return '';
    const s = (Date.now() - new Date(ts).getTime()) / 1000;
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  // Deterministic color from a string (for cluster hues)
  function hueOf(str, sat, light) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return 'hsl(' + h + ',' + (sat || 62) + '%,' + (light || 58) + '%)';
  }

  function riskLabel(top10pct, biggestCluster) {
    const score = Math.max(top10pct, biggestCluster * 1.2);
    if (score >= 60) return { t: 'High risk', c: 'r' };
    if (score >= 35) return { t: 'Elevated', c: 'a' };
    return { t: 'Healthy spread', c: 'g' };
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function hexa(hex, a) {
    const c = hex.replace('#', '');
    return 'rgba(' + parseInt(c.slice(0, 2), 16) + ',' + parseInt(c.slice(2, 4), 16) + ',' + parseInt(c.slice(4, 6), 16) + ',' + a + ')';
  }

  global.U = { short, toUnits, pct, fmtNum, fmtUsd, fmtPct, ago, hueOf, riskLabel, qs, hexa };
})(window);
