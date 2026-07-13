/* HoodScope — bubblemap engine (custom canvas, no dependencies).
   Cluster hulls, glowing gradient orbs, curved animated links, hover-highlight subgraph,
   zoom / pan / drag. This is the core visualization.
   API: HoodMap.render(canvas, {nodes, links}, {onHover, onSelect}) -> { destroy }
     nodes: [{id, pct, isContract, isScam, label, clusterId, color}]
     links: [{source, target}]  (ids) */
(function (global) {
  'use strict';

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function lighten(hex, amt) {
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    const m = (v) => Math.round(v + (255 - v) * amt);
    return 'rgb(' + m(r) + ',' + m(g) + ',' + m(b) + ')';
  }
  function rgba(hex, a) {
    const c = hex.replace('#', '');
    return 'rgba(' + parseInt(c.slice(0, 2), 16) + ',' + parseInt(c.slice(2, 4), 16) + ',' + parseInt(c.slice(4, 6), 16) + ',' + a + ')';
  }

  function render(canvas, data, handlers) {
    handlers = handlers || {};
    const ctx = canvas.getContext('2d');
    let DPR = 1, W = 0, H = 0, raf = 0, alpha = 1, t = 0;
    const cam = { x: 0, y: 0, k: 1 };
    let hoverId = null, dragNode = null, panning = false, last = null, moved = false, highlight = null;

    const maxPct = Math.max(0.001, Math.max.apply(null, data.nodes.map((n) => n.pct)));
    const rScale = 44;
    const nodes = data.nodes.map((n) => ({
      id: n.id, idl: n.id.toLowerCase(), pct: n.pct, isContract: n.isContract, isScam: n.isScam,
      label: n.label, clusterId: n.clusterId || null, color: n.color || '#00C805',
      x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null,
      r: 7 + Math.sqrt(n.pct / maxPct) * rScale
    }));
    const byId = new Map(nodes.map((n) => [n.idl, n]));
    const links = data.links.map((l) => ({ s: byId.get(l.source.toLowerCase()), t: byId.get(l.target.toLowerCase()) }))
      .filter((l) => l.s && l.t);

    // adjacency for hover-highlight
    const adj = new Map();
    nodes.forEach((n) => adj.set(n.idl, new Set()));
    links.forEach((l) => { adj.get(l.s.idl).add(l.t.idl); adj.get(l.t.idl).add(l.s.idl); });

    // seed positions on a spiral (looks intentional pre-settle)
    nodes.forEach((n, i) => {
      const a = i * 2.399, rr = 12 * Math.sqrt(i);
      n.x = Math.cos(a) * rr; n.y = Math.sin(a) * rr;
    });

    function resize() {
      DPR = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth || 800; H = canvas.clientHeight || 560;
      canvas.width = W * DPR; canvas.height = H * DPR;
      cam.x = W / 2; cam.y = H / 2;
    }
    resize();

    /* ---------- physics ---------- */
    function tick() {
      const cents = {};
      for (const n of nodes) if (n.clusterId) {
        const c = cents[n.clusterId] || (cents[n.clusterId] = { x: 0, y: 0, n: 0 });
        c.x += n.x; c.y += n.y; c.n++;
      }
      for (const k in cents) { cents[k].x /= cents[k].n; cents[k].y /= cents[k].n; }

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy || 1;
          const rep = -(a.r * b.r * 5.5) / d2;
          const d = Math.sqrt(d2), fx = dx / d * rep, fy = dy / d * rep;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          const md = a.r + b.r + 5;
          if (d < md) { const p = (md - d) * 0.5; a.vx -= dx / d * p; a.vy -= dy / d * p; b.vx += dx / d * p; b.vy += dy / d * p; }
        }
        // gravity: cluster centroid (tight) else world center (loose)
        if (a.clusterId) { const c = cents[a.clusterId]; a.vx += (c.x - a.x) * 0.045; a.vy += (c.y - a.y) * 0.045; }
        a.vx += (0 - a.x) * 0.008; a.vy += (0 - a.y) * 0.008;
      }
      for (const l of links) {
        let dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.hypot(dx, dy) || 1;
        const target = 46 + (l.s.r + l.t.r);
        const f = (d - target) * 0.03;
        l.s.vx += dx / d * f; l.s.vy += dy / d * f; l.t.vx -= dx / d * f; l.t.vy -= dy / d * f;
      }
      for (const n of nodes) {
        if (n === dragNode) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx * (0.4 + alpha); n.y += n.vy * (0.4 + alpha);
      }
      if (alpha > 0.02) alpha *= 0.985;
    }

    /* ---------- hull ---------- */
    function hull(pts) {
      if (pts.length < 3) return pts.slice();
      pts = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      const lo = [];
      for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      const up = [];
      for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
      lo.pop(); up.pop(); return lo.concat(up);
    }
    function expand(pts, cx, cy, pad) {
      return pts.map((p) => { const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1; return { x: p.x + dx / d * pad, y: p.y + dy / d * pad }; });
    }

    /* ---------- draw ---------- */
    function draw() {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // vignette + dot grid (screen space)
      const vg = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(0,200,5,0.06)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.translate(cam.x, cam.y); ctx.scale(cam.k, cam.k);

      const focus = hoverId ? adj.get(hoverId) : null;
      const dim = (id) => {
        if (highlight) return !highlight.has(id);
        return hoverId && id !== hoverId && !(focus && focus.has(id));
      };

      // cluster blobs
      const groups = {};
      for (const n of nodes) if (n.clusterId) (groups[n.clusterId] || (groups[n.clusterId] = [])).push(n);
      for (const k in groups) {
        const g = groups[k]; if (g.length < 2) continue;
        const col = g[0].color;
        let cx = 0, cy = 0; g.forEach((n) => { cx += n.x; cy += n.y; }); cx /= g.length; cy /= g.length;
        const pad = 22 + g[0].r * 0.4;
        let pts;
        if (g.length === 2) {
          const a = g[0], b = g[1], ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2, o = pad;
          pts = [{ x: a.x + Math.cos(ang) * o, y: a.y + Math.sin(ang) * o }, { x: b.x + Math.cos(ang) * o, y: b.y + Math.sin(ang) * o },
                 { x: b.x - Math.cos(ang) * o, y: b.y - Math.sin(ang) * o }, { x: a.x - Math.cos(ang) * o, y: a.y - Math.sin(ang) * o }];
        } else { pts = expand(hull(g), cx, cy, pad); }
        ctx.beginPath();
        const p0 = mid(pts[pts.length - 1], pts[0]); ctx.moveTo(p0.x, p0.y);
        for (let i = 0; i < pts.length; i++) { const cur = pts[i], nx = pts[(i + 1) % pts.length], m = mid(cur, nx); ctx.quadraticCurveTo(cur.x, cur.y, m.x, m.y); }
        ctx.closePath();
        ctx.fillStyle = rgba(col, hoverId ? 0.05 : 0.09); ctx.fill();
        ctx.lineWidth = 1.5 / cam.k; ctx.strokeStyle = rgba(col, 0.4); ctx.stroke();
      }

      // links (curved, animated flow)
      for (const l of links) {
        const incident = (focus && (l.s.idl === hoverId || l.t.idl === hoverId)) ||
          (highlight && highlight.has(l.s.idl) && highlight.has(l.t.idl));
        const faded = (hoverId || highlight) && !incident;
        const mx = (l.s.x + l.t.x) / 2, my = (l.s.y + l.t.y) / 2;
        const nx = -(l.t.y - l.s.y), ny = (l.t.x - l.s.x), nl = Math.hypot(nx, ny) || 1;
        const bow = Math.min(28, Math.hypot(l.t.x - l.s.x, l.t.y - l.s.y) * 0.12);
        const cxp = mx + nx / nl * bow, cyp = my + ny / nl * bow;
        const grad = ctx.createLinearGradient(l.s.x, l.s.y, l.t.x, l.t.y);
        grad.addColorStop(0, rgba(l.s.color, faded ? 0.05 : incident ? 0.85 : 0.32));
        grad.addColorStop(1, rgba(l.t.color, faded ? 0.05 : incident ? 0.85 : 0.32));
        ctx.strokeStyle = grad; ctx.lineWidth = (incident ? 2.4 : 1.2) / cam.k;
        ctx.setLineDash(incident ? [6 / cam.k, 6 / cam.k] : []);
        ctx.lineDashOffset = -t * (incident ? 0.09 : 0);
        ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.quadraticCurveTo(cxp, cyp, l.t.x, l.t.y); ctx.stroke();
        ctx.setLineDash([]);
      }

      // nodes
      for (const n of nodes) {
        const d = dim(n.idl);
        ctx.globalAlpha = d ? 0.16 : 1;
        const hov = n.idl === hoverId;
        if (hov || (focus && focus.has(n.idl))) { ctx.shadowColor = n.color; ctx.shadowBlur = 22; }
        const g = ctx.createRadialGradient(n.x - n.r * 0.35, n.y - n.r * 0.35, n.r * 0.1, n.x, n.y, n.r);
        if (n.isContract) { g.addColorStop(0, '#3a424d'); g.addColorStop(1, '#242a33'); }
        else { g.addColorStop(0, lighten(n.color, 0.55)); g.addColorStop(1, n.color); }
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7); ctx.fillStyle = g; ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = (hov ? 2.4 : 1.3) / cam.k;
        ctx.strokeStyle = n.isContract ? '#69727d' : (hov ? '#ffffff' : rgba(n.color, 0.9));
        if (n.isContract) ctx.setLineDash([4 / cam.k, 3 / cam.k]);
        ctx.stroke(); ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // labels (big nodes or hovered)
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const n of nodes) {
        const big = n.r * cam.k > 22;
        if (!big && n.idl !== hoverId) continue;
        if (dim(n.idl)) continue;
        const txt = n.isContract && n.label ? n.label : (n.label && n.label.length <= 10 ? n.label : n.pct.toFixed(1) + '%');
        ctx.font = '600 ' + (11 / cam.k) + 'px Inter, sans-serif';
        ctx.fillStyle = n.isContract ? '#c7ced6' : '#04140a';
        if (n.isContract) { ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3 / cam.k; ctx.strokeText(txt, n.x, n.y); }
        ctx.fillText(txt, n.x, n.y);
      }
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }

    function frame() {
      t++;
      if (alpha > 0.02 || dragNode) { tick(); tick(); }
      draw();
      raf = requestAnimationFrame(frame);
    }
    frame();

    /* ---------- interaction ---------- */
    const toWorld = (mx, my) => ({ x: (mx - cam.x) / cam.k, y: (my - cam.y) / cam.k });
    function pick(mx, my) {
      const w = toWorld(mx, my);
      let best = null, bd = Infinity;
      for (const n of nodes) { const dd = (n.x - w.x) ** 2 + (n.y - w.y) ** 2; if (dd < n.r * n.r && dd < bd) { bd = dd; best = n; } }
      return best;
    }
    function rel(e) { const r = canvas.getBoundingClientRect(); return { mx: e.clientX - r.left, my: e.clientY - r.top }; }

    function onMove(e) {
      const { mx, my } = rel(e);
      if (dragNode) { const w = toWorld(mx, my); dragNode.fx = w.x; dragNode.fy = w.y; moved = true; return; }
      if (panning) { cam.x += mx - last.mx; cam.y += my - last.my; last = { mx, my }; moved = true; return; }
      const n = pick(mx, my);
      const id = n ? n.idl : null;
      if (id !== hoverId) { hoverId = id; canvas.style.cursor = n ? 'pointer' : 'grab'; }
      if (handlers.onHover) handlers.onHover(n ? nodeOut(n) : null, e);
    }
    function onDown(e) {
      const { mx, my } = rel(e); last = { mx, my }; moved = false;
      const n = pick(mx, my);
      if (n) { dragNode = n; n.fx = n.x; n.fy = n.y; alpha = Math.max(alpha, 0.3); }
      else { panning = true; canvas.style.cursor = 'grabbing'; }
    }
    function onUp(e) {
      if (dragNode && !moved && handlers.onSelect) handlers.onSelect(nodeOut(dragNode));
      if (dragNode) { dragNode.fx = dragNode.fy = null; }
      dragNode = null; panning = false; canvas.style.cursor = 'grab';
    }
    function onWheel(e) {
      e.preventDefault();
      const { mx, my } = rel(e);
      const w = toWorld(mx, my);
      const k = clamp(cam.k * Math.exp(-e.deltaY * 0.0015), 0.35, 6);
      cam.k = k; cam.x = mx - w.x * k; cam.y = my - w.y * k;
    }
    function nodeOut(n) { return { id: n.id, pct: n.pct, isContract: n.isContract, isScam: n.isScam, label: n.label, clusterId: n.clusterId }; }

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mouseleave', () => { hoverId = null; handlers.onHover && handlers.onHover(null); });
    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    canvas.style.cursor = 'grab';

    return {
      setHighlight(ids) { highlight = ids && ids.length ? new Set(ids.map((s) => s.toLowerCase())) : null; alpha = Math.max(alpha, 0.06); },
      destroy() {
        cancelAnimationFrame(raf);
        canvas.removeEventListener('mousemove', onMove);
        canvas.removeEventListener('mousedown', onDown);
        window.removeEventListener('mouseup', onUp);
        canvas.removeEventListener('wheel', onWheel);
        window.removeEventListener('resize', onResize);
      }
    };
  }

  global.HoodMap = { render };
})(window);
