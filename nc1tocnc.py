#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nc1tocnc - Konversi file DSTV NC1 (plat dari nesting/Tekla) menjadi G-code (.TXT)
untuk FLSK F2100B. Memakai pipeline dwg2cnc (lead-in, kerf G41, urutan, simulasi).

    python nc1tocnc.py A40-L-SF1.nc1 A40-PL5.nc1
    python nc1tocnc.py folder_nc1/ -o hasil --holes skip --mode G90

Blok NC1 yang dibaca: AK (kontur luar), IK (kontur dalam), BO (lubang bulat).
Hanya sisi 'v' (plat tampak depan). Blok lain (KA, SI, dll.) diabaikan.
"""
import argparse
import os
import re
import sys
import tempfile

import ezdxf

import dwg2cnc

NUM = re.compile(r"[-+]?\d*\.?\d+")
BLOCKS = ("ST", "EN", "AK", "IK", "BO", "SI", "KA", "SC", "PU", "KO", "BR", "UE", "TO", "EB")


def parse_nc1(path):
    """Return (contours, circles, warnings). contours = list of [(x, y)], circles = list of (x, y, d)."""
    contours, circles, warn = [], [], []
    block, cur = None, None
    with open(path, encoding="latin-1") as fh:
        lines = fh.read().splitlines()
    for ln in lines:
        if not ln.strip():
            continue
        if not ln[0].isspace() and ln[:2] in BLOCKS:
            block = ln[:2]
            cur = [] if block in ("AK", "IK") else None
            if cur is not None:
                contours.append(cur)
            if block == "EN":
                break
            continue
        if block not in ("AK", "IK", "BO"):
            continue
        s = ln.strip()
        if s[0].isalpha() and s[0] != "v":
            continue  # sisi lain (o/u/h)
        n = [float(x) for x in NUM.findall(s)]
        if block == "BO" and len(n) >= 3:
            circles.append((n[0], n[1], n[2]))
        elif block in ("AK", "IK") and len(n) >= 2:
            if len(n) > 2 and abs(n[2]) > 1e-9:
                warn.append(f"{block}: busur (radius {n[2]}) dianggap garis lurus")  # ponytail: busur NC1 belum didukung
            cur.append((n[0], n[1]))
    return [c for c in contours if len(c) >= 3], circles, sorted(set(warn))


def to_dxf(contours, circles, out):
    doc = ezdxf.new()
    msp = doc.modelspace()
    for c in contours:
        msp.add_lwpolyline(c, close=True, dxfattribs={"layer": "CUT"})
    for x, y, d in circles:
        msp.add_circle((x, y), d / 2, dxfattribs={"layer": "CUT"})
    doc.saveas(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="NC1 -> G-code untuk FLSK F2100B")
    ap.add_argument("inputs", nargs="+", help="file .nc1 atau folder")
    ap.add_argument("-o", "--outdir", help="folder output (default: sama dengan file NC1)")
    ap.add_argument("--config", help="file pengaturan (default: dwg2cnc.ini di samping script)")
    for k in dwg2cnc.DEFAULTS:
        ap.add_argument("--" + k.replace("_", "-"), dest=k, help=f"default: {dwg2cnc.DEFAULTS[k]}")
    a = ap.parse_args(argv)
    cfg = dwg2cnc.load_config(a.config)
    for k in dwg2cnc.DEFAULTS:
        if getattr(a, k) is not None:
            cfg[k] = getattr(a, k)

    files = []
    for p in a.inputs:
        if os.path.isdir(p):
            files += [os.path.join(p, f) for f in sorted(os.listdir(p)) if f.lower().endswith(".nc1")]
        else:
            files.append(p)

    ok = bad = 0
    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        try:
            contours, circles, warn = parse_nc1(f)
            if not contours:
                raise RuntimeError("blok AK (kontur luar) tidak ditemukan")
            for w in warn:
                print(f"  PERINGATAN [{name}]: {w}")
            with tempfile.TemporaryDirectory() as td:
                dxf = os.path.join(td, name + ".dxf")
                to_dxf(contours, circles, dxf)
                _, errs = dwg2cnc.convert(dxf, cfg, a.outdir or os.path.dirname(os.path.abspath(f)))
            ok, bad = (ok + 1, bad) if not errs else (ok, bad + 1)
        except Exception as e:  # noqa: BLE001
            bad += 1
            print(f"\n[{name}] GAGAL: {e}")
    print(f"\nSelesai: {ok} berhasil, {bad} bermasalah.")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
