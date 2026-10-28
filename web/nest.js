/* nc1 nesting - NC1 -> instance per QTY -> nesting multi-plat -> validasi -> G-code per plat + layout DWG.
   Murni logika (tanpa DOM), dipakai nest.html dan test/nest.test.js. Satuan mm. */
(function (root) {
  'use strict';
  const D = root.Dwg2Cnc;
  const EPS = 1e-6;

  // ------------------------------------------------------------ part types
  /** NC1 text -> tipe part. Geometri digeser supaya bbox mulai di (0,0). */
  function makeType(id, fileName, text) {
    const r = D.parseNc1(text);
    const H = r.header;
    const t = {
      id, file: fileName, name: H.piece || fileName.replace(/\.[^.]+$/, ''), qty: H.qty, grade: H.grade,
      profile: H.profile, thickness: H.thickness, outer: null, inners: [], holes: [], w: 0, h: 0, area: 0,
      warnings: r.warnings, errors: r.errors.slice(),
    };
    if (r.outer) {
      const xs = r.outer.map(p => p[0]), ys = r.outer.map(p => p[1]);
      const mx = Math.min(...xs), my = Math.min(...ys);
      const sh = p => [p[0] - mx, p[1] - my];
      t.outer = r.outer.map(sh); t.inners = r.inners.map(ring => ring.map(sh));
      t.holes = r.holes.map(([x, y, rad]) => [x - mx, y - my, rad]);
      t.w = Math.max(...xs) - mx; t.h = Math.max(...ys) - my;
      t.area = Math.abs(polyArea(t.outer)) - t.inners.reduce((a, q) => a + Math.abs(polyArea(q)), 0)
        - t.holes.reduce((a, h) => a + Math.PI * h[2] * h[2], 0);
      for (const [x, y, rad] of t.holes) {
        if (!pointInPoly([x, y], t.outer) || x - rad < -EPS || y - rad < -EPS || x + rad > t.w + EPS || y + rad > t.h + EPS)
          t.errors.push('Lubang Ø' + (2 * rad) + ' di (' + (x + mx).toFixed(2) + ', ' + (y + my).toFixed(2) + ') keluar dari kontur.');
      }
      if (selfIntersects(t.outer)) t.errors.push('Kontur luar memotong dirinya sendiri.');
    }
    t.valid = t.errors.length === 0;
    return t;
  }
  const groupKey = t => (t.grade || '?') + ' | PL' + t.thickness;

  // -------------------------------------------------------------- geometry
  function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; }
  function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [x1, y1] = poly[j], [x2, y2] = poly[i];
      if ((y1 > pt[1]) !== (y2 > pt[1]) && x1 + (pt[1] - y1) * (x2 - x1) / (y2 - y1) > pt[0]) inside = !inside;
    }
    return inside;
  }
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  function segsCross(a, b, c, d) {   // perpotongan sejati (sentuhan ditangani lewat jarak = 0)
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
  }
  function ptSegDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  const segDist = (a, b, c, d) => segsCross(a, b, c, d) ? 0 : Math.min(ptSegDist(a, c, d), ptSegDist(b, c, d), ptSegDist(c, a, b), ptSegDist(d, a, b));
  function selfIntersects(p) {
    const n = p.length;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
    }
    return false;
  }
  /** Jarak minimum antar dua poligon (0 kalau saling potong / menempel / di dalam). */
  function polyDist(P, Q) {
    if (pointInPoly(P[0], Q) || pointInPoly(Q[0], P)) return 0;
    let best = Infinity;
    for (let i = 0; i < P.length; i++) for (let j = 0; j < Q.length; j++) {
      best = Math.min(best, segDist(P[i], P[(i + 1) % P.length], Q[j], Q[(j + 1) % Q.length]));
      if (best === 0) return 0;
    }
    return best;
  }

  // rotasi kelipatan 90 derajat (berlawanan jarum jam), bbox hasil tetap mulai di (0,0)
  function rotPt(p, rot, w, h) {
    switch (rot) {
      case 90: return [h - p[1], p[0]];
      case 180: return [w - p[0], h - p[1]];
      case 270: return [p[1], w - p[0]];
      default: return [p[0], p[1]];
    }
  }
  const dims = (t, rot) => (rot === 90 || rot === 270 ? [t.h, t.w] : [t.w, t.h]);

  /** Geometri instance dalam koordinat plat. */
  function world(inst) {
    const t = inst.type, tr = p => { const q = rotPt(p, inst.rot, t.w, t.h); return [q[0] + inst.x, q[1] + inst.y]; };
    const [w, h] = dims(t, inst.rot);
    return {
      outer: t.outer.map(tr), inners: t.inners.map(r => r.map(tr)),
      holes: t.holes.map(([x, y, r]) => [...tr([x, y]), r]),
      bbox: [inst.x, inst.y, inst.x + w, inst.y + h],
    };
  }

  // --------------------------------------------------------------- nesting
  /** MaxRects (best short side fit). Semua dimensi sudah termasuk spacing. */
  class Bin {
    constructor(w, h) { this.free = [[0, 0, w, h]]; }
    find(w, h) {
      let best = null;
      for (const [fx, fy, fw, fh] of this.free) {
        if (w <= fw + EPS && h <= fh + EPS) {
          const s = Math.min(fw - w, fh - h), l = Math.max(fw - w, fh - h);
          if (!best || s < best.s - EPS || (Math.abs(s - best.s) <= EPS && l < best.l)) best = { x: fx, y: fy, s, l };
        }
      }
      return best;
    }
    place(x, y, w, h) {
      const out = [];
      for (const f of this.free) {
        const [fx, fy, fw, fh] = f;
        if (x >= fx + fw - EPS || x + w <= fx + EPS || y >= fy + fh - EPS || y + h <= fy + EPS) { out.push(f); continue; }
        if (x > fx + EPS) out.push([fx, fy, x - fx, fh]);
        if (x + w < fx + fw - EPS) out.push([x + w, fy, fx + fw - x - w, fh]);
        if (y > fy + EPS) out.push([fx, fy, fw, y - fy]);
        if (y + h < fy + fh - EPS) out.push([fx, y + h, fw, fy + fh - y - h]);
      }
      const inside = (a, b) => a[0] >= b[0] - EPS && a[1] >= b[1] - EPS && a[0] + a[2] <= b[0] + b[2] + EPS && a[1] + a[3] <= b[1] + b[3] + EPS;
      // buang free-rect yang termuat di rect lain (duplikat: sisakan yang pertama)
      this.free = out.filter((a, i) => !out.some((b, j) => j !== i && inside(a, b) && (!inside(b, a) || j < i)));
    }
  }
  const rotations = cfg => cfg.rotation === 'none' ? [0] : cfg.rotation === '180' ? [0, 180] : [0, 90, 180, 270];

  /** Susun semua instance. cfg: plate_w, plate_h, margin, spacing, rotation.
   *  ponytail: nesting per bounding box (MaxRects) - pasti tanpa tabrakan, optimal untuk part persegi;
   *  part bentuk bebas (L, segitiga) memboroskan sudut bbox. Upgrade: true-shape nesting (no-fit polygon). */
  function nest(types, cfg) {
    const W = +cfg.plate_w, H = +cfg.plate_h, m = +cfg.margin, s = +cfg.spacing;
    const binW = W - 2 * m + s, binH = H - 2 * m + s;
    const rots = rotations(cfg).filter(r => r === 0 || r === 90);   // 180/270 bbox sama dengan 0/90
    const plates = [], unplaced = [];
    const groups = new Map();
    for (const t of types.filter(t => t.valid)) {
      const k = groupKey(t);
      if (!groups.has(k)) groups.set(k, []);
      for (let n = 1; n <= t.qty; n++) groups.get(k).push({ uid: t.id + '#' + n, type: t, n, plate: -1, x: 0, y: 0, rot: 0 });
    }
    for (const [group, insts] of groups) {
      insts.sort((a, b) => Math.max(b.type.w, b.type.h) - Math.max(a.type.w, a.type.h) || b.type.w * b.type.h - a.type.w * a.type.h || a.uid.localeCompare(b.uid, 'en', { numeric: true }));
      const mine = [];
      const tryBin = (pl, inst) => {
        let best = null;
        for (const rot of rots) {
          const [w, h] = dims(inst.type, rot), f = pl.bin.find(w + s, h + s);
          if (f && (!best || f.s < best.f.s - EPS || (Math.abs(f.s - best.f.s) <= EPS && f.l < best.f.l))) best = { f, rot, w, h };
        }
        if (!best) return false;
        pl.bin.place(best.f.x, best.f.y, best.w + s, best.h + s);
        Object.assign(inst, { plate: pl.index, x: m + best.f.x, y: m + best.f.y, rot: best.rot });
        pl.insts.push(inst);
        return true;
      };
      for (const inst of insts) {
        if (mine.some(pl => tryBin(pl, inst))) continue;
        const pl = { index: plates.length, group, w: W, h: H, bin: new Bin(binW, binH), insts: [] };
        if (tryBin(pl, inst)) { plates.push(pl); mine.push(pl); continue; }
        unplaced.push({ inst, msg: inst.type.name + ' #' + inst.n + ' (' + inst.type.w.toFixed(1) + ' × ' + inst.type.h.toFixed(1) + ' mm) tidak muat di plat ' + W + ' × ' + H + ' mm dengan margin ' + m + ' mm.' });
      }
    }
    for (const pl of plates) delete pl.bin;
    return { plates, unplaced };
  }

  /** Cari tempat kosong (bawah-kiri dulu) untuk inst di plat pl. Return {x, y, rot} atau null. */
  function findFreeSpot(pl, inst, cfg) {
    const m = +cfg.margin, s = +cfg.spacing;
    const others = pl.insts.filter(o => o !== inst).map(o => world(o).bbox);
    for (const rot of [inst.rot, ...rotations(cfg).filter(r => r !== inst.rot)]) {
      const [w, h] = dims(inst.type, rot);
      const xs = [m, ...others.map(b => b[2] + s)], ys = [m, ...others.map(b => b[3] + s)];
      const cand = [];
      for (const x of xs) for (const y of ys) cand.push([x, y]);
      cand.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      for (const [x, y] of cand) {
        if (x + w > pl.w - m + EPS || y + h > pl.h - m + EPS) continue;
        if (others.every(b => x + w + s <= b[0] + EPS || b[2] + s <= x + EPS || y + h + s <= b[1] + EPS || b[3] + s <= y + EPS)) return { x, y, rot };
      }
    }
    return null;
  }

  // ------------------------------------------------------------ validation
  const label = inst => inst.type.name + ' #' + inst.n;

  /** Return daftar masalah [{level:'error'|'warn', plate?, uid?, uid2?, msg}]. */
  function validate(state, cfg) {
    const out = [], m = +cfg.margin, s = +cfg.spacing;
    for (const t of state.types) {
      for (const e of t.errors) out.push({ level: 'error', msg: t.name + ' (' + t.file + '): ' + e });
      for (const w of t.warnings) out.push({ level: 'warn', msg: t.name + ': ' + w });
      if (!t.valid) continue;
      const placed = state.plates.reduce((a, pl) => a + pl.insts.filter(i => i.type === t).length, 0);
      if (placed !== t.qty) out.push({ level: 'error', msg: t.name + ': QTY ' + t.qty + ', yang ada di plat ' + placed + '.' });
    }
    for (const u of state.unplaced) out.push({ level: 'error', uid: u.inst.uid, msg: u.msg });
    if (s < +cfg.lead_in_outer * 0.75) out.push({ level: 'warn', msg: 'Spacing ' + s + ' mm kecil dibanding lead-in luar ' + cfg.lead_in_outer + ' mm: titik tembus bisa dekat part tetangga (dicek saat ekspor).' });
    for (const pl of state.plates) {
      const geo = pl.insts.map(world);
      const groups = new Set(pl.insts.map(i => groupKey(i.type)));
      if (groups.size > 1) out.push({ level: 'error', plate: pl.index, msg: 'Plat ' + (pl.index + 1) + ' berisi mutu/tebal berbeda: ' + [...groups].join(', ') });
      pl.insts.forEach((inst, i) => {
        const b = geo[i].bbox;
        if (b[0] < m - 1e-3 || b[1] < m - 1e-3 || b[2] > pl.w - m + 1e-3 || b[3] > pl.h - m + 1e-3)
          out.push({ level: 'error', plate: pl.index, uid: inst.uid, msg: label(inst) + ' keluar dari batas plat ' + (pl.index + 1) + ' (margin ' + m + ' mm).' });
      });
      for (let i = 0; i < geo.length; i++) for (let j = i + 1; j < geo.length; j++) {
        const a = geo[i].bbox, b = geo[j].bbox;
        if (a[2] + s <= b[0] + 1e-3 || b[2] + s <= a[0] + 1e-3 || a[3] + s <= b[1] + 1e-3 || b[3] + s <= a[1] + 1e-3) continue;
        const d = polyDist(geo[i].outer, geo[j].outer);
        if (d < s - 1e-3) out.push({
          level: 'error', plate: pl.index, uid: pl.insts[i].uid, uid2: pl.insts[j].uid,
          msg: d === 0 ? label(pl.insts[i]) + ' bertabrakan dengan ' + label(pl.insts[j]) + ' (plat ' + (pl.index + 1) + ').'
            : label(pl.insts[i]) + ' terlalu dekat ke ' + label(pl.insts[j]) + ' (' + d.toFixed(1) + ' < spacing ' + s + ' mm).',
        });
      }
    }
    return out;
  }

  /** Sidik layout: berubah setiap posisi/rotasi/plat berubah. Ditulis di canvas, G-code, DWG. */
  function layoutId(state) {
    let h = 2166136261;
    const str = state.plates.map(pl => pl.w + 'x' + pl.h + ':' + pl.insts.map(i => i.uid + '@' + i.x.toFixed(3) + ',' + i.y.toFixed(3) + ',' + i.rot).sort().join(';')).join('|');
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }

  // -------------------------------------------------------- post-processor
  /** Post-processor per mesin. Mesin lain = entri baru dengan build(prims, cfg, name, texts) -> {lines, text, moves, errors, stats}. */
  const POSTS = {
    f2100b: {
      label: 'FLSK F2100B (MiniCut)', ext: '.TXT', maxLines: 10000, maxBytes: 1024 * 1024,
      build(prims, cfg, name, texts) { return D.convertPrims({ prims, texts, warnings: [] }, cfg, name); },
    },
  };

  function instPrims(inst) {
    const g = world(inst), P = pts => ({ t: 'P', pts: pts.map(p => [p[0], p[1], 0]), closed: true, layer: 'CUT' });
    return [P(g.outer), ...g.inners.map(P), ...g.holes.map(([x, y, r]) => ({ t: 'C', c: [x, y], r, layer: 'CUT' }))];
  }

  /** G-code per plat. Kalau melebihi batas mesin, plat dipecah jadi beberapa file (urut kiri -> kanan),
   *  semuanya tetap bertitik nol di pojok kiri bawah plat. Return [{plate, name, file, text, errors, stats, count}]. */
  function gcodeForPlate(pl, cfg, postId, id) {
    const post = POSTS[postId] || POSTS.f2100b;
    const c = Object.assign({}, D.DEFAULTS, cfg, { keep_coords: true, header_comment: true, holes: 'cut', min_hole_diameter: 0 });
    const base = 'PLAT' + String(pl.index + 1).padStart(2, '0');
    const t0 = pl.insts[0].type;
    const build = (insts, name) => post.build(insts.flatMap(instPrims), c, name, [t0.grade, t0.profile, 'L' + id, insts.length + 'PCS']);
    const fits = r => r.lines.length <= post.maxLines && r.text.length <= post.maxBytes;
    // isi file serakus mungkin (perkiraan dari ukuran per part), lalu cek nyata; kalau lewat, bagi dua
    const sorted = pl.insts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const HL = 8, HB = 200;   // perkiraan header + penutup per file (hasil akhir tetap dicek nyata)
    const cost = new Map();
    for (const i of sorted) { const r = build([i], base); cost.set(i, [r.lines.length - HL, r.text.length - HB]); }
    const groups = []; let cur = [], L = HL, B = HB;
    for (const i of sorted) {
      const [dl, db] = cost.get(i);
      if (cur.length && (L + dl > post.maxLines * 0.97 || B + db > post.maxBytes * 0.97)) { groups.push(cur); cur = []; L = HL; B = HB; }
      cur.push(i); L += dl; B += db;
    }
    if (cur.length) groups.push(cur);
    const chunks = [];
    const split = insts => {
      if (fits(build(insts, base)) || insts.length === 1) { chunks.push(insts); return; }
      const half = Math.ceil(insts.length / 2);
      split(insts.slice(0, half)); split(insts.slice(half));
    };
    groups.forEach(split);
    const geo = pl.insts.map(world);
    return chunks.map((insts, k) => {
      const name = chunks.length > 1 ? base + String.fromCharCode(65 + k) : base;
      const r = build(insts, name);
      const errors = r.errors.map(e => name + ': ' + e);
      if (r.lines.length > post.maxLines || r.text.length > post.maxBytes) errors.push(name + ': satu part saja sudah melebihi batas ' + post.maxLines + ' baris / ' + post.maxBytes + ' byte.');
      if (r.stats.parts !== insts.length) errors.push(name + ': ' + insts.length + ' part dikirim, ' + r.stats.parts + ' kontur luar di G-code.');
      // titik tembus tidak boleh jatuh di material part mana pun (kecuali di dalam lubang)
      r.moves.forEach((mv, i) => {
        if (mv.code !== 0 || !r.moves[i + 1] || r.moves[i + 1].code === 0) return;
        const p = mv.p1;
        if (p[0] < 0 || p[1] < 0 || p[0] > pl.w || p[1] > pl.h) errors.push(name + ': titik tembus (' + p[0].toFixed(1) + ', ' + p[1].toFixed(1) + ') di luar plat.');
        geo.forEach((g, gi) => {
          if (!pointInPoly(p, g.outer)) return;
          const inHole = g.holes.some(([x, y, rr]) => Math.hypot(p[0] - x, p[1] - y) < rr) || g.inners.some(q => pointInPoly(p, q));
          if (!inHole) errors.push(name + ': titik tembus (' + p[0].toFixed(1) + ', ' + p[1].toFixed(1) + ') jatuh di ' + label(pl.insts[gi]) + '.');
        });
      });
      return {
        plate: pl.index, name, file: name + post.ext, text: r.text, moves: r.moves, errors, stats: r.stats, count: insts.length,
        // DWG pasangan file ini: hanya part yang dipotong file ini, koordinat = koordinat G-code (pojok plat = 0,0)
        dwg: dwgLayout(pl, insts, cfg, name + '  PLAT ' + (pl.index + 1) + (chunks.length > 1 ? ' (FILE ' + (k + 1) + '/' + chunks.length + ')' : '') +
          '  ' + pl.group + '  ' + insts.length + ' PCS  LAYOUT ' + id),
      };
    });
  }

  /** Layout DWG satu plat berisi part tertentu. Format: lihat dwgwrite.py. */
  function dwgLayout(pl, insts, cfg, title) {
    return {
      text_height: +cfg.text_height || 20,
      plates: [{
        x0: 0, y0: 0, w: pl.w, h: pl.h, name: title,
        parts: insts.map(inst => {
          const g = world(inst);
          return { label: label(inst), outer: g.outer, inners: g.inners, holes: g.holes, lx: g.bbox[0] + 5, ly: (g.bbox[1] + g.bbox[3]) / 2 };
        }),
      }],
    };
  }

  const utilization = pl => pl.insts.reduce((a, i) => a + i.type.area, 0) / (pl.w * pl.h);

  // ------------------------------------------------------------ berat
  const DENSITY = 7850;                         // kg/m³ baja (7,85 g/cm³)
  const KG_PER_MM3 = DENSITY * 1e-9;
  /** Berat plat stok, part jadi (luas bersih × tebal), dan sisa (sisa plat + lubang). Tebal dari profil NC1 (PL20 = 20 mm). */
  function mass(pl) {
    const t = pl.insts.length ? pl.insts[0].type.thickness : 0;
    const plate = pl.w * pl.h * t * KG_PER_MM3;
    const parts = pl.insts.reduce((a, i) => a + i.type.area, 0) * t * KG_PER_MM3;
    return { thickness: t, plate, parts, waste: plate - parts, wastePct: plate ? (plate - parts) / plate : 0 };
  }
  const typeMass = t => t.area * t.thickness * KG_PER_MM3;

  root.Nest = { makeType, groupKey, nest, findFreeSpot, validate, world, dims, rotations, layoutId, POSTS, gcodeForPlate, dwgLayout, utilization, mass, typeMass, DENSITY, label, polyDist, pointInPoly };
})(typeof window !== 'undefined' ? window : globalThis);
