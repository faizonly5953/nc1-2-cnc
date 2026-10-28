// Pembaca DSTV NC1 (plat): AK = kontur luar, IK = kontur dalam, BO = lubang bulat. Hanya sisi 'v'.
// Yang tidak bisa dibaca dengan pasti dilaporkan di errors, tidak ditebak.
(function (root) {
  'use strict';
  const BLOCKS = ['ST', 'EN', 'AK', 'IK', 'BO', 'SI', 'KA', 'SC', 'PU', 'KO', 'BR', 'UE', 'TO', 'EB', 'LO', 'RO', 'IP'];
  const NUM = /[-+]?\d*\.?\d+/g;

  /** Return { header, outer, inners, holes, warnings, errors }. outer/inners = [[x, y], ...] tanpa titik penutup. */
  function parseNc1(text) {
    const lines = text.split(/\r?\n/);
    const head = [], warnings = new Set(), errors = [];
    const rings = { AK: [], IK: [] }, holes = [], otherFace = new Set(), unsupported = new Set();
    let block = null, face = null, cur = null;
    for (const ln of lines) {
      if (!ln.trim() || ln.trim().startsWith('**')) continue;
      if (!/^\s/.test(ln) && /^[A-Z]{2}\s*$/.test(ln.trim())) {
        block = ln.trim(); face = null; cur = null;
        if (!BLOCKS.includes(block)) unsupported.add(block);
        if (block === 'EN') break;
        continue;
      }
      const s = ln.trim();
      if (block === 'ST') { head.push(s); continue; }
      if (!['AK', 'IK', 'BO'].includes(block)) { if (block && block !== 'KA') unsupported.add(block); continue; }
      if (/^[a-z]/i.test(s)) {                       // huruf sisi memulai data baru
        face = s[0];
        if (block !== 'BO') { cur = face === 'v' ? [] : null; if (cur) rings[block].push(cur); }
      }
      if (face !== 'v') { otherFace.add(block + ' sisi ' + face); continue; }
      const n = (s.replace(/^[a-z]/i, '').match(NUM) || []).map(Number);
      if (block === 'BO') {
        if (n.length < 3 || !(n[2] > 0)) { errors.push('BO: baris lubang tidak lengkap: "' + s + '"'); continue; }
        if (n.length > 3 && Math.abs(n[3]) > 1e-9) { errors.push('BO: lubang dengan kedalaman/slot (' + s + ') belum didukung'); continue; }
        holes.push([n[0], n[1], n[2] / 2]);
      } else if (cur) {
        if (n.length < 2) { errors.push(block + ': baris kontur tidak lengkap: "' + s + '"'); continue; }
        if (n.length > 2 && Math.abs(n[2]) > 1e-9) errors.push(block + ': kontur berbusur (radius ' + n[2] + ') belum didukung - kontur tidak ditebak.');
        cur.push([n[0], n[1]]);
      }
    }
    // header ST tanpa komentar: order, gambar, fase, nomor part, mutu, QTY, profil, kode profil, panjang, lebar, ...
    const H = {
      piece: head[3] || head[2] || '', grade: head[4] || '', qtyRaw: head[5], profile: head[6] || '', code: (head[7] || '').toUpperCase(),
      length: +head[8], width: +head[9], flangeT: +head[11], webT: +head[12], weight: +head[14],
    };
    H.qty = /^\s*\d+\s*$/.test(H.qtyRaw || '') ? parseInt(H.qtyRaw, 10) : NaN;
    const mt = /PL\s*(\d+(?:[.,]\d+)?)/i.exec(H.profile);
    H.thickness = mt ? parseFloat(mt[1].replace(',', '.')) : (H.webT > 0 ? H.webT : NaN);
    if (!head.length) errors.push('Blok ST (header) tidak ada.');
    if (!(H.qty > 0)) errors.push('QTY tidak terbaca di header (nilai: "' + (H.qtyRaw || '') + '").');
    if (H.code && H.code !== 'B') errors.push('Profil "' + H.profile + '" (kode ' + H.code + ') bukan plat datar - tidak bisa di-nesting 2D.');
    if (!(H.thickness > 0)) errors.push('Tebal plat tidak terbaca dari profil "' + H.profile + '".');
    // header berat (kg/m²) untuk plat = tebal × 7,85; beda jauh berarti tebal / profil mencurigakan
    else if (H.code === 'B' && H.weight > 0 && Math.abs(H.weight - H.thickness * 7.85) > 0.02 * H.thickness * 7.85)
      warnings.add('Berat header ' + H.weight + ' kg/m² tidak cocok dengan PL' + H.thickness + ' × 7,85 = ' + (H.thickness * 7.85).toFixed(2) + ' kg/m².');

    const clean = ring => {           // buang titik penutup & titik ganda
      const out = [];
      for (const p of ring) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) out.push(p); }
      if (out.length > 1) {
        const a = out[0], b = out[out.length - 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.1) out.pop();
        else errors.push('Kontur tidak tertutup (ujung ' + b.join(',') + ' != awal ' + a.join(',') + ').');
      }
      return out;
    };
    const outs = rings.AK.map(clean).filter(r => r.length >= 3);
    const inners = rings.IK.map(clean).filter(r => r.length >= 3);
    if (!outs.length) errors.push(otherFace.size ? 'Kontur luar sisi v tidak ada (hanya: ' + [...otherFace].join(', ') + ').' : 'Blok AK (kontur luar) tidak ada - geometri potong tidak lengkap.');
    if (outs.length > 1) errors.push('Ada ' + outs.length + ' kontur luar AK sisi v - tidak jelas mana yang dipotong.');
    const outer = outs[0] || null;
    if (outer) {
      const xs = outer.map(p => p[0]), ys = outer.map(p => p[1]);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      if (H.length > 0 && Math.abs(w - H.length) > 1) warnings.add('Panjang kontur ' + w.toFixed(2) + ' beda dari header ' + H.length + ' mm.');
      if (H.width > 0 && Math.abs(h - H.width) > 1) warnings.add('Lebar kontur ' + h.toFixed(2) + ' beda dari header ' + H.width + ' mm.');
    }
    for (const b of unsupported) warnings.add('Blok ' + b + ' diabaikan.');
    return { header: H, outer, inners, holes, warnings: [...warnings], errors };
  }

  /** Untuk halaman konversi satu file (index.html). */
  function primsFromNc1(text) {
    const r = parseNc1(text);
    if (!r.outer) throw new Error(r.errors.join(' '));
    const prims = [r.outer, ...r.inners].map(pts => ({ t: 'P', pts: pts.map(p => [p[0], p[1], 0]), closed: true, layer: 'CUT' }));
    for (const [x, y, rad] of r.holes) prims.push({ t: 'C', c: [x, y], r: rad, layer: 'CUT' });
    return { prims, texts: [r.header.grade, r.header.profile].filter(Boolean), warnings: [...r.errors, ...r.warnings] };
  }

  root.Dwg2Cnc = root.Dwg2Cnc || {};
  root.Dwg2Cnc.parseNc1 = parseNc1;
  root.Dwg2Cnc.primsFromNc1 = primsFromNc1;
})(typeof window !== 'undefined' ? window : globalThis);
