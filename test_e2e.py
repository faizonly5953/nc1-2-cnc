#!/usr/bin/env python3
"""Tes ujung-ke-ujung: NC1 -> nesting (node) -> ZIP server -> DWG dibaca balik -> koordinat DWG == G-code.

    python test_e2e.py [folder_nc1]
"""
import io
import json
import os
import subprocess
import sys
import tempfile
import zipfile

import ezdxf

import dwgwrite
import server

HERE = os.path.dirname(os.path.abspath(__file__))


def gcode_points(text):
    """Titik akhir gerak potong (G01/G02/G03) dari G-code G90/G91."""
    absolute, pos, out = False, (0.0, 0.0), []
    for line in text.splitlines():
        line = line.split("(")[0].strip()
        if not line:
            continue
        w, i = {}, 0
        while i < len(line):
            if line[i].isalpha():
                j = i + 1
                while j < len(line) and (line[j].isdigit() or line[j] in ".-+"):
                    j += 1
                w.setdefault(line[i], line[i + 1:j])
                i = j
            else:
                i += 1
        g = int(float(w["G"])) if "G" in w else None
        if g in (90, 91):
            absolute = g == 90
        elif g == 92:
            pos = (0.0, 0.0)
        elif g in (0, 1, 2, 3):
            x, y = float(w.get("X", 0)), float(w.get("Y", 0))
            pos = (x, y) if absolute else (pos[0] + x, pos[1] + y)
            if g:
                out.append(pos)
    return out


def main():
    with tempfile.TemporaryDirectory() as td:
        body = os.path.join(td, "body.json")
        args = ["node", os.path.join(HERE, "web", "test", "nest.test.js")] + sys.argv[1:2]
        r = subprocess.run(args, env=dict(os.environ, EXPORT_BODY=body), capture_output=True, text=True)
        assert r.returncode == 0, r.stdout + r.stderr
        with open(body) as fh:
            req = json.load(fh)
        name, conv, data = server.build_zip(req)
        z = zipfile.ZipFile(io.BytesIO(data))
        names = z.namelist()
        assert "LAPORAN.txt" in names, names
        checked, labels = 0, []
        for f in req["files"]:
            stem = f["file"][:-4]
            assert {stem + ".TXT", stem + ".dwg", stem + ".dxf"} <= set(names), (stem, names)
            dwg = os.path.join(td, stem + ".dwg")
            with open(dwg, "wb") as fh:
                fh.write(z.read(stem + ".dwg"))
            with open(dwg, "rb") as fh:
                assert fh.read(6) == b"AC1032"   # AutoCAD 2018 DWG
            assert dwgwrite.verify(dwg, f["dwg"]) == [], stem

            # DWG file ini dibaca balik: tiap sudut part harus ada di G-code file yang SAMA, tanpa geser
            back = os.path.join(td, stem + "_back.dxf")
            subprocess.run([dwgwrite.dwg2dxf(), "-y", "-o", back, dwg], capture_output=True)
            msp = ezdxf.readfile(back).modelspace()
            gpts = gcode_points(z.read(f["file"]).decode("ascii"))
            for e in msp.query('LWPOLYLINE[layer=="PART"]'):
                for x, y in e.get_points("xy"):
                    assert any(abs(gx - x) < 0.002 and abs(gy - y) < 0.002 for gx, gy in gpts), (stem, x, y)
                    checked += 1
            mine = [t.dxf.text for t in msp.query('TEXT[layer=="LABEL"]')]
            assert len(mine) == len(f["dwg"]["plates"][0]["parts"]), stem
            labels += mine
        assert len(labels) == len(set(labels)) == 147, "tiap part tepat di satu DWG"
        print(f"LULUS - {len(req['files'])} pasang TXT+DWG+DXF via {conv}: {checked} sudut part DWG cocok dengan G-code-nya, 147 label unik")


if __name__ == "__main__":
    main()
