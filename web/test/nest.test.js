// node web/test/nest.test.js [folder_nc1]  -> LULUS / assert error
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
for (const f of ['core.js', 'nc1.js', 'nest.js']) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { filename: f });
const N = globalThis.Nest;
const dir = process.argv[2] || 'C:/Users/faizb/Documents/Word,Excel,Etc/Word/ISP/Nesting/DWG DXF/NC1';
const cfg = Object.assign({}, globalThis.Dwg2Cnc.DEFAULTS, { plate_w: 10987, plate_h: 8016, margin: 15, spacing: 10, rotation: 'all', mode: 'G90' });

// 1. import + QTY
const types = fs.readdirSync(dir).filter(f => /\.nc1$/i.test(f)).map((f, i) => N.makeType('T' + i, f, fs.readFileSync(path.join(dir, f), 'latin1')));
const qty = Object.fromEntries(types.map(t => [t.name, t.qty]));
assert.deepStrictEqual(qty, { 'A40-L-SF1': 96, 'A40-L-SF2': 24, 'A40-L-SF3': 24, 'A40-PL5': 3 });
assert(types.every(t => t.valid), types.map(t => t.errors).join(';'));

// 2. nesting: semua instance tertempatkan, tanpa error validasi
const state = Object.assign({ types }, N.nest(types, cfg));
const total = state.plates.reduce((a, p) => a + p.insts.length, 0);
assert.strictEqual(total, 147);
assert.strictEqual(state.unplaced.length, 0);
assert.deepStrictEqual(N.validate(state, cfg).filter(e => e.level === 'error'), []);

// 3. G-code: tiap plat lolos simulasi, sudut tiap part ada di G-code (canvas == G-code)
const id = N.layoutId(state);
for (const pl of state.plates) {
  const files = N.gcodeForPlate(pl, cfg, 'f2100b', id);
  assert.deepStrictEqual(files.flatMap(f => f.errors), []);
  assert.strictEqual(files.reduce((a, f) => a + f.count, 0), pl.insts.length);
  assert(files.every(f => f.text.split('\r\n').length - 1 <= 10000));
  const ends = files.flatMap(f => f.moves.filter(m => m.code !== 0).map(m => m.p1));
  for (const inst of pl.insts) for (const p of N.world(inst).outer)
    assert(ends.some(e => Math.hypot(e[0] - p[0], e[1] - p[1]) < 0.002), 'sudut ' + p + ' dari ' + inst.uid + ' tidak ada di G-code');
  console.log('plat', pl.index + 1, pl.group, pl.insts.length, 'pcs, util', (N.utilization(pl) * 100).toFixed(1) + '%, file', files.map(f => f.file + '(' + (f.text.split('\r\n').length - 1) + ')').join(' '));
}

// 4. validasi menangkap tabrakan, keluar batas, QTY kurang
const pl0 = state.plates[0], a = pl0.insts[0], b = pl0.insts[1], save = [b.x, b.y];
b.x = a.x + 5; b.y = a.y + 5;
assert(N.validate(state, cfg).some(e => /bertabrakan/.test(e.msg)));
b.x = pl0.w; assert(N.validate(state, cfg).some(e => /keluar dari batas/.test(e.msg)));
[b.x, b.y] = save;
const removed = pl0.insts.pop();
assert(N.validate(state, cfg).some(e => /QTY \d+, yang ada di plat \d+/.test(e.msg)));
pl0.insts.push(removed);
assert.deepStrictEqual(N.validate(state, cfg).filter(e => e.level === 'error'), []);

// 5. rotasi 90: bbox tertukar, findFreeSpot memberi posisi valid
assert.deepStrictEqual(N.dims(a.type, 90), [a.type.h, a.type.w]);
const spot = N.findFreeSpot({ index: 9, w: 3000, h: 3000, insts: [] }, { type: a.type, rot: 90, x: 0, y: 0 }, cfg);
assert(spot && spot.x === 15 && spot.y === 15);

// 6. NC1 rusak dilaporkan, tidak ditebak
const bad = (txt) => N.makeType('X', 'x.nc1', txt);
assert(!bad('ST\n  0\n  1\n  P\n  P\n  S355\n  2\n  HEA200\n  I\n  100\n  200\nEN\n').valid);              // bukan plat, tanpa AK
assert(/QTY/.test(bad('ST\n  0\n  1\n  P\n  P\n  S355\n  x\n  PL10\n  B\nAK\n  v 0 0 0\n  10 0 0\n  10 10 0\n  0 0 0\nEN\n').errors.join()));
assert(/busur/.test(bad('ST\n  0\n  1\n  P\n  P\n  S355\n  1\n  PL10\n  B\nAK\n  v 0 0 0\n  10 0 5\n  10 10 0\n  0 0 0\nEN\n').errors.join()));
// 7. berat (7850 kg/m³) dan pembagian plat per tebal
const m0 = N.mass(state.plates[0]);
assert.strictEqual(m0.thickness, 20);
assert(Math.abs(m0.plate - 10987 * 8016 * 20 * 7.85e-6) < 1e-6);                // ±13.827 kg
assert(Math.abs(m0.parts + m0.waste - m0.plate) < 1e-9 && m0.waste > 0);
assert(Math.abs(N.typeMass(qtyType('A40-PL5')) - (180.01 * 80 * 20 * 7.85e-6)) < 0.01);   // ±2,26 kg
assert(types.every(t => t.warnings.length === 0), 'header berat 157 kg/m² harus cocok PL20');
const sf1 = fs.readFileSync(path.join(dir, 'A40-L-SF1.nc1'), 'latin1');
const pl12 = N.makeType('T12', 'X12.nc1', sf1.replace('A40-L-SF1\r\n  A40-L-SF1', 'X12\r\n  X12').replace(/PL20/, 'PL12').replace(/157\.000/, '94.200'));
assert.strictEqual(pl12.thickness, 12); assert(pl12.valid, pl12.errors.join());
const mixed = N.nest([...types, pl12], cfg);
assert(mixed.plates.length >= 2 && mixed.plates.every(p => new Set(p.insts.map(i => i.type.thickness)).size === 1), 'PL12 dan PL20 tidak boleh satu plat');
assert(mixed.plates.some(p => N.mass(p).thickness === 12));
function qtyType(name) { return types.find(t => t.name === name); }

// 8. body ekspor (sama dengan yang dikirim nest.html) untuk test_e2e.py
if (process.env.EXPORT_BODY) {
  const files = state.plates.flatMap(pl => N.gcodeForPlate(pl, cfg, 'f2100b', id));
  fs.writeFileSync(process.env.EXPORT_BODY, JSON.stringify({ name: 'NESTING_' + id, files: files.map(f => ({ file: f.file, text: f.text, dwg: f.dwg })), report: 'tes' }));
}
console.log('LULUS -', state.plates.length, 'plat, layout', id);
