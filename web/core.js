/* dwg2cnc core - DWG/DXF geometry -> G-code for FLSK F2100B.
   JavaScript port of dwg2cnc.py (same algorithm, same output). */
(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mod = (a, n) => ((a % n) + n) % n;

  const DEFAULTS = {
    mode: 'G91', kerf: 'G41', holes: 'cut', min_hole_diameter: 0,
    lead_in_outer: 8, lead_in_hole: 6, center_pierce_max_radius: 30, start_point: 'corner', lead_out: 5,
    offset_x: 15, offset_y: 15, return_home: true, decimals: 3, ext: '.TXT',
    header_comment: true,
    ignore_layers: 'TEXT,DEFPOINTS,SCRIBE,DIM*,*DIMENSION*,MARK*,TITLE*',
    cut_layers: '', join_tolerance: 0.05, cut_speed: 360,
  };
  const truthy = v => v === true || /^(yes|y|true|1|ya)$/i.test(String(v));

  // ---------------------------------------------------------------- Seg
  class Seg {
    constructor(kind, p0, p1, c = null, ccw = true) { this.kind = kind; this.p0 = p0; this.p1 = p1; this.c = c; this.ccw = ccw; }
    get r() { return dist(this.c, this.p0); }
    reversed() { return new Seg(this.kind, this.p1, this.p0, this.c, !this.ccw); }
    sweep() {
      const a0 = Math.atan2(this.p0[1] - this.c[1], this.p0[0] - this.c[0]);
      const a1 = Math.atan2(this.p1[1] - this.c[1], this.p1[0] - this.c[0]);
      if (this.ccw) { const s = mod(a1 - a0, TAU); return s > 1e-12 ? s : TAU; }
      const s = mod(a0 - a1, TAU); return -(s > 1e-12 ? s : TAU);
    }
    length() { return this.kind === 'L' ? dist(this.p0, this.p1) : Math.abs(this.sweep()) * this.r; }
    points(stepDeg = 5) {
      if (this.kind === 'L') return [this.p1];
      const sw = this.sweep();
      const n = Math.max(2, Math.floor(Math.abs(sw * 180 / Math.PI) / stepDeg) + 1);
      const a0 = Math.atan2(this.p0[1] - this.c[1], this.p0[0] - this.c[0]);
      const r = this.r, out = [];
      for (let i = 1; i < n; i++) out.push([this.c[0] + r * Math.cos(a0 + sw * i / n), this.c[1] + r * Math.sin(a0 + sw * i / n)]);
      out.push(this.p1);
      return out;
    }
    midpoint() {
      if (this.kind === 'L') return [(this.p0[0] + this.p1[0]) / 2, (this.p0[1] + this.p1[1]) / 2];
      const a = Math.atan2(this.p0[1] - this.c[1], this.p0[0] - this.c[0]) + this.sweep() / 2;
      return [this.c[0] + this.r * Math.cos(a), this.c[1] + this.r * Math.sin(a)];
    }
    tangentAtMid() {
      let d;
      if (this.kind === 'L') d = [this.p1[0] - this.p0[0], this.p1[1] - this.p0[1]];
      else { const m = this.midpoint(); const v = [m[0] - this.c[0], m[1] - this.c[1]]; d = this.ccw ? [-v[1], v[0]] : [v[1], -v[0]]; }
      const n = Math.hypot(d[0], d[1]) || 1;
      return [d[0] / n, d[1] / n];
    }
    splitMid() { const m = this.midpoint(); return [new Seg(this.kind, this.p0, m, this.c, this.ccw), new Seg(this.kind, m, this.p1, this.c, this.ccw)]; }
    translated(dx, dy) { const t = p => [p[0] + dx, p[1] + dy]; return new Seg(this.kind, t(this.p0), t(this.p1), this.c ? t(this.c) : null, this.ccw); }
  }

  class Loop {
    constructor(segs, layer = '', circle = null, depth = 0) { this.segs = segs; this.layer = layer; this.circle = circle; this.depth = depth; this.children = []; }
    polygon() { const p = [this.segs[0].p0]; for (const s of this.segs) p.push(...s.points()); return p; }
    area() { const p = this.polygon(); let a = 0; for (let i = 0; i < p.length - 1; i++) a += p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1]; return a / 2; }
    bbox() { const p = this.polygon(); let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const q of p) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); } return [a, b, c, d]; }
    reversed() { const l = new Loop(this.segs.slice().reverse().map(s => s.reversed()), this.layer, this.circle, this.depth); l.children = this.children; return l; }
  }

  function pointInPoly(pt, poly) {
    const [x, y] = pt; let inside = false;
    for (let i = 0; i < poly.length - 1; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[i + 1];
      if ((y1 > y) !== (y2 > y) && x1 + (y - y1) * (x2 - x1) / (y2 - y1) > x) inside = !inside;
    }
    return inside;
  }

  // ------------------------------------------------- primitives -> segments
  // Primitives (WCS, radians): {t:'L',a,b} {t:'A',c,r,a0,a1,ccw} {t:'C',c,r}
  // {t:'P',pts:[[x,y,bulge]],closed} {t:'F',pts:[[x,y]]}; each carries .layer
  function bulgeCenter(p0, p1, b) {
    const theta = 4 * Math.atan(b);
    const chord = dist(p0, p1);
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const m = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const h = Math.sqrt(Math.max(r * r - (chord / 2) ** 2, 0));
    const u = [(p1[0] - p0[0]) / chord, (p1[1] - p0[1]) / chord];
    const left = [-u[1], u[0]];
    const sgn = (b > 0 ? 1 : -1) * (Math.abs(theta) < Math.PI ? 1 : -1);
    return [m[0] + left[0] * h * sgn, m[1] + left[1] * h * sgn];
  }

  function primToSegs(p) {
    if (p.t === 'L') return dist(p.a, p.b) > 1e-6 ? { segs: [new Seg('L', p.a, p.b)] } : { segs: [] };
    if (p.t === 'C') {
      const c = p.c, r = p.r, p0 = [c[0] + r, c[1]], p1 = [c[0] - r, c[1]];
      return { segs: [new Seg('A', p0, p1, c, true), new Seg('A', p1, p0, c, true)], circle: [c, r] };
    }
    if (p.t === 'A') {
      const c = p.c, r = p.r;
      const a = [c[0] + r * Math.cos(p.a0), c[1] + r * Math.sin(p.a0)];
      const b = [c[0] + r * Math.cos(p.a1), c[1] + r * Math.sin(p.a1)];
      if (dist(a, b) < 1e-6) {
        const q = [2 * c[0] - a[0], 2 * c[1] - a[1]];
        return { segs: [new Seg('A', a, q, c, p.ccw), new Seg('A', q, a, c, p.ccw)], circle: [c, r] };
      }
      return { segs: [new Seg('A', a, b, c, p.ccw)] };
    }
    if (p.t === 'P') {
      const pts = p.pts, n = pts.length, segs = [];
      const cnt = p.closed ? n : n - 1;
      for (let i = 0; i < cnt; i++) {
        const v0 = pts[i], v1 = pts[(i + 1) % n];
        const a = [v0[0], v0[1]], b = [v1[0], v1[1]];
        if (dist(a, b) <= 1e-6) continue;
        const bulge = v0[2] || 0;
        if (Math.abs(bulge) < 1e-9) segs.push(new Seg('L', a, b));
        else segs.push(new Seg('A', a, b, bulgeCenter(a, b, bulge), bulge > 0));
      }
      return { segs };
    }
    if (p.t === 'F') {
      const segs = [];
      for (let i = 0; i < p.pts.length - 1; i++) if (dist(p.pts[i], p.pts[i + 1]) > 1e-6) segs.push(new Seg('L', p.pts[i], p.pts[i + 1]));
      return { segs };
    }
    return { segs: [] };
  }

  function chain(segs, tol) {
    const cell = Math.max(tol * 4, 1e-3);
    const key = (p) => Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell);
    const grid = new Map();
    segs.forEach((s, i) => { for (const [end, p] of [[0, s.p0], [1, s.p1]]) { const k = key(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([i, end]); } });
    const used = new Array(segs.length).fill(false);
    const find = (p) => {
      const kx = Math.floor(p[0] / cell), ky = Math.floor(p[1] / cell); let best = null;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const [i, end] of grid.get((kx + dx) + ',' + (ky + dy)) || []) {
          if (used[i]) continue;
          const d = dist(p, end === 0 ? segs[i].p0 : segs[i].p1);
          if (d <= tol && (best === null || d < best[2])) best = [i, end, d];
        }
      }
      return best;
    };
    const loops = []; let open = 0;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const path = [segs[i]]; const start = path[0].p0; let closed = false;
      for (;;) {
        const cur = path[path.length - 1].p1;
        if (dist(cur, start) <= tol && (path.length > 1 || path[0].kind === 'A')) { closed = true; break; }
        const f = find(cur);
        if (!f) break;
        used[f[0]] = true;
        const s = f[1] === 0 ? segs[f[0]] : segs[f[0]].reversed();
        path.push(new Seg(s.kind, cur, s.p1, s.c, s.ccw));
      }
      if (closed) { const last = path[path.length - 1]; path[path.length - 1] = new Seg(last.kind, last.p0, start, last.c, last.ccw); loops.push(new Loop(path)); }
      else open++;
    }
    return { loops, open };
  }

  function detectCircle(loop) {
    if (loop.circle) return loop.circle;
    if (!loop.segs.every(s => s.kind === 'A')) return null;
    const c0 = loop.segs[0].c, r0 = loop.segs[0].r;
    if (loop.segs.some(s => dist(s.c, c0) > 0.01 || Math.abs(s.r - r0) > 0.01)) return null;
    const tot = loop.segs.reduce((a, s) => a + Math.abs(s.sweep()), 0);
    return Math.abs(tot - TAU) < 1e-3 ? [c0, r0] : null;
  }

  function wild(pattern) { return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); }
  function layerOk(layer, cfg) {
    const L = (layer || '0').toUpperCase();
    const ign = String(cfg.ignore_layers).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (ign.some(p => wild(p).test(L))) return false;
    const only = String(cfg.cut_layers).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    return !only.length || only.some(p => wild(p).test(L));
  }

  function dedupe(loops) {
    const seen = new Set(), out = [];
    for (const lp of loops) {
      const b = lp.bbox();
      const k = b.map(v => v.toFixed(2)).join(',') + ',' + Math.abs(lp.area()).toFixed(1);
      if (!seen.has(k)) { seen.add(k); out.push(lp); }
    }
    return out;
  }

  function buildLoops(prims, cfg) {
    const tol = +cfg.join_tolerance;
    const loops = [], byLayer = new Map(), used = new Set(), skipped = new Set();
    for (const p of prims) {
      if (!layerOk(p.layer, cfg)) { skipped.add(p.layer); continue; }
      const { segs, circle } = primToSegs(p);
      if (!segs.length) continue;
      used.add(p.layer);
      if (circle) loops.push(new Loop(segs, p.layer, circle));
      else { if (!byLayer.has(p.layer)) byLayer.set(p.layer, []); byLayer.get(p.layer).push(...segs); }
    }
    let open = 0;
    for (const [layer, segs] of byLayer) {
      const r = chain(segs, tol);
      for (const lp of r.loops) { lp.layer = layer; lp.circle = detectCircle(lp); }
      loops.push(...r.loops); open += r.open;
    }
    return { loops: dedupe(loops), open, layers: [...used].sort(), ignored: [...skipped].sort() };
  }

  // ------------------------------------------------------ parts & cuts
  function buildParts(loops) {
    const polys = loops.map(l => l.polygon()), areas = loops.map(l => Math.abs(l.area()));
    const parent = loops.map((lp, i) => {
      const probe = lp.segs[0].midpoint(); let best = null;
      for (let j = 0; j < loops.length; j++) {
        if (i !== j && areas[j] > areas[i] && pointInPoly(probe, polys[j]) && (best === null || areas[j] < areas[best])) best = j;
      }
      return best;
    });
    loops.forEach((lp, i) => { let d = 0, p = parent[i]; while (p !== null) { d++; p = parent[p]; } lp.depth = d; });
    const parts = [];
    loops.forEach((lp, i) => { if (lp.depth % 2 === 0) { lp.children = loops.filter((_, j) => parent[j] === i); parts.push(lp); } });
    return parts;
  }

  const orient = (loop, wantCcw) => ((loop.area() > 0) === wantCcw ? loop : loop.reversed());

  // Start at a corner (nearest to the torch zero). Lead-in comes from the scrap side along the
  // corner bisector. Parts without sharp corners start where a straight line meets an arc.
  function cornerStart(loop, poly, cfg, isHole) {
    const tanAt = (s, p) => {
      let d;
      if (s.kind === 'L') d = [s.p1[0] - s.p0[0], s.p1[1] - s.p0[1]];
      else { const v = [p[0] - s.c[0], p[1] - s.c[1]]; d = s.ccw ? [-v[1], v[0]] : [v[1], -v[0]]; }
      const m = Math.hypot(d[0], d[1]) || 1; return [d[0] / m, d[1] / m];
    };
    const n = loop.segs.length;
    let sharp = null, smooth = null;
    for (let k = 0; k < n; k++) {
      const a = loop.segs[(k - 1 + n) % n], b = loop.segs[k];
      const v = b.p0, ta = tanAt(a, v), tb = tanAt(b, v);
      const d = Math.hypot(v[0], v[1]);
      if (ta[0] * tb[0] + ta[1] * tb[1] > 0.996) {
        if ((a.kind === 'L') !== (b.kind === 'L') && (smooth === null || d < smooth[0] - 1e-6)) smooth = [d, k, ta, tb];
        continue;
      }
      const cross = ta[0] * tb[1] - ta[1] * tb[0];
      if (isHole ? cross < 1e-6 : cross > -1e-6) continue;
      if (sharp === null || d < sharp[0] - 1e-6) sharp = [d, k, ta, tb];
    }
    const best = sharp || smooth;
    if (!best) return null;
    const [, k, ta, tb] = best;
    const v = loop.segs[k].p0;
    let bis = [-ta[1] - tb[1], ta[0] + tb[0]];
    const L0 = Math.hypot(bis[0], bis[1]) || 1; bis = [bis[0] / L0, bis[1] / L0];
    const segs = [...loop.segs.slice(k), ...loop.segs.slice(0, k)];
    let L = +(isHole ? cfg.lead_in_hole : cfg.lead_in_outer), pierce = null;
    while (L >= 0.5) {
      const p = [v[0] + bis[0] * L, v[1] + bis[1] * L];
      if (pointInPoly(p, poly) === isHole) { pierce = p; break; }
      L /= 2;
    }
    if (!pierce) return null;
    const leadOut = +cfg.lead_out;
    const lo = leadOut > 0 ? [v[0] + bis[0] * Math.min(leadOut, L), v[1] + bis[1] * Math.min(leadOut, L)] : null;
    return { pierce, segs, leadOut: lo, hole: isHole };
  }

  function prepareCut(loop0, isHole, cfg) {
    const loop = orient(loop0, isHole);          // outer CW, hole CCW -> left side is scrap (G41)
    const leadOut = +cfg.lead_out;
    if (isHole && loop.circle) {
      const [c, r] = loop.circle;
      const start = [c[0] - r, c[1]], opp = [c[0] + r, c[1]];
      const segs = [new Seg('A', start, opp, c, true), new Seg('A', opp, start, c, true)];
      const toward = L => [start[0] + L, start[1]];
      const pierce = r <= +cfg.center_pierce_max_radius ? c : toward(Math.min(+cfg.lead_in_hole * 2, r * 0.6));
      return { pierce, segs, leadOut: leadOut > 0 ? toward(Math.min(leadOut, r * 0.5)) : null, hole: true };
    }
    const poly = loop.polygon();
    if (String(cfg.start_point || 'corner').toLowerCase() === 'corner') {
      const c = cornerStart(loop, poly, cfg, isHole);
      if (c) return c;
    }
    let k = 0;
    for (let i = 1; i < loop.segs.length; i++) {
      const a = loop.segs[i], b = loop.segs[k];
      const ka = a.kind !== 'L' ? 1 : 0, kb = b.kind !== 'L' ? 1 : 0;
      if (ka < kb || (ka === kb && -a.length() < -b.length())) k = i;
    }
    const [a, b] = loop.segs[k].splitMid();
    const segs = [b, ...loop.segs.slice(k + 1), ...loop.segs.slice(0, k), a];
    const start = b.p0;
    const t = loop.segs[k].tangentAtMid(), nrm = [-t[1], t[0]];
    let L = +(isHole ? cfg.lead_in_hole : cfg.lead_in_outer), pierce = start;
    while (L >= 0.5) {
      const p = [start[0] + nrm[0] * L, start[1] + nrm[1] * L];
      if (pointInPoly(p, poly) === isHole) { pierce = p; break; }
      L /= 2;
    }
    let lo = null;
    if (leadOut > 0 && pierce !== start) { const ll = Math.min(leadOut, L); lo = [start[0] + nrm[0] * ll, start[1] + nrm[1] * ll]; }
    return { pierce, segs, leadOut: lo, hole: isHole };
  }

  // -------------------------------------------------------------- G-code
  function rnd(v, d) { return +(Math.round(+(v + 'e' + d)) + 'e-' + d); }
  class GWriter {
    constructor(mode, dec) { this.mode = mode.toUpperCase(); this.dec = dec; this.lines = []; this.pos = [0, 0]; this.expected = []; this.cut = 0; this.rapid = 0; this.pierces = 0; }
    rp(p) { return [rnd(p[0], this.dec), rnd(p[1], this.dec)]; }
    f(v) {
      v = rnd(v, this.dec);
      if (Math.abs(v) < 0.5 * 10 ** -this.dec) v = 0;
      let s = v.toFixed(this.dec).replace(/0+$/, '');
      if (s.endsWith('.')) s += '0';
      return s === '-0.0' ? '0.0' : s;
    }
    xy(p) {
      p = this.rp(p);
      if (this.mode === 'G91') return ['X' + this.f(p[0] - this.pos[0]) + 'Y' + this.f(p[1] - this.pos[1]), p];
      return ['X' + this.f(p[0]) + 'Y' + this.f(p[1]), p];
    }
    raw(s) { this.lines.push(s); }
    move(code, p) {
      if (dist(this.rp(p), this.pos) < 10 ** -this.dec) return;
      const [w, pr] = this.xy(p), L = dist(this.pos, pr);
      if (code === 'G00') this.rapid += L; else this.cut += L;
      this.lines.push(code + w); this.pos = pr; this.expected.push(pr);
    }
    arc(s) {
      if (s.r > 1e5) return this.move('G01', s.p1);
      const i = s.c[0] - this.pos[0], j = s.c[1] - this.pos[1];
      const [w, pr] = this.xy(s.p1);
      this.lines.push((s.ccw ? 'G03' : 'G02') + w + 'I' + this.f(i) + 'J' + this.f(j));
      this.cut += s.length(); this.pos = pr; this.expected.push(pr);
    }
  }

  function generate(geom, cfg, name, texts) {
    if (!geom.loops.length) throw new Error('Tidak ada kontur tertutup yang bisa dipotong. Cek layer dan pastikan garis tersambung.');
    const parts = buildParts(geom.loops);
    const minHole = +cfg.min_hole_diameter; let skippedHoles = 0;
    const allB = parts.map(p => p.bbox());
    const minx = Math.min(...allB.map(b => b[0])), miny = Math.min(...allB.map(b => b[1]));
    // keep_coords: koordinat sudah posisi akhir di plat (hasil nesting), titik nol = pojok plat
    const dx = cfg.keep_coords ? 0 : +cfg.offset_x - minx, dy = cfg.keep_coords ? 0 : +cfg.offset_y - miny;
    const shift = lp => new Loop(lp.segs.map(s => s.translated(dx, dy)), lp.layer, lp.circle ? [[lp.circle[0][0] + dx, lp.circle[0][1] + dy], lp.circle[1]] : null, lp.depth);
    const jobs = parts.map(part => {
      const holes = [];
      for (const h of part.children) {
        const b = h.bbox();
        if (String(cfg.holes).toLowerCase() === 'skip' || Math.min(b[2] - b[0], b[3] - b[1]) < minHole) { skippedHoles++; continue; }
        holes.push(prepareCut(shift(h), true, cfg));
      }
      const sp = shift(part);
      return { holes, outer: prepareCut(sp, false, cfg), bbox: sp.bbox() };
    });
    const argmin = (arr, f) => { let bi = 0, bv = Infinity; arr.forEach((x, i) => { const v = f(x); if (v < bv) { bv = v; bi = i; } }); return bi; };
    const order = []; let cur = [0, 0]; const rem = jobs.map((_, i) => i);
    while (rem.length) {
      const k = rem.splice(argmin(rem, i => dist(cur, jobs[i].bbox)), 1)[0];
      const hs = jobs[k].holes.slice();
      while (hs.length) { const h = hs.splice(argmin(hs, c => dist(cur, c.pierce)), 1)[0]; order.push(h); cur = h.pierce; }
      order.push(jobs[k].outer); cur = jobs[k].outer.pierce;
    }
    const g = new GWriter(String(cfg.mode), +cfg.decimals);
    if (truthy(cfg.header_comment)) {
      let cm = (name + ' ' + texts.join(' ').slice(0, 40)).toUpperCase();
      cm = [...cm].filter(ch => /[A-Z0-9 \-+_.,/]/.test(ch)).join('').trim();
      g.raw('(' + cm + ')');
    }
    g.raw('G92X0Y0'); g.raw('G21'); g.raw(g.mode);
    const kerf = String(cfg.kerf).toUpperCase() === 'G41';
    for (const c of order) {
      g.move('G00', c.pierce);
      if (kerf) g.raw('G41');
      g.raw('M07'); g.pierces++;
      g.move('G01', c.segs[0].p0);
      for (const s of c.segs) { if (s.kind === 'L') g.move('G01', s.p1); else g.arc(s); }
      if (c.leadOut) g.move('G01', c.leadOut);
      g.raw('M08');
      if (kerf) g.raw('G40');
    }
    if (truthy(cfg.return_home)) g.move('G00', [0, 0]);
    g.raw('M02');
    const sim = simulate(g.lines);
    const errors = sim.errors.slice();
    if (sim.ends.length !== g.expected.length) errors.push(`jumlah gerakan ${sim.ends.length} != ${g.expected.length}`);
    else { const worst = Math.max(0, ...sim.ends.map((e, i) => dist(e, g.expected[i]))); if (worst > 0.002) errors.push(`posisi simulasi menyimpang ${worst.toFixed(4)} mm`); }
    const text = g.lines.join('\r\n') + '\r\n';
    return {
      lines: g.lines, text, moves: sim.moves, errors,
      stats: {
        name, parts: parts.length, holes: order.filter(c => c.hole).length, skippedHoles,
        pierces: g.pierces, cutLen: g.cut, rapidLen: g.rapid, lineCount: g.lines.length,
        bytes: text.length, open: geom.open, layers: geom.layers, ignored: geom.ignored, texts,
        size: [Math.max(...allB.map(b => b[2])) - minx, Math.max(...allB.map(b => b[3])) - miny],
      },
    };
  }

  function simulate(lines) {
    let absolute = false, pos = [0, 0], cutting = false;
    const moves = [], errors = [], ends = [];
    lines.forEach((raw, n) => {
      const line = raw.split('(')[0].trim(); if (!line) return;
      const w = {}; const re = /([A-Za-z])([-+.\d]*)/g; let m;
      while ((m = re.exec(line))) { const k = m[1].toUpperCase(); if (!(k in w)) w[k] = m[2]; }
      let code = null;
      if ('G' in w) { const gv = parseInt(w.G, 10); if (gv === 90 || gv === 91) absolute = gv === 90; else if (gv === 92) pos = [0, 0]; else if (gv >= 0 && gv <= 3) code = gv; }
      if ('M' in w) { const mv = parseInt(w.M, 10); if (mv === 7) cutting = true; else if (mv === 8) cutting = false; }
      if (code === null) return;
      const x = +(w.X || 0), y = +(w.Y || 0);
      const p1 = absolute ? [x, y] : [pos[0] + x, pos[1] + y];
      let c = null;
      if (code >= 2) { c = [pos[0] + +(w.I || 0), pos[1] + +(w.J || 0)]; if (Math.abs(dist(pos, c) - dist(p1, c)) > 0.01) errors.push(`baris ${n + 1}: radius busur tidak konsisten`); }
      if (code !== 0 && !cutting) errors.push(`baris ${n + 1}: gerak potong saat torch mati`);
      if (code === 0 && cutting) errors.push(`baris ${n + 1}: gerak cepat saat torch menyala`);
      moves.push({ code, p0: pos, p1, c }); pos = p1; ends.push(p1);
    });
    return { moves, errors, ends };
  }

  // ------------------------------------------------------------ readers
  const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const xform = (T, p) => [T.a * p[0] + T.c * p[1] + T.e, T.b * p[0] + T.d * p[1] + T.f];
  const compose = (T, U) => ({ a: T.a * U.a + T.c * U.b, b: T.b * U.a + T.d * U.b, c: T.a * U.c + T.c * U.d, d: T.b * U.c + T.d * U.d, e: T.a * U.e + T.c * U.f + T.e, f: T.b * U.e + T.d * U.f + T.f });
  function insertT(pt, sx, sy, rot, base) {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    return { a: cs * sx, b: sn * sx, c: -sn * sy, d: cs * sy, e: pt[0] - (cs * sx * base[0] - sn * sy * base[1]), f: pt[1] - (sn * sx * base[0] + cs * sy * base[1]) };
  }

  /** Transform a raw primitive (with optional OCS flip for extrusion -Z) into WCS. */
  function emit(out, prim, T, flipX) {
    const tp = p => xform(T, flipX ? [-p[0], p[1]] : p);
    const det = (T.a * T.d - T.b * T.c) * (flipX ? -1 : 1);
    const uniform = Math.abs(Math.hypot(T.a, T.b) - Math.hypot(T.c, T.d)) < 1e-9;
    const scale = Math.sqrt(Math.abs(T.a * T.d - T.b * T.c));
    if (prim.t === 'L') out.push({ t: 'L', a: tp(prim.a), b: tp(prim.b), layer: prim.layer });
    else if (prim.t === 'C' || prim.t === 'A') {
      if (!uniform) {
        const a0 = prim.t === 'C' ? 0 : prim.a0; let a1 = prim.t === 'C' ? TAU : prim.a1; if (a1 <= a0) a1 += TAU;
        const n = Math.max(8, Math.ceil((a1 - a0) / (Math.PI / 90))); const pts = [];
        for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push(tp([prim.c[0] + prim.r * Math.cos(a), prim.c[1] + prim.r * Math.sin(a)])); }
        out.push({ t: 'F', pts, layer: prim.layer }); return;
      }
      const c = tp(prim.c), r = prim.r * scale;
      if (prim.t === 'C') { out.push({ t: 'C', c, r, layer: prim.layer }); return; }
      const s = tp([prim.c[0] + prim.r * Math.cos(prim.a0), prim.c[1] + prim.r * Math.sin(prim.a0)]);
      const e = tp([prim.c[0] + prim.r * Math.cos(prim.a1), prim.c[1] + prim.r * Math.sin(prim.a1)]);
      out.push({ t: 'A', c, r, a0: Math.atan2(s[1] - c[1], s[0] - c[0]), a1: Math.atan2(e[1] - c[1], e[0] - c[0]), ccw: det > 0, layer: prim.layer });
    } else if (prim.t === 'P') {
      if (!uniform && prim.pts.some(v => v[2])) {
        const { segs } = primToSegs(prim); const pts = [segs[0].p0];
        for (const s of segs) pts.push(...s.points(2));
        out.push({ t: 'F', pts: pts.map(tp), layer: prim.layer }); return;
      }
      const pts = prim.pts.map(v => { const q = tp([v[0], v[1]]); return [q[0], q[1], (v[2] || 0) * (det > 0 ? 1 : -1)]; });
      out.push({ t: 'P', pts, closed: prim.closed, layer: prim.layer });
    } else if (prim.t === 'F') out.push({ t: 'F', pts: prim.pts.map(tp), layer: prim.layer });
  }

  function ellipsePts(c, maj, ratio, s, e) {
    if (e <= s) e += TAU; const n = Math.max(16, Math.ceil((e - s) / (Math.PI / 90)));
    const mn = [-maj[1] * ratio, maj[0] * ratio], pts = [];
    for (let i = 0; i <= n; i++) { const t = s + (e - s) * i / n; pts.push([c[0] + maj[0] * Math.cos(t) + mn[0] * Math.sin(t), c[1] + maj[1] * Math.cos(t) + mn[1] * Math.sin(t)]); }
    return pts;
  }
  function splinePts(deg, knots, ctrl, weights, fit) {
    if ((!ctrl || ctrl.length < 2) && fit && fit.length > 1) return fit;
    if (!ctrl || ctrl.length < 2) return [];
    const n = ctrl.length; deg = deg || 3;
    if (!knots || knots.length !== n + deg + 1) { knots = []; for (let i = 0; i < n + deg + 1; i++) knots.push(i <= deg ? 0 : i >= n ? 1 : (i - deg) / (n - deg)); }
    const w = weights && weights.length === n ? weights : ctrl.map(() => 1);
    const t0 = knots[deg], t1 = knots[n], steps = Math.max(32, n * 16), pts = [];
    for (let s = 0; s <= steps; s++) {
      const t = s === steps ? t1 : t0 + (t1 - t0) * s / steps;
      let k = deg; while (k < n - 1 && t >= knots[k + 1]) k++;
      const d = []; for (let j = 0; j <= deg; j++) { const P = ctrl[k - deg + j], ww = w[k - deg + j]; d.push([P[0] * ww, P[1] * ww, ww]); }
      for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
        const i = k - deg + j, den = knots[i + deg - r + 1] - knots[i]; const a = den ? (t - knots[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
      pts.push([d[deg][0] / d[deg][2], d[deg][1] / d[deg][2]]);
    }
    return pts;
  }
  const cleanText = t => String(t || '').replace(/\\[A-Za-z][^;]*;|[{}]/g, '').trim();

  /** From a libredwg-web DwgDatabase (arc angles in radians). */
  function primsFromDwgDb(db) {
    const out = [], texts = [], warn = new Set();
    const recs = (db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries) || [];
    const blocks = new Map(recs.map(b => [(b.name || '').toUpperCase(), b]));
    let ents = db.entities || [];
    if (!ents.length) { const ms = recs.find(b => /^\*MODEL/i.test(b.name || '')) || recs.find(b => (b.entities || []).length); ents = (ms && ms.entities) || []; }
    const P = p => [p.x, p.y];
    const walk = (list, T, parentLayer, depth) => {
      for (const e of list) {
        let layer = e.layer || '0'; if (parentLayer && layer === '0') layer = parentLayer;
        const ex = e.extrusionDirection; const flip = !!(ex && ex.z < 0);
        switch (e.type) {
          case 'LINE': emit(out, { t: 'L', a: P(e.startPoint), b: P(e.endPoint), layer }, T, false); break;
          case 'CIRCLE': emit(out, { t: 'C', c: P(e.center), r: e.radius, layer }, T, flip); break;
          case 'ARC': emit(out, { t: 'A', c: P(e.center), r: e.radius, a0: e.startAngle, a1: e.endAngle, layer }, T, flip); break;
          case 'LWPOLYLINE': emit(out, { t: 'P', pts: e.vertices.map(v => [v.x, v.y, v.bulge || 0]), closed: !!(e.flag & 512), layer }, T, flip); break;
          case 'POLYLINE2D': { const vs = (e.vertices || []).map(v => { const q = v.point || v; return [q.x, q.y, v.bulge || 0]; }); if (vs.length > 1) emit(out, { t: 'P', pts: vs, closed: !!(e.flag & 1), layer }, T, flip); break; }
          case 'ELLIPSE': emit(out, { t: 'F', pts: ellipsePts(P(e.center), P(e.majorAxisEndPoint), e.axisRatio, e.startAngle, e.endAngle), layer }, T, false); break;
          case 'SPLINE': { const pts = splinePts(e.degree, e.knots, (e.controlPoints || []).map(P), e.weights, (e.fitPoints || []).map(P)); if (pts.length > 1) emit(out, { t: 'F', pts, layer }, T, false); break; }
          case 'TEXT': case 'MTEXT': { const t = cleanText(e.text); if (t) texts.push(t); break; }
          case 'INSERT': {
            const b = blocks.get((e.name || '').toUpperCase());
            if (!b || depth > 8) { warn.add('Block "' + (e.name || '?') + '" tidak terbaca, isinya dilewati.'); break; }
            const U = insertT(P(e.insertionPoint), e.xScale || 1, e.yScale || 1, e.rotation || 0, b.basePoint ? P(b.basePoint) : [0, 0]);
            walk(b.entities || [], compose(T, U), layer, depth + 1); break;
          }
          default: break;
        }
      }
    };
    walk(ents, IDENT, null, 0);
    return { prims: out, texts, warnings: [...warn] };
  }

  /** Minimal ASCII DXF reader. */
  function primsFromDxf(text) {
    const L = text.split(/\r?\n/); const pairs = [];
    for (let i = 0; i + 1 < L.length; i += 2) pairs.push([parseInt(L[i].trim(), 10), L[i + 1].trim()]);
    let i = 0, section = null; const blocks = new Map(), entities = []; let curBlock = null;
    const num = (g, code, def = 0) => { const p = g.find(q => q[0] === code); return p ? parseFloat(p[1]) : def; };
    const str = (g, code, def = '') => { const p = g.find(q => q[0] === code); return p ? p[1] : def; };
    const readEntity = () => { const type = pairs[i][1]; const g = []; i++; while (i < pairs.length && pairs[i][0] !== 0) { g.push(pairs[i]); i++; } return { type, g }; };
    while (i < pairs.length) {
      const [c, v] = pairs[i];
      if (c === 0 && v === 'SECTION') { section = pairs[i + 1] && pairs[i + 1][1]; i += 2; continue; }
      if (c === 0 && v === 'ENDSEC') { section = null; i++; continue; }
      if (c === 0 && v === 'EOF') break;
      if (c === 0 && (section === 'ENTITIES' || section === 'BLOCKS')) {
        const ent = readEntity();
        if (ent.type === 'BLOCK') { const name = str(ent.g, 2); curBlock = { name, base: [num(ent.g, 10), num(ent.g, 20)], ents: [] }; blocks.set(name.toUpperCase(), curBlock); continue; }
        if (ent.type === 'ENDBLK') { curBlock = null; continue; }
        if (ent.type === 'POLYLINE') { ent.verts = []; while (i < pairs.length && pairs[i][1] === 'VERTEX') ent.verts.push(readEntity().g); if (i < pairs.length && pairs[i][1] === 'SEQEND') readEntity(); }
        if (section === 'BLOCKS') { if (curBlock) curBlock.ents.push(ent); } else entities.push(ent);
        continue;
      }
      i++;
    }
    const out = [], texts = [], warn = new Set(), D = Math.PI / 180;
    const walk = (list, T, parentLayer, depth) => {
      for (const { type, g, verts } of list) {
        let layer = str(g, 8, '0'); if (parentLayer && layer === '0') layer = parentLayer;
        const flip = num(g, 230, 1) < 0;
        if (type === 'LINE') emit(out, { t: 'L', a: [num(g, 10), num(g, 20)], b: [num(g, 11), num(g, 21)], layer }, T, false);
        else if (type === 'CIRCLE') emit(out, { t: 'C', c: [num(g, 10), num(g, 20)], r: num(g, 40), layer }, T, flip);
        else if (type === 'ARC') emit(out, { t: 'A', c: [num(g, 10), num(g, 20)], r: num(g, 40), a0: num(g, 50) * D, a1: num(g, 51) * D, layer }, T, flip);
        else if (type === 'LWPOLYLINE') {
          const pts = []; for (const [c, v] of g) { if (c === 10) pts.push([+v, 0, 0]); else if (c === 20 && pts.length) pts[pts.length - 1][1] = +v; else if (c === 42 && pts.length) pts[pts.length - 1][2] = +v; }
          if (pts.length > 1) emit(out, { t: 'P', pts, closed: !!(num(g, 70) & 1), layer }, T, flip);
        } else if (type === 'POLYLINE') {
          const fl = num(g, 70); if (fl & (8 | 16 | 64)) continue;
          const pts = (verts || []).filter(vg => !(num(vg, 70) & 16)).map(vg => [num(vg, 10), num(vg, 20), num(vg, 42)]);
          if (pts.length > 1) emit(out, { t: 'P', pts, closed: !!(fl & 1), layer }, T, flip);
        } else if (type === 'ELLIPSE') emit(out, { t: 'F', pts: ellipsePts([num(g, 10), num(g, 20)], [num(g, 11), num(g, 21)], num(g, 40, 1), num(g, 41, 0), num(g, 42, TAU)), layer }, T, false);
        else if (type === 'SPLINE') {
          const pick = code => g.filter(p => p[0] === code).map(p => +p[1]);
          const cx = pick(10), cy = pick(20), fx = pick(11), fy = pick(21);
          const pts = splinePts(num(g, 71, 3), pick(40), cx.map((x, k) => [x, cy[k]]), pick(41), fx.map((x, k) => [x, fy[k]]));
          if (pts.length > 1) emit(out, { t: 'F', pts, layer }, T, false);
        } else if (type === 'TEXT' || type === 'MTEXT') { const t = cleanText(str(g, 1)); if (t) texts.push(t); }
        else if (type === 'INSERT') {
          const b = blocks.get(str(g, 2).toUpperCase());
          if (!b || depth > 8) { warn.add('Block "' + str(g, 2) + '" tidak terbaca, isinya dilewati.'); continue; }
          walk(b.ents, compose(T, insertT([num(g, 10), num(g, 20)], num(g, 41, 1), num(g, 42, 1), num(g, 50) * D, b.base)), layer, depth + 1);
        }
      }
    };
    walk(entities, IDENT, null, 0);
    return { prims: out, texts, warnings: [...warn] };
  }

  function convertPrims(read, cfgIn, name) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn);
    const geom = buildLoops(read.prims, cfg);
    const res = generate(geom, cfg, name, read.texts);
    res.warnings = read.warnings || [];
    return res;
  }

  root.Dwg2Cnc = { DEFAULTS, primsFromDwgDb, primsFromDxf, convertPrims, simulate, Seg };
})(typeof window !== 'undefined' ? window : globalThis);
