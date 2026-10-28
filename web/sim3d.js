/* sim3d - 3D cutting simulation for dwg2cnc G-code (FLSK F2100B).
   Plays the program move by move: torch travels, preheats, pierces and cuts; the kerf is
   burned into the plate surface; finished holes drop out and finished parts come loose.
   Needs three.js r128 + OrbitControls (loaded on first use). */
(function (root) {
  'use strict';
  const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  const ORBIT_URL = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js';
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const TAU = Math.PI * 2;

  let threeP = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => res(); s.onerror = () => rej(new Error('Gagal memuat ' + src));
      document.head.appendChild(s);
    });
  }
  function loadThree() {
    if (!threeP) {
      threeP = (async () => {
        if (!root.THREE) await loadScript(THREE_URL);
        if (!root.THREE.OrbitControls) await loadScript(ORBIT_URL);
        return root.THREE;
      })();
      threeP.catch(() => { threeP = null; });
    }
    return threeP;
  }

  // ------------------------------------------------------------------ geometry helpers
  function arcPts(p0, p1, c, ccw, stepRad) {
    const r = dist(p0, c);
    const a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
    const a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
    let sw = ccw ? a1 - a0 : a0 - a1;
    sw = ((sw % TAU) + TAU) % TAU; if (sw < 1e-9) sw = TAU;
    if (!ccw) sw = -sw;
    const n = Math.max(4, Math.ceil(Math.abs(sw) / stepRad));
    const pts = [];
    for (let i = 1; i <= n; i++) { const a = a0 + sw * i / n; pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
    pts[pts.length - 1] = [p1[0], p1[1]];
    return pts;
  }
  function area(p) { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
  function pip(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[j];
      if ((y1 > pt[1]) !== (y2 > pt[1]) && pt[0] < x1 + (pt[1] - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
    }
    return inside;
  }
  function clean(pts) {
    const out = [];
    for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > 0.05) out.push(p);
    while (out.length > 2 && dist(out[0], out[out.length - 1]) < 0.05) out.pop();
    return out;
  }
  // offset a closed polygon: d > 0 grows it, d < 0 shrinks it (miter, clamped)
  function offsetPoly(pts, d) {
    const n = pts.length, sgn = area(pts) > 0 ? 1 : -1, out = [];
    for (let i = 0; i < n; i++) {
      const pr = pts[(i - 1 + n) % n], cu = pts[i], nx = pts[(i + 1) % n];
      let e1 = [cu[0] - pr[0], cu[1] - pr[1]], e2 = [nx[0] - cu[0], nx[1] - cu[1]];
      const l1 = Math.hypot(e1[0], e1[1]) || 1, l2 = Math.hypot(e2[0], e2[1]) || 1;
      e1 = [e1[0] / l1, e1[1] / l1]; e2 = [e2[0] / l2, e2[1] / l2];
      const n1 = [e1[1] * sgn, -e1[0] * sgn], n2 = [e2[1] * sgn, -e2[0] * sgn];
      let m = [n1[0] + n2[0], n1[1] + n2[1]]; const ml = Math.hypot(m[0], m[1]);
      m = ml < 1e-6 ? n1 : [m[0] / ml, m[1] / ml];
      const k = d / Math.max(m[0] * n1[0] + m[1] * n1[1], 0.35);
      out.push([cu[0] + m[0] * k, cu[1] + m[1] * k]);
    }
    return out;
  }
  const fmtT = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

  // ------------------------------------------------------------------ timeline from G-code moves
  function buildTimeline(moves, lines, opt) {
    const vCut = Math.max(1, opt.cutSpeed) / 60, vRap = Math.max(1, opt.rapidSpeed) / 60;
    const moveLine = [];
    lines.forEach((l, i) => { if (/^\s*G0?[0-3](?![0-9])/i.test(l)) moveLine.push(i); });
    const lineOf = moveLine.length === moves.length ? (i) => moveLine[i] : () => -1;

    const segs = [], groups = [];
    let t = 0, g = null;
    let minx = 0, miny = 0, maxx = 0, maxy = 0;
    const grow = (p) => { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); };
    moves.forEach((m, i) => {
      const pts = m.code >= 2 ? [m.p0, ...arcPts(m.p0, m.p1, m.c, m.code === 3, Math.PI / 48)] : [m.p0, m.p1];
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist(pts[k - 1], pts[k]));
      const len = cum[cum.length - 1];
      if (m.code === 0) {
        g = null;
        const d = len / vRap;
        segs.push({ type: 'rapid', t0: t, t1: t + d, pts, cum, len, line: lineOf(i) });
        t += d;
        return;
      }
      pts.forEach(grow);
      if (!g) {
        g = { id: groups.length, segs: [], t0: t };
        groups.push(g);
        segs.push({ type: 'pierce', t0: t, t1: t + opt.pierceTime, p: m.p0, line: lineOf(i), g });
        t += opt.pierceTime;
      }
      const d = Math.max(len / vCut, 1e-4);
      const s = { type: 'cut', t0: t, t1: t + d, pts, cum, len, line: lineOf(i), g };
      segs.push(s); g.segs.push(s);
      t += d; g.t1 = t;
    });

    // closed loop of each pierce group (between lead-in and lead-out)
    const loops = [];
    for (const gr of groups) {
      const V = [gr.segs[0].pts[0]];
      gr.segs.forEach(s => V.push(s.pts[s.pts.length - 1]));
      let found = null;
      for (let j = 2; j < V.length && !found; j++) for (let k = 0; k < j - 1; k++) if (dist(V[j], V[k]) < 0.05) { found = [k, j]; break; }
      if (!found) continue;
      const [k, j] = found;
      let pts = [];
      for (let q = k; q < j; q++) pts.push(...gr.segs[q].pts.slice(q === k ? 0 : 1));
      pts = clean(pts);
      if (pts.length < 3) continue;
      loops.push({ id: loops.length, pts, tClose: gr.segs[j - 1].t1, area: Math.abs(area(pts)), g: gr });
    }
    for (const lp of loops) {
      let parent = null;
      for (const o of loops) if (o !== lp && o.area > lp.area && pip(lp.pts[0], o.pts) && (!parent || o.area < parent.area)) parent = o;
      lp.parent = parent;
    }
    for (const lp of loops) { let d = 0, p = lp.parent; while (p) { d++; p = p.parent; } lp.isHole = d % 2 === 1; }
    return { segs, groups, loops, total: t, box: [minx, miny, maxx, maxy] };
  }

  // ------------------------------------------------------------------ simulator
  class Sim {
    constructor(host) {
      this.host = host;
      host.classList.add('sim3d');
      host.innerHTML =
        '<div class="sim-stage"><div class="sim-gl"></div>' +
        '<div class="sim-hud"><span class="sim-status">Memuat…</span><span class="sim-pos"></span><code class="sim-line"></code></div>' +
        '<div class="sim-msg">Memuat simulator 3D…</div></div>' +
        '<div class="sim-bar">' +
        '<button type="button" class="btn primary sim-play">Putar</button>' +
        '<button type="button" class="btn sim-restart">Ulang</button>' +
        '<input type="range" class="sim-seek" min="0" max="1000" value="0" step="1" aria-label="Posisi simulasi">' +
        '<span class="sim-time">0:00 / 0:00</span>' +
        '</div>' +
        '<div class="sim-opts">' +
        '<label>Kecepatan <select class="sim-speed"><option value="auto">Otomatis (±60 dtk)</option><option value="1">1× (waktu nyata)</option><option value="10">10×</option><option value="30">30×</option><option value="100">100×</option><option value="300">300×</option></select></label>' +
        '<label>Tebal plat <input type="number" class="sim-thk" min="1" max="200" step="1"> mm</label>' +
        '<label>Kerf <input type="number" class="sim-kerf" min="0.3" max="10" step="0.1"> mm</label>' +
        '<label>Preheat/tembus <input type="number" class="sim-pierce" min="0" max="300" step="1"> dtk</label>' +
        '<label class="sim-chk"><input type="checkbox" class="sim-follow"> Kamera ikuti torch</label>' +
        '<span class="sim-views"><button type="button" class="btn sim-v3d">3D</button><button type="button" class="btn sim-vtop">Atas</button></span>' +
        '</div>';
      this.q = (c) => host.querySelector(c);
      this.playing = false; this.t = 0; this.drawnT = 0; this.raf = 0;
      this.completedKey = ''; this.slugs = new Map(); this.parts = new Map();
      this.sparks = null; this.lastFrame = 0;
    }

    async load(data) {
      this.data = data;
      this.q('.sim-thk').value = data.thickness || 14;
      this.q('.sim-kerf').value = data.kerf || 1.5;
      this.q('.sim-pierce').value = data.pierceTime != null ? data.pierceTime : 20;
      let THREE;
      try { THREE = await loadThree(); } catch (e) { this.q('.sim-msg').textContent = 'Simulator 3D tidak bisa dimuat (' + e.message + '). Periksa koneksi internet lalu buka lagi.'; return; }
      this.THREE = THREE;
      try { this.initGL(); } catch (e) { this.q('.sim-msg').textContent = 'Browser ini tidak mendukung WebGL, jadi simulasi 3D tidak bisa ditampilkan.'; return; }
      this.q('.sim-msg').hidden = true;
      this.bindUI();
      this.rebuild(true);
      this.loop = this.loop.bind(this);
      this.raf = requestAnimationFrame(this.loop);
      if (data.autoplay) this.setPlaying(true);
    }

    readOpts() {
      const n = (c, d) => { const v = parseFloat(this.q(c).value); return Number.isFinite(v) && v >= 0 ? v : d; };
      return {
        thickness: Math.max(1, n('.sim-thk', 14)), kerf: Math.max(0.3, n('.sim-kerf', 1.5)), pierceTime: n('.sim-pierce', 20),
        cutSpeed: this.data.cutSpeed || 360, rapidSpeed: this.data.rapidSpeed || 4000,
      };
    }

    initGL() {
      const THREE = this.THREE;
      const gl = this.q('.sim-gl');
      this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.outputEncoding = THREE.sRGBEncoding;
      gl.appendChild(this.renderer.domElement);
      this.renderer.domElement.setAttribute('aria-label', 'Simulasi 3D pemotongan plat');
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1.6, 5, 40000);
      this.camera.up.set(0, 0, 1);
      this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true; this.controls.dampingFactor = 0.12;
      this.controls.maxPolarAngle = Math.PI * 0.49;
      this.scene.add(new THREE.HemisphereLight(0xdfe8ef, 0x2a2420, 0.75));
      const sun = new THREE.DirectionalLight(0xffffff, 0.85); sun.position.set(-0.6, -1, 1.6); this.scene.add(sun);
      this.world = new THREE.Group(); this.scene.add(this.world);
      this.resize = this.resize.bind(this);
      this.ro = new ResizeObserver(this.resize); this.ro.observe(gl);
      this.resize();
    }

    resize() {
      const gl = this.q('.sim-gl'); if (!gl || !this.renderer) return;
      const w = gl.clientWidth || 600, h = Math.round(Math.min(Math.max(w * 0.58, 260), window.innerHeight * 0.7));
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }

    themeColors() {
      const cs = getComputedStyle(document.documentElement);
      const g = (n, d) => (cs.getPropertyValue(n).trim() || d);
      return { bg: g('--sim-bg', '#1c2227'), floor: g('--sim-floor', '#161b1f') };
    }

    rebuild(resetCam) {
      const THREE = this.THREE;
      const o = this.opts = this.readOpts();
      this.tl = buildTimeline(this.data.moves, this.data.lines, o);
      while (this.world.children.length) { const c = this.world.children.pop(); c.traverse(x => { if (x.geometry) x.geometry.dispose(); }); }
      this.slugs.clear(); this.parts.clear(); this.completedKey = null;
      const b = this.tl.box, m = 15;
      const ps = this.data.plateSize;   // [w, h]: plat stok penuh (nesting), titik nol di pojok
      const P = this.plate = ps ? { x0: 0, y0: 0, x1: ps[0], y1: ps[1] } : { x0: Math.min(0, b[0] - m), y0: Math.min(0, b[1] - m), x1: b[2] + m, y1: b[3] + m };
      P.w = P.x1 - P.x0; P.h = P.y1 - P.y0;
      const T = o.thickness;
      const col = this.themeColors();
      this.scene.background = new THREE.Color(col.bg);

      // plate surface texture: the kerf is burned into this canvas
      const s = Math.min(2048 / P.w, 2048 / P.h, 2.5);
      this.texScale = s;
      const cv = document.createElement('canvas');
      cv.width = Math.max(64, Math.round(P.w * s)); cv.height = Math.max(64, Math.round(P.h * s));
      this.cv = cv; this.ctx = cv.getContext('2d');
      this.base = this.makeBase(cv.width, cv.height);
      if (this.tex) this.tex.dispose();
      this.tex = new THREE.CanvasTexture(cv);
      this.tex.encoding = THREE.sRGBEncoding;
      this.tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.tex.repeat.set(1 / P.w, 1 / P.h); this.tex.offset.set(-P.x0 / P.w, -P.y0 / P.h);
      this.matTop = new THREE.MeshStandardMaterial({ map: this.tex, metalness: 0.55, roughness: 0.6 });
      this.matSide = new THREE.MeshStandardMaterial({ color: 0x55504b, metalness: 0.6, roughness: 0.5 });
      this.matCutEdge = new THREE.MeshStandardMaterial({ color: 0x3a2f28, metalness: 0.4, roughness: 0.8 });
      this.resetCanvas();

      // cutting table: slats + floor
      const table = new THREE.Group();
      const slatMat = new THREE.MeshStandardMaterial({ color: 0x6d5a4a, metalness: 0.5, roughness: 0.7 });
      const slatH = 70, gap = 120;
      for (let x = P.x0 + 40; x < P.x1 - 10; x += gap) {
        const sl = new THREE.Mesh(new THREE.BoxGeometry(6, P.h + 120, slatH), slatMat);
        sl.position.set(x, (P.y0 + P.y1) / 2, -slatH / 2); table.add(sl);
      }
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(P.w * 4, P.h * 4), new THREE.MeshStandardMaterial({ color: col.floor, roughness: 0.95, metalness: 0.1 }));
      floor.position.set((P.x0 + P.x1) / 2, (P.y0 + P.y1) / 2, -slatH - 70);
      table.add(floor);
      this.floorZ = floor.position.z;
      this.world.add(table);

      // torch zero marker
      const om = new THREE.Mesh(new THREE.RingGeometry(6, 9, 24), new THREE.MeshBasicMaterial({ color: 0xff8a3d, side: THREE.DoubleSide }));
      om.position.set(0, 0, T + 0.3); this.world.add(om);

      this.plateGroup = new THREE.Group(); this.world.add(this.plateGroup);
      this.buildTorch();
      this.buildSparks();

      this.q('.sim-seek').max = String(Math.max(1, Math.round(this.tl.total * 10)));
      this.t = Math.min(this.t, this.tl.total);
      this.drawnT = 0;
      this.updatePlateMeshes(this.t, false, true);
      this.drawRange(0, this.t);
      this.drawnT = this.t;
      this.cur = this.torchAt(this.t);
      if (resetCam) this.view('3d');
      this.updateHud();
    }

    makeBase(w, h) {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#7f878d'); g.addColorStop(0.5, '#8b9399'); g.addColorStop(1, '#757d83');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 260; i++) {
        const r = 20 + rnd() * 120;
        x.fillStyle = `rgba(${rnd() < 0.5 ? '60,66,72' : '150,158,164'},${0.04 + rnd() * 0.06})`;
        x.beginPath(); x.ellipse(rnd() * w, rnd() * h, r, r * (0.4 + rnd() * 0.6), rnd() * 3, 0, TAU); x.fill();
      }
      const n = Math.round(w * h / 60);
      for (let i = 0; i < n; i++) { x.fillStyle = rnd() < 0.5 ? 'rgba(40,44,48,.18)' : 'rgba(210,214,218,.14)'; x.fillRect(rnd() * w, rnd() * h, 1, 1); }
      return c;
    }

    resetCanvas() {
      const P = this.plate, s = this.texScale, x = this.ctx;
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.drawImage(this.base, 0, 0);
      x.setTransform(s, 0, 0, -s, -P.x0 * s, P.y1 * s);   // mm -> px, y up
      x.lineCap = 'round'; x.lineJoin = 'round';
      this.tex.needsUpdate = true;
    }

    // burn the kerf for program time a..b
    drawRange(a, b) {
      if (b <= a) return false;
      const segs = this.tl.segs, x = this.ctx, kerf = this.opts.kerf;
      let drew = false;
      for (let i = this.segIndex(a); i < segs.length && segs[i].t0 < b; i++) {
        const sg = segs[i];
        if (sg.t1 <= a) continue;
        if (sg.type === 'pierce') {
          if (sg.t1 > a && sg.t1 <= b) {
            x.fillStyle = 'rgba(70,48,32,.35)'; x.beginPath(); x.arc(sg.p[0], sg.p[1], kerf * 2.2, 0, TAU); x.fill();
            x.fillStyle = '#17120f'; x.beginPath(); x.arc(sg.p[0], sg.p[1], kerf * 0.9, 0, TAU); x.fill();
            drew = true;
          }
          continue;
        }
        if (sg.type !== 'cut') continue;
        const f0 = Math.max(0, (a - sg.t0) / (sg.t1 - sg.t0)), f1 = Math.min(1, (b - sg.t0) / (sg.t1 - sg.t0));
        const pts = this.subPath(sg, f0 * sg.len, f1 * sg.len);
        if (pts.length < 2) continue;
        x.beginPath(); x.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) x.lineTo(pts[k][0], pts[k][1]);
        x.strokeStyle = 'rgba(92,62,38,.28)'; x.lineWidth = kerf * 3.4; x.stroke();     // heat tint
        x.strokeStyle = '#15110e'; x.lineWidth = kerf; x.stroke();                        // kerf
        drew = true;
      }
      if (drew) this.tex.needsUpdate = true;
      return drew;
    }

    subPath(sg, l0, l1) {
      const { pts, cum } = sg, out = [];
      const at = (L) => { let k = 1; while (k < cum.length - 1 && cum[k] < L) k++; const seg = cum[k] - cum[k - 1] || 1, f = (L - cum[k - 1]) / seg; return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * f, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f]; };
      out.push(at(l0));
      for (let k = 1; k < cum.length - 1; k++) if (cum[k] > l0 && cum[k] < l1) out.push(pts[k]);
      out.push(at(l1));
      return out;
    }

    segIndex(t) {
      const s = this.tl.segs; let lo = 0, hi = s.length - 1;
      if (hi < 0) return 0;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].t0 <= t) lo = m; else hi = m - 1; }
      return lo;
    }

    shapeFrom(pts, holes) {
      const THREE = this.THREE;
      const sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
      for (const h of holes || []) sh.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))));
      return sh;
    }
    extrude(shape, mats) {
      const geo = new this.THREE.ExtrudeGeometry(shape, { depth: this.opts.thickness, bevelEnabled: false, curveSegments: 1 });
      return new this.THREE.Mesh(geo, mats);
    }

    updatePlateMeshes(t, animate, force) {
      const loops = this.tl.loops, done = loops.filter(l => l.tClose <= t + 1e-6);
      const key = done.map(l => l.id).join(',');
      if (!force && key === this.completedKey) return;
      this.completedKey = key;
      const doneSet = new Set(done.map(l => l.id));
      const kerf = this.opts.kerf, P = this.plate;

      // remaining plate (skeleton)
      while (this.plateGroup.children.length) { const c = this.plateGroup.children.pop(); if (c.geometry) c.geometry.dispose(); }
      const holes = [];
      for (const l of done) {
        if (l.isHole) { if (!(l.parent && doneSet.has(l.parent.id))) holes.push(l.pts); }
        else holes.push(offsetPoly(l.pts, kerf));
      }
      const rect = [[P.x0, P.y0], [P.x1, P.y0], [P.x1, P.y1], [P.x0, P.y1]];
      this.plateGroup.add(this.extrude(this.shapeFrom(rect, holes), [this.matTop, this.matSide]));

      // freed parts lift slightly
      for (const [id, mesh] of this.parts) if (!doneSet.has(id)) { this.world.remove(mesh); mesh.geometry.dispose(); this.parts.delete(id); }
      for (const l of done) {
        if (l.isHole || this.parts.has(l.id)) continue;
        const kids = done.filter(h => h.isHole && h.parent === l).map(h => h.pts);
        const mesh = this.extrude(this.shapeFrom(l.pts, kids), [this.matTop, this.matCutEdge]);
        mesh.userData = { start: animate ? performance.now() : -1e9 };
        this.parts.set(l.id, mesh); this.world.add(mesh);
      }
      // hole scrap drops through the table
      for (const [id, mesh] of this.slugs) if (!doneSet.has(id)) { this.world.remove(mesh); mesh.geometry.dispose(); this.slugs.delete(id); }
      for (const l of done) {
        if (!l.isHole || this.slugs.has(l.id)) continue;
        const sp = offsetPoly(l.pts, -kerf);
        if (Math.abs(area(sp)) < 1) continue;
        const mesh = this.extrude(this.shapeFrom(sp), [this.matTop, this.matCutEdge]);
        const c = sp.reduce((a, p) => [a[0] + p[0] / sp.length, a[1] + p[1] / sp.length], [0, 0]);
        mesh.geometry.translate(-c[0], -c[1], 0);
        mesh.position.set(c[0], c[1], 0);
        mesh.userData = { start: animate ? performance.now() : -1e9, rx: (Math.random() - 0.5) * 1.2, ry: (Math.random() - 0.5) * 1.2 };
        this.slugs.set(l.id, mesh); this.world.add(mesh);
      }
    }

    animatePieces(now) {
      for (const m of this.slugs.values()) {
        const p = Math.min(1, (now - m.userData.start) / 650), e = p * p;
        m.position.z = (this.floorZ + 1) * e;
        m.rotation.x = m.userData.rx * e; m.rotation.y = m.userData.ry * e;
      }
      for (const m of this.parts.values()) {
        const p = Math.min(1, (now - m.userData.start) / 900);
        m.position.z = 22 * (1 - Math.pow(1 - p, 3));
      }
    }

    buildTorch() {
      const THREE = this.THREE;
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 170, 28), new THREE.MeshStandardMaterial({ color: 0x2c3237, metalness: 0.7, roughness: 0.35 }));
      body.geometry.rotateX(Math.PI / 2); body.position.z = 115; g.add(body);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 10, 28), new THREE.MeshStandardMaterial({ color: 0xc8661b, metalness: 0.4, roughness: 0.5 }));
      band.geometry.rotateX(Math.PI / 2); band.position.z = 70; g.add(band);
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(11, 5, 30, 28), new THREE.MeshStandardMaterial({ color: 0xb48a52, metalness: 0.85, roughness: 0.3 }));
      nozzle.geometry.rotateX(Math.PI / 2); nozzle.position.z = 15; g.add(nozzle);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(4, 1, 20, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x7fb6ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
      flame.geometry.rotateX(-Math.PI / 2); flame.geometry.translate(0, 0, -0.5);
      g.add(flame);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      g.add(glow);
      const light = new THREE.PointLight(0xff9a40, 0, 260, 2); g.add(light);
      this.torch = { g, flame, glow, light };
      this.world.add(g);
    }

    buildSparks() {
      const THREE = this.THREE, N = 420;
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(N * 3).fill(-1e5);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ color: 0xffb04a, size: 3.2, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
      this.world.add(pts);
      this.sparks = { pts, pos, vel: new Float32Array(N * 3), life: new Float32Array(N), N, next: 0 };
    }

    updateSparks(dt, emitAt, rate) {
      const S = this.sparks; if (!S) return;
      if (emitAt) {
        const n = Math.min(S.N, Math.round(rate * Math.min(dt, 0.05)));
        for (let k = 0; k < n; k++) {
          const i = S.next; S.next = (S.next + 1) % S.N;
          const up = Math.random() < 0.25;
          S.pos[i * 3] = emitAt[0] + (Math.random() - 0.5) * 2; S.pos[i * 3 + 1] = emitAt[1] + (Math.random() - 0.5) * 2;
          S.pos[i * 3 + 2] = up ? this.opts.thickness : 0;
          const a = Math.random() * TAU, sp = 40 + Math.random() * 260;
          S.vel[i * 3] = Math.cos(a) * sp; S.vel[i * 3 + 1] = Math.sin(a) * sp;
          S.vel[i * 3 + 2] = up ? 60 + Math.random() * 160 : -(150 + Math.random() * 450);
          S.life[i] = 0.35 + Math.random() * 0.5;
        }
      }
      for (let i = 0; i < S.N; i++) {
        if (S.life[i] <= 0) { S.pos[i * 3 + 2] = -1e5; continue; }
        S.life[i] -= dt;
        S.vel[i * 3 + 2] -= 1800 * dt;
        S.pos[i * 3] += S.vel[i * 3] * dt; S.pos[i * 3 + 1] += S.vel[i * 3 + 1] * dt; S.pos[i * 3 + 2] += S.vel[i * 3 + 2] * dt;
      }
      S.pts.geometry.attributes.position.needsUpdate = true;
    }

    torchAt(t) {
      const segs = this.tl.segs;
      if (!segs.length) return { p: [0, 0], state: 'idle', line: -1 };
      if (t >= this.tl.total - 1e-9) { const last = segs[segs.length - 1]; const p = last.pts ? last.pts[last.pts.length - 1] : last.p; return { p, state: 'done', line: last.line }; }
      const sg = segs[this.segIndex(t)];
      if (sg.type === 'pierce') return { p: sg.p, state: 'pierce', line: sg.line, f: (t - sg.t0) / Math.max(1e-6, sg.t1 - sg.t0) };
      const f = Math.min(1, Math.max(0, (t - sg.t0) / Math.max(1e-6, sg.t1 - sg.t0)));
      return { p: this.subPath(sg, f * sg.len, f * sg.len)[0], state: sg.type === 'rapid' ? 'rapid' : 'cut', line: sg.line };
    }

    loop(now) {
      if (!this.renderer) return;
      this.raf = requestAnimationFrame(this.loop);
      if (!this.host.isConnected) { this.destroy(); return; }
      if (document.hidden) { this.lastFrame = 0; return; }
      const dt = Math.min(0.25, this.lastFrame ? (now - this.lastFrame) / 1000 : 0.016);
      this.lastFrame = now;
      if (this.playing) {
        this.t = Math.min(this.tl.total, this.t + dt * this.speedFactor());
        if (this.t >= this.tl.total) this.setPlaying(false);
      }
      this.applyTime(this.t, this.playing);
      const st = this.cur, T = this.opts.thickness, tr = this.torch;
      const on = st.state === 'cut' || st.state === 'pierce';
      const zTip = on ? T + 6 : T + 32;
      const z0 = tr.g.position.z || zTip;
      tr.g.position.set(st.p[0], st.p[1], z0 + (zTip - z0) * Math.min(1, dt * 12));
      const z = tr.g.position.z;
      const flick = 0.85 + Math.random() * 0.3;
      tr.flame.visible = on; tr.glow.visible = on;
      if (on) {
        tr.flame.scale.set(1, 1, Math.max(1, z - T));
        const heat = st.state === 'pierce' ? Math.min(1, (st.f || 0) * 1.3) : 1;
        tr.glow.position.z = T - z + 0.5;
        const r = (st.state === 'cut' ? 4.5 : 2 + 4 * heat) * flick;
        tr.glow.scale.set(r, r, r * 0.5);
        tr.glow.material.color.setHex(st.state === 'cut' ? 0xffa040 : (heat > 0.8 ? 0xff7a2a : 0xff5520));
        tr.light.position.z = T - z + 4; tr.light.intensity = (st.state === 'cut' ? 2.2 : 1.2 * heat) * flick;
      } else tr.light.intensity = 0;
      this.updateSparks(dt, this.playing && st.state === 'cut' ? st.p : null, 900);
      this.animatePieces(now);
      if (this.q('.sim-follow').checked) {
        const tgt = this.controls.target, dx = st.p[0] - tgt.x, dy = st.p[1] - tgt.y, k = Math.min(1, dt * 4);
        tgt.x += dx * k; tgt.y += dy * k; this.camera.position.x += dx * k; this.camera.position.y += dy * k;
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (now - (this.hudAt || 0) > 90) { this.hudAt = now; this.updateHud(); }
    }

    applyTime(t, animate) {
      if (t < this.drawnT - 1e-9) { this.resetCanvas(); this.drawRange(0, t); }
      else this.drawRange(this.drawnT, t);
      this.drawnT = t;
      this.updatePlateMeshes(t, animate);
      this.cur = this.torchAt(t);
    }

    speedFactor() {
      const v = this.q('.sim-speed').value;
      return v === 'auto' ? Math.max(1, this.tl.total / 60) : parseFloat(v) || 1;
    }

    updateHud() {
      const st = this.cur || this.torchAt(this.t);
      const lbl = { rapid: 'Gerak cepat, torch naik', pierce: 'Preheat & tembus', cut: 'Memotong', done: 'Selesai', idle: 'Siap' }[st.state] || '';
      const el = this.q('.sim-status'); el.textContent = lbl; el.dataset.state = st.state;
      this.q('.sim-pos').textContent = 'X ' + st.p[0].toFixed(1) + '   Y ' + st.p[1].toFixed(1);
      this.q('.sim-line').textContent = st.line >= 0 && this.data.lines[st.line] != null ? 'N' + (st.line + 1) + '  ' + this.data.lines[st.line] : '';
      this.q('.sim-time').textContent = fmtT(this.t) + ' / ' + fmtT(this.tl.total);
      if (!this.seeking) this.q('.sim-seek').value = String(Math.round(this.t * 10));
    }

    setPlaying(on) {
      if (on && this.t >= this.tl.total - 1e-6) { this.t = 0; }
      this.playing = on;
      this.q('.sim-play').textContent = on ? 'Jeda' : 'Putar';
    }

    view(kind) {
      const P = this.plate, cx = (P.x0 + P.x1) / 2, cy = (P.y0 + P.y1) / 2, M = Math.max(P.w, P.h);
      this.controls.target.set(cx, cy, 0);
      if (kind === 'top') this.camera.position.set(cx, cy - M * 0.02, M * 1.55);
      else this.camera.position.set(cx - P.w * 0.22, cy - P.h * 1.25, M * 0.9);
      this.controls.update();
    }

    bindUI() {
      this.q('.sim-play').addEventListener('click', () => this.setPlaying(!this.playing));
      this.q('.sim-restart').addEventListener('click', () => { this.t = 0; this.applyTime(0, false); this.setPlaying(true); });
      const seek = this.q('.sim-seek');
      seek.addEventListener('input', () => { this.seeking = true; this.t = Math.min(this.tl.total, (+seek.value) / 10); this.applyTime(this.t, false); this.updateHud(); });
      seek.addEventListener('change', () => { this.seeking = false; });
      this.q('.sim-v3d').addEventListener('click', () => this.view('3d'));
      this.q('.sim-vtop').addEventListener('click', () => this.view('top'));
      let tm;
      ['.sim-thk', '.sim-kerf', '.sim-pierce'].forEach(c => this.q(c).addEventListener('input', () => {
        clearTimeout(tm);
        tm = setTimeout(() => {
          const f = this.tl.total ? this.t / this.tl.total : 0;
          this.t = 0; this.rebuild(false);
          this.t = f * this.tl.total; this.applyTime(this.t, false); this.updateHud();
        }, 300);
      }));
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      if (this.ro) this.ro.disconnect();
      if (this.renderer) { this.renderer.dispose(); if (this.renderer.forceContextLoss) this.renderer.forceContextLoss(); }
      this.renderer = null;
    }
  }

  let current = null;
  root.Sim3D = {
    open(host, data) {
      if (current) current.destroy();
      current = new Sim(host);
      return current.load(data);
    },
    close() { if (current) { current.destroy(); current = null; } },
    buildTimeline,
  };
})(typeof window !== 'undefined' ? window : globalThis);
