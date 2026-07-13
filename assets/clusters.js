/* HoodScope — wallet cluster / insider detection.
   Given holder nodes + transfer edges, group wallets connected by direct transfers
   (union-find over the holder graph) and flag clusters by combined supply %.
   Contracts (pools, routers, lockers) are excluded from "insider" clustering by default
   because everyone interacts with them — they'd create false links. */
(function (global) {
  'use strict';

  function detect(nodes, edges, opts) {
    opts = opts || {};
    const excludeContracts = opts.excludeContracts !== false;

    // index nodes by hash (lowercased)
    const byId = new Map();
    nodes.forEach((n) => byId.set(n.id.toLowerCase(), n));

    // union-find
    const parent = new Map();
    function find(x) {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
      return r;
    }
    function union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }
    nodes.forEach((n) => parent.set(n.id.toLowerCase(), n.id.toLowerCase()));

    const linkable = (id) => {
      const n = byId.get(id);
      if (!n) return false;
      if (excludeContracts && n.isContract) return false;
      return true;
    };

    let linkedEdges = 0;
    edges.forEach((e) => {
      const a = e.source.toLowerCase(), b = e.target.toLowerCase();
      if (!byId.has(a) || !byId.has(b)) return;
      if (!linkable(a) || !linkable(b)) return;
      union(a, b); linkedEdges++;
    });

    // group
    const groups = new Map();
    nodes.forEach((n) => {
      const id = n.id.toLowerCase();
      if (excludeContracts && n.isContract) return;
      const root = find(id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(n);
    });

    const clusters = [];
    let cid = 0;
    for (const [root, members] of groups) {
      if (members.length < 2) continue; // a cluster needs 2+ linked wallets
      const supplyPct = members.reduce((s, m) => s + (m.pct || 0), 0);
      clusters.push({
        id: 'c' + (cid++),
        root,
        members: members.sort((a, b) => b.pct - a.pct),
        size: members.length,
        supplyPct
      });
    }
    clusters.sort((a, b) => b.supplyPct - a.supplyPct);

    // tag each node with its clusterId (for coloring the map)
    const nodeCluster = new Map();
    clusters.forEach((c) => c.members.forEach((m) => nodeCluster.set(m.id.toLowerCase(), c.id)));

    return { clusters, nodeCluster, linkedEdges };
  }

  global.HoodClusters = { detect };
})(window);
