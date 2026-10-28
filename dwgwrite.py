#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dwgwrite - tulis layout nesting sebagai DWG yang bisa dibuka AutoCAD.

Gambar dibuat dulu sebagai DXF (ezdxf), lalu disimpan sebagai DWG oleh konverter resmi:
  1. AutoCAD accoreconsole.exe (dicari di registry, atau env NEST_ACCORECONSOLE)
  2. ODA File Converter (kalau terpasang)
DWG tulisan LibreDWG langsung tidak dipakai: AutoCAD menolaknya ("created by an incompatible version").
Hasil DWG dibaca balik (LibreDWG dwg2dxf + ezdxf) dan dicocokkan dengan layout.

layout = {"plates": [{"x0", "y0", "w", "h", "name",
                      "parts": [{"label", "outer": [[x, y]...], "inners": [[[x, y]...]], "holes": [[cx, cy, r]], "lx", "ly"}]}],
          "text_height": 20}
"""
import glob
import os
import shutil
import subprocess
import sys
import tempfile

import ezdxf

HERE = os.path.dirname(os.path.abspath(__file__))
DLL_DIR = os.path.join(HERE, "libredwg")
LAYERS = {"PLATE": 8, "PART": 4, "LABEL": 2}


def write_dxf(path, layout):
    doc = ezdxf.new("R2018", setup=True)
    doc.units = ezdxf.units.MM
    for name, color in LAYERS.items():
        doc.layers.add(name, color=color)
    msp = doc.modelspace()
    th = float(layout.get("text_height", 20))
    n = 0
    for pl in layout["plates"]:
        x0, y0, w, h = (float(pl[k]) for k in ("x0", "y0", "w", "h"))
        msp.add_lwpolyline([(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)], close=True, dxfattribs={"layer": "PLATE"})
        msp.add_text(pl.get("name", ""), height=th * 2, dxfattribs={"layer": "PLATE", "insert": (x0, y0 + h + th)})
        for p in pl["parts"]:
            msp.add_lwpolyline(p["outer"], close=True, dxfattribs={"layer": "PART"})
            for ring in p.get("inners", []):
                msp.add_lwpolyline(ring, close=True, dxfattribs={"layer": "PART"})
            for cx, cy, r in p.get("holes", []):
                msp.add_circle((cx, cy), r, dxfattribs={"layer": "PART"})
            msp.add_text(p["label"], height=th, dxfattribs={"layer": "LABEL", "insert": (p["lx"], p["ly"])})
            n += 1
    doc.saveas(path)
    return n


def find_accoreconsole():
    env = os.environ.get("NEST_ACCORECONSOLE")
    if env and os.path.isfile(env):
        return env
    found = []
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                root = winreg.OpenKey(hive, r"SOFTWARE\Autodesk\AutoCAD")
            except OSError:
                continue
            for i in range(winreg.QueryInfoKey(root)[0]):
                rel = winreg.EnumKey(root, i)
                k = winreg.OpenKey(root, rel)
                for j in range(winreg.QueryInfoKey(k)[0]):
                    try:
                        loc = winreg.QueryValueEx(winreg.OpenKey(k, winreg.EnumKey(k, j)), "AcadLocation")[0]
                    except OSError:
                        continue
                    exe = os.path.join(loc, "accoreconsole.exe")
                    if os.path.isfile(exe):
                        found.append((rel, exe))
    except ImportError:
        pass
    found += [("~", p) for p in glob.glob(r"C:\Program Files\Autodesk\AutoCAD *\accoreconsole.exe")]
    return sorted(found)[-1][1] if found else None   # versi terbaru


def dxf_to_dwg(dxf, dwg):
    """Return nama konverter yang dipakai. Raise kalau tidak ada / gagal."""
    if os.path.exists(dwg):
        os.remove(dwg)
    acc = find_accoreconsole()
    if acc:
        scr = os.path.join(os.path.dirname(dwg), "_save.scr")
        with open(scr, "w", encoding="utf-8") as fh:
            fh.write(f'_.SAVEAS\n2018\n"{os.path.abspath(dwg)}"\n')
        # stdin kosong: tanpa itu accoreconsole menunggu input setelah skrip selesai
        r = subprocess.run([acc, "/i", os.path.abspath(dxf), "/s", scr, "/l", "en-US"],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=600, cwd=os.path.dirname(dwg))
        if os.path.isfile(dwg):
            return os.path.basename(os.path.dirname(acc))   # mis. "AutoCAD 2027"
        log = (r.stdout or b"").replace(b"\0", b"").decode("utf-8", "replace")
        raise RuntimeError("AutoCAD (accoreconsole) gagal menyimpan DWG: " + log.strip()[-300:])
    try:
        from ezdxf.addons import odafc
        if odafc.is_installed():
            odafc.convert(dxf, dwg, version="R2018", replace=True)
            return "ODA File Converter"
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"ODA File Converter gagal: {e}") from e
    raise RuntimeError("Tidak ada konverter DWG: pasang AutoCAD (accoreconsole) atau ODA File Converter (gratis). "
                       "File DXF tetap ada di ZIP dan bisa dibuka AutoCAD.")


def write_dwg(dwg, layout):
    """Tulis <dwg> dan <dwg tanpa ekstensi>.dxf. Return (jumlah part, nama konverter)."""
    dxf = os.path.splitext(dwg)[0] + ".dxf"
    n = write_dxf(dxf, layout)
    return n, dxf_to_dwg(dxf, dwg)


def expected(layout):
    """Jumlah entitas & batas koordinat PART yang seharusnya ada di DWG."""
    parts = [p for pl in layout["plates"] for p in pl["parts"]]
    pts = [q for p in parts for ring in [p["outer"], *p.get("inners", [])] for q in ring]
    cnt = {("LWPOLYLINE", "PLATE"): len(layout["plates"]), ("TEXT", "PLATE"): len(layout["plates"]),
           ("LWPOLYLINE", "PART"): sum(1 + len(p.get("inners", [])) for p in parts),
           ("TEXT", "LABEL"): len(parts)}
    holes = sum(len(p.get("holes", [])) for p in parts)
    if holes:
        cnt[("CIRCLE", "PART")] = holes
    ext = (min(q[0] for q in pts), min(q[1] for q in pts), max(q[0] for q in pts), max(q[1] for q in pts)) if pts else None
    return cnt, ext


def dwg2dxf():
    """Pembaca DWG LibreDWG: exe bawaan di Windows, `dwg2dxf` dari sistem di Linux/macOS."""
    local = os.path.join(DLL_DIR, "dwg2dxf.exe")
    if os.name == "nt" and os.path.isfile(local):
        return local
    exe = shutil.which("dwg2dxf")
    if not exe:
        raise RuntimeError("dwg2dxf (LibreDWG) tidak ditemukan untuk cek DWG. Linux: pasang LibreDWG yang menyediakan perintah dwg2dxf.")
    return exe


def readback(path):
    """Baca balik DWG dengan dwg2dxf + ezdxf. Return (jumlah per (tipe, layer), semua polyline tertutup, batas PART)."""
    exe = dwg2dxf()
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "back.dxf")
        subprocess.run([exe, "-y", "-o", out, path], capture_output=True, stdin=subprocess.DEVNULL)
        if not os.path.isfile(out):
            raise RuntimeError("DWG tidak bisa dibaca balik")
        msp = ezdxf.readfile(out).modelspace()
        cnt = {}
        for e in msp:
            k = (e.dxftype(), e.dxf.layer)
            cnt[k] = cnt.get(k, 0) + 1
        closed = all(e.closed for e in msp.query("LWPOLYLINE"))
        pts = [p for e in msp.query('LWPOLYLINE[layer=="PART"]') for p in e.get_points("xy")]
        ext = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)) if pts else None
        return cnt, closed, ext


def verify(path, layout):
    """Bandingkan DWG dengan layout. Return daftar masalah (kosong = cocok)."""
    with open(path, "rb") as fh:
        magic = fh.read(6)
    if not magic.startswith(b"AC10"):
        return [f"bukan file DWG (header {magic!r})"]
    cnt, closed, ext = readback(path)
    want, want_ext = expected(layout)
    errs = [f"{k[0]} di layer {k[1]}: DWG {cnt.get(k, 0)}, seharusnya {v}" for k, v in want.items() if cnt.get(k, 0) != v]
    if not closed:
        errs.append("ada polyline yang tidak tertutup")
    if want_ext and (not ext or max(abs(a - b) for a, b in zip(ext, want_ext)) > 0.01):
        errs.append(f"batas koordinat part DWG {ext} != layout {want_ext}")
    return errs


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.mkdtemp(), "selftest.dwg")
    lay = {"plates": [{"x0": 0, "y0": 0, "w": 2000, "h": 1000, "name": "PLAT 1", "parts": [
        {"label": "A40-L-SF1 #1", "outer": [[10, 10], [1120, 10], [1120, 290], [10, 290]],
         "inners": [[[500, 100], [600, 100], [600, 200], [500, 200]]],
         "holes": [[60, 60, 13]], "lx": 100, "ly": 150}]}]}
    n, conv = write_dwg(out, lay)
    errs = verify(out, lay)
    assert not errs, errs
    lay["plates"][0]["parts"][0]["holes"].append([70, 70, 5])
    assert verify(out, lay), "verify harus menangkap DWG yang tidak cocok"
    print(f"LULUS - {out} via {conv}")
