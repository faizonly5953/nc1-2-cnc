# nc1-2-cnc

Mengubah file **DSTV NC1** (plat dari Tekla / software detailing baja) menjadi **G-code `.TXT`** untuk kontroler
**FLSK F2100B** (mesin potong plasma/flame portable, mis. MiniCut). Jalan di **Windows dan Linux**.

- **NC1 Auto Nesting** (`web/nest.html`): banyak file NC1 sekaligus, QTY dibaca otomatis, semua part disusun
  di plat stok, lalu diekspor jadi G-code + DWG per file.
- **Konversi satu file** (`nc1tocnc.py` / `web/index.html`): satu NC1 = satu G-code, tanpa nesting.

Satuan selalu milimeter.

## Fitur

- Baca header NC1: nama part, mutu baja, **QTY**, profil (`PL20` = tebal 20 mm), berat/m².
- Buat semua instance sesuai QTY (mis. QTY 96 → 96 part), tanpa duplikasi manual.
- Nesting otomatis ke beberapa plat, dipisah per **mutu & tebal** (PL12 tidak pernah dicampur dengan PL20).
- Kanvas interaktif: pilih, seret, putar 90°, pindah ke plat lain, zoom.
- Validasi: tabrakan, jarak antar part, margin plat, QTY yang hilang, NC1 yang tidak lengkap.
- **Berat & sisa** per plat (baja 7.850 kg/m³).
- **Simulasi 3D** pemotongan per plat (G-code yang sama dengan hasil ekspor).
- Ekspor ZIP: tiap file G-code (`PLAT01A.TXT`) punya DWG + DXF bernama sama (`PLAT01A.dwg`) berisi hanya part file itu.

## Cara kerja

1. **Baca NC1** (`web/nc1.js`): blok `ST` (header), `AK` (kontur luar), `IK` (kontur dalam), `BO` (lubang), sisi `v`.
   Data yang tidak bisa dibaca dengan pasti (tanpa `AK`, profil bukan plat, kontur berbusur, QTY kosong) **ditolak
   dengan pesan error**, tidak ditebak.
2. **Instance**: tiap part dikalikan QTY.
3. **Nesting** (`web/nest.js`): MaxRects per bounding box, rotasi 0/90/180/270° (bisa dikunci), dengan margin tepi
   dan jarak antar part. Part yang tidak muat di plat yang ada masuk ke plat baru.
4. **Kanvas** (`web/nest.html`): ubah layout. Tiap perubahan langsung divalidasi, dan sidik layout (`Layout XXXXXXXX`)
   berubah. Sidik ini ditulis juga di G-code dan DWG.
5. **G-code** (`web/core.js`, sama dengan proyek dwg2cnc): lubang dulu, kontur luar terakhir, lead-in/out, kerf G41.
   Titik nol = pojok kiri bawah plat (`G92X0Y0`). Kalau satu plat melebihi batas mesin 10.000 baris, plat dipecah
   jadi `PLAT01A`, `PLAT01B`, … (titik nol tetap sama). Tiap file disimulasikan ulang dan dicek, termasuk titik tembus
   yang tidak boleh jatuh di part lain.
6. **DWG** (`server.py` + `dwgwrite.py`): gambar dibuat sebagai DXF, lalu **disimpan sebagai DWG oleh AutoCAD**
   (`accoreconsole.exe`, dicari otomatis) atau ODA File Converter. DWG dibaca balik dan dicocokkan dengan layout
   sebelum dikirim.

Hanya kode G/M dari manual F2100B yang dipakai: `G92 G90 G91 G21 G41 G40 G00 G01 G02 G03 M07 M08 M02`.

## Kebutuhan

| | Windows | Linux |
|---|---|---|
| Python 3.9+ dengan `ezdxf`, `matplotlib` | dipasang otomatis oleh `BUKA-NESTING.bat` | dipasang otomatis oleh `buka-nesting.sh` |
| Simpan DWG | AutoCAD (dicari otomatis) atau ODA File Converter | ODA File Converter |
| Cek baca-balik DWG | `libredwg/dwg2dxf.exe` (sudah ada) | perintah `dwg2dxf` dari LibreDWG |
| Tes | Node.js | Node.js |

Tanpa konverter DWG, ekspor DWG gagal dengan pesan jelas; G-code tetap bisa diunduh.

## Cara pakai

- **Windows**: klik dua kali `BUKA-NESTING.bat`.
- **Linux**: `./buka-nesting.sh`

Browser terbuka di `http://127.0.0.1:8768/nest.html`. Seret file `.nc1`, atur ukuran plat, cek kanvas dan validasi,
lalu klik **Finalisasi & ekspor**.

**Satu file tanpa nesting**:

```bash
python3 nc1tocnc.py A40-L-SF1.nc1 -o hasil --mode G90
```

Pengaturan (mode, kerf, lead-in, offset, dll.) ada di `dwg2cnc.ini`.

**Di mesin**: salin `.TXT` ke flashdisk, letakkan torch di pojok kiri bawah plat, dan **selalu dry-run
(`Space > F3 Frame`, tanpa api) sebelum memotong**.

## Struktur

| File | Isi |
|---|---|
| `web/nest.html`, `web/nest.js` | Aplikasi nesting: kanvas, validasi, post-processor, berat |
| `web/nc1.js` | Pembaca NC1 |
| `web/core.js` | Geometri → G-code F2100B (port JS dari dwg2cnc) |
| `web/sim3d.js`, `web/vendor/` | Simulasi 3D (three.js) |
| `web/index.html` | Konversi satu file NC1 di browser |
| `server.py` | Server lokal + endpoint ekspor ZIP |
| `dwgwrite.py` | Layout → DXF → DWG (AutoCAD/ODA) + cek baca-balik |
| `nc1tocnc.py`, `dwg2cnc.py` | Konversi lewat command line |
| `BUKA-NESTING.bat`, `buka-nesting.sh` | Launcher Windows / Linux |
| `libredwg/` | LibreDWG `dwg2dxf` untuk membaca DWG di Windows (GPLv3) |

Mesin lain bisa ditambahkan sebagai entri baru di `POSTS` pada `web/nest.js`.

## Tes

```bash
node web/test/nest.test.js "folder/berisi/nc1"   # parser, QTY, nesting, validasi, G-code, berat
python3 test_e2e.py "folder/berisi/nc1"          # ZIP → DWG dibaca balik → koordinat sama dengan G-code
```

## Batasan

- Nesting memakai bounding box: optimal untuk part persegi, tapi part bentuk L/segitiga memboroskan sudut.
- Kontur NC1 berbusur (radius di blok `AK`) belum didukung, jadi file seperti itu ditolak.
- Berat sisa sudah termasuk potongan lubang; lebar kerf tidak dihitung terpisah.

## Lisensi

LibreDWG (`libredwg/`) berlisensi GPLv3.
