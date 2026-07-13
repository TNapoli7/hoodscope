/* HoodScope — premium token-gating (STUB, wire at coin launch).
   Robinhood Chain is EVM, so gating uses an injected EVM wallet (MetaMask/Rabbit/etc.)
   holding >= gateMinBalance of the HoodScope coin. Until config.monetization.enabled
   is true and config.coin.mint is set, isPremium() always returns false and the whole
   tracker runs with FREE limits — fully usable pre-launch. */
(function (global) {
  'use strict';
  let CFG = null, premium = false, addr = null;

  const Gate = {
    init(cfg) { CFG = cfg; return this; },
    enabled() { return !!(CFG.monetization && CFG.monetization.enabled && CFG.coin && CFG.coin.mint); },
    isPremium() { return premium; },
    address() { return addr; },

    async connect() {
      if (!this.enabled()) return { ok: false, reason: 'gating-off' };
      const eth = global.ethereum;
      if (!eth) return { ok: false, reason: 'no-wallet' };
      try {
        const accts = await eth.request({ method: 'eth_requestAccounts' });
        addr = accts[0];
        // ensure Robinhood Chain
        await switchChain(eth, CFG.chain.chainIdHex, CFG.chain);
        const bal = await erc20Balance(eth, CFG.coin.mint, addr);
        const min = BigInt(CFG.monetization.gateMinBalance) * (10n ** BigInt(CFG.coin.decimals || 18));
        premium = bal >= min;
        return { ok: true, premium, address: addr, balance: bal.toString() };
      } catch (e) { return { ok: false, reason: e.message }; }
    },

    // Feature limit resolver used across the app.
    limit(key) {
      const t = CFG.tracker;
      const map = {
        holders: premium ? t.topHoldersPremium : t.topHoldersFree,
        edgeScan: premium ? t.edgeScanHoldersPremium : t.edgeScanHoldersFree
      };
      return map[key];
    }
  };

  async function switchChain(eth, hexId, chain) {
    try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] }); }
    catch (e) {
      if (e.code === 4902) {
        await eth.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: hexId, chainName: chain.name,
          nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
          rpcUrls: [chain.rpcUrl], blockExplorerUrls: [chain.explorer]
        }] });
      }
    }
  }

  async function erc20Balance(eth, token, owner) {
    const data = '0x70a08231' + owner.slice(2).padStart(64, '0'); // balanceOf(address)
    const res = await eth.request({ method: 'eth_call', params: [{ to: token, data }, 'latest'] });
    return BigInt(res || '0x0');
  }

  global.HoodGate = Gate;
})(window);
