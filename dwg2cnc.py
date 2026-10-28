#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dwg2cnc - Konversi gambar DWG/DXF menjadi G-code (.TXT) untuk kontroler
FLSK F2100B (mesin potong CNC portable plasma/flame, mis. MiniCut).

Cara pakai cepat:
    python dwg2cnc.py bagian1.dwg bagian2.dwg
    python dwg2cnc.py folder_gambar/            (semua .dwg/.dxf di folder)
    python dwg2cnc.py part.dxf --holes skip --mode G90

Hasil per gambar (di folder yang sama dengan gambar):
    NAMA.TXT          -> program G-code untuk flashdisk
    NAMA_preview.png  -> gambar jalur potong hasil simulasi G-code

Pengaturan default dibaca dari dwg2cnc.ini (di folder yang sama dengan script).

Kode G/M yang dipakai hanya yang ada di manual F2100B (Appendix 2):
G92 G90 G91 G21 G41 G40 G00 G01 G02 G03 M07 M08 M02.
"""
from __future__ import annotations

import argparse
import configparser
import fnmatch
import math
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field

try:
    import ezdxf
    from ezdxf import recover
except ImportError:  # pragma: no cover
    print("ERROR: modul 'ezdxf' belum terpasang. Jalankan:  pip install ezdxf matplotlib")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))

# --------------------------------------------------------------------------
# Pengaturan
# --------------------------------------------------------------------------
DEFAULTS = {
    "mode": "G91",                 # G91 = inkremental (seperti FastCAM), G90 = absolut
    "kerf": "G41",                 # G41 = pakai kompensasi kerf mesin, NONE = tanpa
    "holes": "cut",                # cut = lubang ikut dipotong, skip = hanya kontur luar
    "min_hole_diameter": "0",      # lubang lebih kecil dari ini (mm) dilewati
    "lead_in_outer": "8",          # panjang lead-in kontur luar (mm)
    "lead_in_hole": "6",           # lead-in lubang non-lingkaran (mm)
    "center_pierce_max_radius": "30",  # lubang bulat r <= ini: tembus di titik tengah
    "lead_out": "5",               # panjang lead-out (mm), 0 = tanpa
    "start_point": "corner",        # edge = tengah sisi terpanjang, corner = di sudut part
    "offset_x": "15",              # jarak part dari titik nol torch (mm)
    "offset_y": "15",
    "return_home": "yes",          # kembali ke titik nol di akhir program
    "decimals": "3",
    "ext": ".TXT",
    "header_comment": "yes",       # baris komentar (NAMA ...) di awal file
    "ignore_layers": "TEXT,DEFPOINTS,SCRIBE,DIM*,*DIMENSION*,MARK*,TITLE*",
    "cut_layers": "",              # kosong = semua layer selain ignore_layers
    "join_tolerance": "0.05",      # toleransi sambung ujung garis (mm)
    "cut_speed": "360",            # mm/menit, hanya untuk estimasi waktu
    "preview": "yes",
    "converter": "auto",           # auto | libredwg | oda
}


def load_config(path: str | None) -> dict:
    cfg = dict(DEFAULTS)
    ini = path or os.path.join(HERE, "dwg2cnc.ini")
    if os.path.isfile(ini):
        cp = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
        cp.read(ini, encoding="utf-8")
        if cp.has_section("settings"):
            for k, v in cp.items("settings"):
                cfg[k] = v.strip()
    return cfg


def yes(v) -> bool:
    return str(v).strip().lower() in ("yes", "y", "true", "1", "ya")


# --------------------------------------------------------------------------
# Geometri dasar
# --------------------------------------------------------------------------
def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


@dataclass
class Seg:
    kind: str                 # "L" garis, "A" busur
    p0: tuple
    p1: tuple
    c: tuple | None = None    # pusat busur
    ccw: bool = True          # arah busur

    @property
    def r(self):
        return dist(self.c, self.p0)

    def reversed(self) -> "Seg":
        return Seg(self.kind, self.p1, self.p0, self.c, not self.ccw)

    def sweep(self) -> float:
        """Sudut sapuan busur (radian, + CCW, - CW)."""
        a0 = math.atan2(self.p0[1] - self.c[1], self.p0[0] - self.c[0])
        a1 = math.atan2(self.p1[1] - self.c[1], self.p1[0] - self.c[0])
        if self.ccw:
            s = (a1 - a0) % (2 * math.pi)
            return s if s > 1e-12 else 2 * math.pi
        s = (a0 - a1) % (2 * math.pi)
        return -(s if s > 1e-12 else 2 * math.pi)

    def length(self) -> float:
        if self.kind == "L":
            return dist(self.p0, self.p1)
        return abs(self.sweep()) * self.r

    def points(self, step_deg=5.0):
        """Titik-titik pendekatan (tanpa titik awal)."""
        if self.kind == "L":
            return [self.p1]
        sw = self.sweep()
        n = max(2, int(abs(math.degrees(sw)) / step_deg) + 1)
        a0 = math.atan2(self.p0[1] - self.c[1], self.p0[0] - self.c[0])
        r = self.r
        pts = [(self.c[0] + r * math.cos(a0 + sw * i / n),
                self.c[1] + r * math.sin(a0 + sw * i / n)) for i in range(1, n)]
        pts.append(self.p1)
        return pts

    def midpoint(self):
        if self.kind == "L":
            return ((self.p0[0] + self.p1[0]) / 2, (self.p0[1] + self.p1[1]) / 2)
        a0 = math.atan2(self.p0[1] - self.c[1], self.p0[0] - self.c[0])
        a = a0 + self.sweep() / 2
        return (self.c[0] + self.r * math.cos(a), self.c[1] + self.r * math.sin(a))

    def tangent_at_mid(self):
        if self.kind == "L":
            d = (self.p1[0] - self.p0[0], self.p1[1] - self.p0[1])
        else:
            m = self.midpoint()
            v = (m[0] - self.c[0], m[1] - self.c[1])
            d = (-v[1], v[0]) if self.ccw else (v[1], -v[0])
        n = math.hypot(*d) or 1.0
        return (d[0] / n, d[1] / n)

    def split_mid(self):
        m = self.midpoint()
        return (Seg(self.kind, self.p0, m, self.c, self.ccw),
                Seg(self.kind, m, self.p1, self.c, self.ccw))

    def translated(self, dx, dy):
        t = lambda p: (p[0] + dx, p[1] + dy)
        return Seg(self.kind, t(self.p0), t(self.p1), t(self.c) if self.c else None, self.ccw)


@dataclass
class Loop:
    segs: list
    layer: str = ""
    circle: tuple | None = None   # (center, radius) jika lingkaran penuh
    depth: int = 0
    children: list = field(default_factory=list)

    def polygon(self):
        pts = [self.segs[0].p0]
        for s in self.segs:
            pts.extend(s.points())
        return pts

    def area(self):  # bertanda: + CCW, - CW
        p = self.polygon()
        return 0.5 * sum(p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1] for i in range(len(p) - 1))

    def bbox(self):
        p = self.polygon()
        xs, ys = [q[0] for q in p], [q[1] for q in p]
        return min(xs), min(ys), max(xs), max(ys)

    def reversed(self) -> "Loop":
        return Loop([s.reversed() for s in reversed(self.segs)], self.layer, self.circle, self.depth, self.children)


def point_in_poly(pt, poly):
    x, y = pt
    inside = False
    for i in range(len(poly) - 1):
        x1, y1 = poly[i]
        x2, y2 = poly[i + 1]
        if (y1 > y) != (y2 > y):
            if x1 + (y - y1) * (x2 - x1) / (y2 - y1) > x:
                inside = not inside
    return inside


# --------------------------------------------------------------------------
# Baca DWG / DXF
# --------------------------------------------------------------------------
def find_libredwg():
    names = ["dwg2dxf.exe", "dwg2dxf"] if os.name == "nt" else ["dwg2dxf"]
    for d in [os.path.join(HERE, "libredwg"), os.path.join(HERE, "..", "libredwg"), HERE]:
        for n in names:
            p = os.path.join(d, n)
            if os.path.isfile(p):
                return p
    return shutil.which("dwg2dxf")


def dwg_to_dxf(path: str, cfg: dict, tmpdir: str) -> str:
    out = os.path.join(tmpdir, "input.dxf")
    pref = cfg["converter"].lower()
    errors = []
    if pref in ("auto", "oda"):
        try:
            from ezdxf.addons import odafc
            if odafc.is_installed():
                odafc.convert(path, out, version="R2018", replace=True)
                return out
            errors.append("ODA File Converter tidak terpasang")
        except Exception as e:  # noqa: BLE001
            errors.append(f"ODA: {e}")
    if pref in ("auto", "libredwg"):
        exe = find_libredwg()
        if exe:
            r = subprocess.run([exe, "-y", "-o", out, path], capture_output=True, text=True)
            if os.path.isfile(out) and os.path.getsize(out) > 0:
                return out
            errors.append(f"LibreDWG gagal: {r.stderr.strip()[-300:]}")
        else:
            errors.append("dwg2dxf (LibreDWG) tidak ditemukan")
    raise RuntimeError("Tidak bisa membaca DWG (" + "; ".join(errors) +
                       "). Simpan ulang gambar sebagai DXF dari AutoCAD (SAVEAS > DXF) lalu ulangi.")


def layer_ok(layer: str, cfg: dict) -> bool:
    L = (layer or "0").upper()
    ignore = [p.strip().upper() for p in cfg["ignore_layers"].split(",") if p.strip()]
    if any(fnmatch.fnmatch(L, p) for p in ignore):
        return False
    only = [p.strip().upper() for p in cfg["cut_layers"].split(",") if p.strip()]
    return not only or any(fnmatch.fnmatch(L, p) for p in only)


def iter_primitives(entities, parent_layer=None, depth=0):
    """Pecah entitas menjadi LINE/ARC/CIRCLE/ELLIPSE/SPLINE, termasuk isi block."""
    for e in entities:
        t = e.dxftype()
        layer = e.dxf.get("layer", "0")
        if parent_layer and layer == "0":
            layer = parent_layer
        if t == "INSERT" and depth < 8:
            try:
                yield from iter_primitives(list(e.virtual_entities()), layer, depth + 1)
            except Exception:  # noqa: BLE001
                pass
        elif t in ("LWPOLYLINE", "POLYLINE"):
            if t == "POLYLINE" and not e.is_2d_polyline:
                continue
            try:
                for v in e.virtual_entities():
                    yield v, layer
            except Exception:  # noqa: BLE001
                pass
        elif t in ("LINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE"):
            yield e, layer


def entity_to_segs(e):
    """Return (list Seg, (center, r) jika lingkaran penuh)."""
    t = e.dxftype()
    xy = lambda v: (float(v[0]), float(v[1]))
    if t == "LINE":
        a, b = xy(e.dxf.start), xy(e.dxf.end)
        return ([Seg("L", a, b)] if dist(a, b) > 1e-6 else []), None
    if t in ("ARC", "CIRCLE"):
        flip = e.dxf.get("extrusion", (0, 0, 1))[2] < 0
        c = xy(e.ocs().to_wcs(e.dxf.center))
        r = float(e.dxf.radius)
        if t == "CIRCLE":
            p0, p1 = (c[0] + r, c[1]), (c[0] - r, c[1])
            return [Seg("A", p0, p1, c, True), Seg("A", p1, p0, c, True)], (c, r)
        a, b = xy(e.start_point), xy(e.end_point)
        if dist(a, b) < 1e-6:  # busur 360 derajat
            p1 = (2 * c[0] - a[0], 2 * c[1] - a[1])
            return [Seg("A", a, p1, c, not flip), Seg("A", p1, a, c, not flip)], (c, r)
        return [Seg("A", a, b, c, not flip)], None
    if t in ("ELLIPSE", "SPLINE"):
        pts = [xy(p) for p in e.flattening(0.05)]
        return [Seg("L", pts[i], pts[i + 1]) for i in range(len(pts) - 1) if dist(pts[i], pts[i + 1]) > 1e-6], None
    return [], None


def chain(segs, tol):
    """Sambungkan segmen lepas menjadi loop tertutup. Return (loops, jumlah_jalur_terbuka)."""
    cell = max(tol * 4, 1e-3)
    key = lambda p: (math.floor(p[0] / cell), math.floor(p[1] / cell))
    grid = {}
    for i, s in enumerate(segs):
        for end, p in ((0, s.p0), (1, s.p1)):
            grid.setdefault(key(p), []).append((i, end))
    used = [False] * len(segs)

    def find(p):
        kx, ky = key(p)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i, end in grid.get((kx + dx, ky + dy), []):
                    if used[i]:
                        continue
                    d = dist(p, segs[i].p0 if end == 0 else segs[i].p1)
                    if d <= tol and (best is None or d < best[2]):
                        best = (i, end, d)
        return best

    loops, open_count = [], 0
    for i in range(len(segs)):
        if used[i]:
            continue
        used[i] = True
        path, closed = [segs[i]], False
        start = path[0].p0
        while True:
            cur = path[-1].p1
            if dist(cur, start) <= tol and (len(path) > 1 or path[0].kind == "A"):
                closed = True
                break
            f = find(cur)
            if f is None:
                break
            j, end, _ = f
            used[j] = True
            s = segs[j] if end == 0 else segs[j].reversed()
            path.append(Seg(s.kind, cur, s.p1, s.c, s.ccw))  # rapatkan titik sambung
        if closed:
            last = path[-1]
            path[-1] = Seg(last.kind, last.p0, start, last.c, last.ccw)
            loops.append(Loop(path))
        else:
            open_count += 1
    return loops, open_count


def detect_circle(loop: Loop):
    if loop.circle:
        return loop.circle
    if not all(s.kind == "A" for s in loop.segs):
        return None
    c0, r0 = loop.segs[0].c, loop.segs[0].r
    if any(dist(s.c, c0) > 0.01 or abs(s.r - r0) > 0.01 for s in loop.segs):
        return None
    tot = sum(abs(s.sweep()) for s in loop.segs)
    return (c0, r0) if abs(tot - 2 * math.pi) < 1e-3 else None


def read_geometry(path: str, cfg: dict):
    tmpdir = tempfile.mkdtemp(prefix="dwg2cnc_")
    try:
        src = dwg_to_dxf(path, cfg, tmpdir) if path.lower().endswith(".dwg") else path
        try:
            doc = ezdxf.readfile(src)
        except Exception:  # noqa: BLE001
            doc, _ = recover.readfile(src)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    msp = doc.modelspace()

    texts = []
    for e in msp.query("TEXT MTEXT"):
        try:
            texts.append((e.plain_text() if e.dxftype() == "MTEXT" else e.dxf.text).strip())
        except Exception:  # noqa: BLE001
            pass

    tol = float(cfg["join_tolerance"])
    loops, by_layer, used_layers, skipped = [], {}, set(), set()
    for e, layer in iter_primitives(msp):
        if not layer_ok(layer, cfg):
            skipped.add(layer)
            continue
        segs, circ = entity_to_segs(e)
        if not segs:
            continue
        used_layers.add(layer)
        if circ:
            loops.append(Loop(segs, layer, circ))
        else:
            by_layer.setdefault(layer, []).extend(segs)
    # disambung per layer, supaya garis bantu tidak menempel ke kontur
    open_total = 0
    for layer, segs in by_layer.items():
        ls, oc = chain(segs, tol)
        for lp in ls:
            lp.layer = layer
            lp.circle = detect_circle(lp)
        loops.extend(ls)
        open_total += oc
    return dedupe(loops), open_total, [t for t in texts if t], sorted(used_layers), sorted(skipped)


def dedupe(loops):
    seen, out = set(), []
    for lp in loops:
        b = lp.bbox()
        k = tuple(round(v, 2) for v in b) + (round(abs(lp.area()), 1),)
        if k not in seen:
            seen.add(k)
            out.append(lp)
    return out


# --------------------------------------------------------------------------
# Susun part, urutan potong, lead-in
# --------------------------------------------------------------------------
def build_parts(loops):
    polys = [lp.polygon() for lp in loops]
    areas = [abs(lp.area()) for lp in loops]
    parent = [None] * len(loops)
    for i, lp in enumerate(loops):
        probe = lp.segs[0].midpoint()
        best = None
        for j in range(len(loops)):
            if i != j and areas[j] > areas[i] and point_in_poly(probe, polys[j]):
                if best is None or areas[j] < areas[best]:
                    best = j
        parent[i] = best
    for i in range(len(loops)):
        d, p = 0, parent[i]
        while p is not None:
            d, p = d + 1, parent[p]
        loops[i].depth = d
    parts = []
    for i, lp in enumerate(loops):
        if lp.depth % 2 == 0:
            lp.children = [loops[j] for j in range(len(loops)) if parent[j] == i]
            parts.append(lp)
    return parts


def orient(loop: Loop, want_ccw: bool) -> Loop:
    return loop if (loop.area() > 0) == want_ccw else loop.reversed()


def corner_start(loop: Loop, poly, cfg: dict, is_hole: bool = False):
    """Mulai potong di sudut (sudut terdekat dari titik nol torch).
    Lead-in masuk dari sisi scrap searah garis bagi sudut, jadi tidak ada takik di tengah sisi part.
    Kontur luar (CW): sudut part = belok kanan. Lubang (CCW): sudut lubang = belok kiri."""
    def tan_at(s: Seg, p):
        if s.kind == "L":
            d = (s.p1[0] - s.p0[0], s.p1[1] - s.p0[1])
        else:
            v = (p[0] - s.c[0], p[1] - s.c[1])
            d = (-v[1], v[0]) if s.ccw else (v[1], -v[0])
        m = math.hypot(*d) or 1.0
        return (d[0] / m, d[1] / m)

    n = len(loop.segs)
    sharp, smooth = None, None
    for k in range(n):
        a, b = loop.segs[k - 1], loop.segs[k]          # a berakhir di sudut, b mulai dari sudut
        v = b.p0
        ta, tb = tan_at(a, v), tan_at(b, v)
        d = math.hypot(v[0], v[1])                    # jarak ke titik nol torch
        if ta[0] * tb[0] + ta[1] * tb[1] > 0.996:     # belokan < ~5 derajat: bukan sudut tajam
            # sambungan garis-busur (ujung garis lurus) sebagai cadangan
            if (a.kind == "L") != (b.kind == "L") and (smooth is None or d < smooth[0] - 1e-6):
                smooth = (d, k, ta, tb)
            continue
        cross = ta[0] * tb[1] - ta[1] * tb[0]
        if (cross < 1e-6) if is_hole else (cross > -1e-6):
            continue                                  # sudut cekung: lead-in akan menabrak part
        if sharp is None or d < sharp[0] - 1e-6:
            sharp = (d, k, ta, tb)
    best = sharp or smooth
    if best is None:
        return None
    _, k, ta, tb = best
    v = loop.segs[k].p0
    na, nb = (-ta[1], ta[0]), (-tb[1], tb[0])         # normal kiri = sisi scrap
    bis = (na[0] + nb[0], na[1] + nb[1])
    L0 = math.hypot(*bis) or 1.0
    bis = (bis[0] / L0, bis[1] / L0)
    segs = loop.segs[k:] + loop.segs[:k]
    L = float(cfg["lead_in_hole"] if is_hole else cfg["lead_in_outer"])
    pierce = None
    while L >= 0.5:
        p = (v[0] + bis[0] * L, v[1] + bis[1] * L)
        if point_in_poly(p, poly) == is_hole:
            pierce = p
            break
        L /= 2
    if pierce is None:
        return None
    lead_out = float(cfg["lead_out"])
    lo = (v[0] + bis[0] * min(lead_out, L), v[1] + bis[1] * min(lead_out, L)) if lead_out > 0 else None
    return {"pierce": pierce, "segs": segs, "lead_out": lo}


def prepare_cut(loop: Loop, is_hole: bool, cfg: dict):
    """Kontur luar diputar CW, lubang CCW -> sisi kiri jalur = sisi scrap (cocok dengan G41)."""
    loop = orient(loop, want_ccw=is_hole)
    lead_out = float(cfg["lead_out"])

    if is_hole and loop.circle:
        c, r = loop.circle
        start = (c[0] - r, c[1])                      # mulai di sisi kiri lingkaran
        opp = (c[0] + r, c[1])
        segs = [Seg("A", start, opp, c, True), Seg("A", opp, start, c, True)]
        toward_c = lambda L: (start[0] + L, start[1])  # arah dari start menuju pusat
        if r <= float(cfg["center_pierce_max_radius"]):
            pierce = c
        else:
            pierce = toward_c(min(float(cfg["lead_in_hole"]) * 2, r * 0.6))
        lo = toward_c(min(lead_out, r * 0.5)) if lead_out > 0 else None
        return {"pierce": pierce, "segs": segs, "lead_out": lo}

    poly = loop.polygon()
    if cfg.get("start_point", "corner").lower() == "corner":
        c = corner_start(loop, poly, cfg, is_hole)
        if c:
            return c
    # titik start = tengah garis terpanjang (kalau tidak ada garis: busur terpanjang)
    k = min(range(len(loop.segs)), key=lambda i: (loop.segs[i].kind != "L", -loop.segs[i].length()))
    a, b = loop.segs[k].split_mid()
    segs = [b] + loop.segs[k + 1:] + loop.segs[:k] + [a]
    start = b.p0
    t = loop.segs[k].tangent_at_mid()
    nrm = (-t[1], t[0])  # normal kiri = sisi scrap
    L = float(cfg["lead_in_hole"] if is_hole else cfg["lead_in_outer"])
    pierce = start
    while L >= 0.5:
        p = (start[0] + nrm[0] * L, start[1] + nrm[1] * L)
        if point_in_poly(p, poly) == is_hole:
            pierce = p
            break
        L /= 2
    lo = None
    if lead_out > 0 and pierce != start:
        lo_len = min(lead_out, L)
        lo = (start[0] + nrm[0] * lo_len, start[1] + nrm[1] * lo_len)
    return {"pierce": pierce, "segs": segs, "lead_out": lo}


# --------------------------------------------------------------------------
# G-code
# --------------------------------------------------------------------------
class GWriter:
    def __init__(self, mode: str, decimals: int):
        self.mode = mode.upper()
        self.dec = decimals
        self.lines = []
        self.pos = (0.0, 0.0)          # posisi absolut, sudah dibulatkan (cegah drift G91)
        self.expected = []             # target absolut tiap gerakan, untuk verifikasi
        self.cut_len = self.rapid_len = 0.0
        self.pierces = 0

    def rnd(self, p):
        return (round(p[0], self.dec), round(p[1], self.dec))

    def f(self, v):
        v = round(v, self.dec)
        if abs(v) < 0.5 * 10 ** -self.dec:
            v = 0.0
        s = f"{v:.{self.dec}f}".rstrip("0")
        return s + "0" if s.endswith(".") else s

    def xy(self, p):
        p = self.rnd(p)
        if self.mode == "G91":
            return f"X{self.f(p[0] - self.pos[0])}Y{self.f(p[1] - self.pos[1])}", p
        return f"X{self.f(p[0])}Y{self.f(p[1])}", p

    def raw(self, s):
        self.lines.append(s)

    def move(self, code, p):
        if dist(self.rnd(p), self.pos) < 10 ** -self.dec:
            return
        w, p_r = self.xy(p)
        L = dist(self.pos, p_r)
        if code == "G00":
            self.rapid_len += L
        else:
            self.cut_len += L
        self.lines.append(f"{code}{w}")
        self.pos = p_r
        self.expected.append(p_r)

    def arc(self, s: Seg):
        if s.r > 1e5:
            return self.move("G01", s.p1)
        i, j = s.c[0] - self.pos[0], s.c[1] - self.pos[1]
        w, p_r = self.xy(s.p1)
        self.lines.append(f"{'G03' if s.ccw else 'G02'}{w}I{self.f(i)}J{self.f(j)}")
        self.cut_len += s.length()
        self.pos = p_r
        self.expected.append(p_r)


def generate(path: str, cfg: dict):
    loops, open_count, texts, layers_used, skipped_layers = read_geometry(path, cfg)
    if not loops:
        raise RuntimeError("Tidak ada kontur tertutup yang bisa dipotong. Cek layer dan pastikan garis tersambung.")

    parts = build_parts(loops)
    holes_mode = cfg["holes"].lower()
    min_hole = float(cfg["min_hole_diameter"])
    skipped_holes = 0

    all_b = [lp.bbox() for lp in parts]
    minx, miny = min(b[0] for b in all_b), min(b[1] for b in all_b)
    dx, dy = float(cfg["offset_x"]) - minx, float(cfg["offset_y"]) - miny

    def shift(lp: Loop) -> Loop:
        c = ((lp.circle[0][0] + dx, lp.circle[0][1] + dy), lp.circle[1]) if lp.circle else None
        return Loop([s.translated(dx, dy) for s in lp.segs], lp.layer, c, lp.depth)

    jobs = []
    for part in parts:
        holes = []
        for h in part.children:
            b = h.bbox()
            if holes_mode == "skip" or min(b[2] - b[0], b[3] - b[1]) < min_hole:
                skipped_holes += 1
                continue
            holes.append(prepare_cut(shift(h), True, cfg))
        jobs.append((holes, prepare_cut(shift(part), False, cfg), shift(part).bbox()))

    # urutan: part terdekat dulu; dalam part, lubang (tetangga terdekat) lalu kontur luar
    order, cur, remaining = [], (0.0, 0.0), list(range(len(jobs)))
    while remaining:
        k = min(remaining, key=lambda i: dist(cur, jobs[i][2][:2]))
        remaining.remove(k)
        holes, outer, _ = jobs[k]
        hs = list(holes)
        while hs:
            h = min(hs, key=lambda c: dist(cur, c["pierce"]))
            hs.remove(h)
            order.append(("hole", h))
            cur = h["pierce"]
        order.append(("outer", outer))
        cur = outer["pierce"]

    g = GWriter(cfg["mode"], int(cfg["decimals"]))
    name = os.path.splitext(os.path.basename(path))[0]
    if yes(cfg["header_comment"]):
        cm = f"{name} {' '.join(texts)[:40]}".upper()
        cm = "".join(ch for ch in cm if ch.isalnum() or ch in " -+_.,/")
        g.raw(f"({cm.strip()})")
    g.raw("G92X0Y0")
    g.raw("G21")
    g.raw(g.mode)
    use_kerf = cfg["kerf"].upper() == "G41"
    for _, c in order:
        g.move("G00", c["pierce"])
        if use_kerf:
            g.raw("G41")
        g.raw("M07")
        g.pierces += 1
        g.move("G01", c["segs"][0].p0)
        for s in c["segs"]:
            g.move("G01", s.p1) if s.kind == "L" else g.arc(s)
        if c["lead_out"]:
            g.move("G01", c["lead_out"])
        g.raw("M08")
        if use_kerf:
            g.raw("G40")
    if yes(cfg["return_home"]):
        g.move("G00", (0.0, 0.0))
    g.raw("M02")

    stats = {
        "name": name, "parts": len(parts), "holes": sum(1 for k, _ in order if k == "hole"),
        "skipped_holes": skipped_holes, "pierces": g.pierces, "cut_len": g.cut_len,
        "rapid_len": g.rapid_len, "lines": len(g.lines), "open_paths": open_count, "texts": texts,
        "layers": layers_used, "ignored_layers": skipped_layers,
        "size": (max(b[2] for b in all_b) - minx, max(b[3] for b in all_b) - miny),
    }
    return g, stats


# --------------------------------------------------------------------------
# Simulasi G-code (verifikasi + preview)
# --------------------------------------------------------------------------
def parse_words(line):
    words, i = {}, 0
    while i < len(line):
        ch = line[i].upper()
        if ch.isalpha():
            j = i + 1
            while j < len(line) and (line[j].isdigit() or line[j] in ".-+"):
                j += 1
            words.setdefault(ch, line[i + 1:j])
            i = j
        else:
            i += 1
    return words


def simulate(lines):
    """Baca G-code seperti mesin. Return (gerakan, error, posisi_akhir_tiap_gerakan)."""
    absolute, pos, cutting = False, (0.0, 0.0), False
    moves, errors, ends = [], [], []
    for n, raw in enumerate(lines, 1):
        line = raw.split("(")[0].strip()
        if not line:
            continue
        w = parse_words(line)
        code = None
        if "G" in w:
            gv = int(float(w["G"]))
            if gv in (90, 91):
                absolute = gv == 90
            elif gv == 92:
                pos = (0.0, 0.0)
            elif gv in (0, 1, 2, 3):
                code = gv
        if "M" in w:
            mv = int(float(w["M"]))
            cutting = True if mv == 7 else False if mv == 8 else cutting
        if code is None:
            continue
        x, y = float(w.get("X", 0)), float(w.get("Y", 0))
        p1 = (x, y) if absolute else (pos[0] + x, pos[1] + y)
        c = None
        if code in (2, 3):
            c = (pos[0] + float(w.get("I", 0)), pos[1] + float(w.get("J", 0)))
            if abs(dist(pos, c) - dist(p1, c)) > 0.01:
                errors.append(f"baris {n}: radius busur tidak konsisten")
        if code != 0 and not cutting:
            errors.append(f"baris {n}: gerak potong saat torch mati")
        if code == 0 and cutting:
            errors.append(f"baris {n}: gerak cepat saat torch menyala")
        moves.append((code, pos, p1, c))
        pos = p1
        ends.append(p1)
    return moves, errors, ends


def verify(g: GWriter):
    moves, errors, ends = simulate(g.lines)
    if len(ends) != len(g.expected):
        errors.append(f"jumlah gerakan {len(ends)} != {len(g.expected)}")
    else:
        worst = max((dist(a, b) for a, b in zip(ends, g.expected)), default=0)
        if worst > 0.002:
            errors.append(f"posisi simulasi menyimpang {worst:.4f} mm")
    return moves, errors


def preview(moves, stats, out_png, cfg):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return False
    fig, ax = plt.subplots(figsize=(11, 8.5), dpi=120)
    n = 0
    for idx, (code, p0, p1, c) in enumerate(moves):
        if code == 0:
            ax.plot([p0[0], p1[0]], [p0[1], p1[1]], color="#a8a8a8", lw=0.5, ls=(0, (3, 3)), zorder=1)
            if idx + 1 < len(moves) and moves[idx + 1][0] != 0:
                n += 1
                ax.plot(*p1, "o", color="#d62728", ms=2.2, zorder=3)
                ax.annotate(str(n), p1, fontsize=5, color="#d62728", xytext=(2, 2),
                            textcoords="offset points", zorder=4)
            continue
        pts = [p0, p1] if code == 1 else [p0] + Seg("A", p0, p1, c, code == 3).points(3)
        ax.plot([p[0] for p in pts], [p[1] for p in pts], color="#1f5fbf", lw=1.0, zorder=2)
    ax.plot(0, 0, marker="+", color="black", ms=12, mew=1.5)
    ax.annotate("titik nol torch", (0, 0), fontsize=7, xytext=(5, -11), textcoords="offset points")
    ax.set_aspect("equal")
    ax.grid(True, lw=0.3, alpha=0.5)
    sp = float(cfg["cut_speed"])
    t = stats["cut_len"] / sp if sp > 0 else 0
    ax.set_title(
        f"{stats['name']}   {stats['size'][0]:.0f} x {stats['size'][1]:.0f} mm   |   "
        f"{stats['holes']} lubang, {stats['pierces']} titik tembus   |   panjang potong "
        f"{stats['cut_len'] / 1000:.2f} m (~{t:.0f} menit @ {sp:.0f} mm/mnt, belum termasuk preheat)",
        fontsize=9)
    ax.set_xlabel("X (mm)    biru = potong, abu putus-putus = gerak cepat, merah = titik tembus + urutan")
    ax.set_ylabel("Y (mm)")
    fig.tight_layout()
    fig.savefig(out_png)
    plt.close(fig)
    return True


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def convert(path, cfg, outdir=None):
    g, st = generate(path, cfg)
    moves, errors = verify(g)
    outdir = outdir or os.path.dirname(os.path.abspath(path))
    os.makedirs(outdir, exist_ok=True)
    ext = cfg["ext"] if cfg["ext"].startswith(".") else "." + cfg["ext"]
    out = os.path.join(outdir, st["name"] + ext)
    data = "\r\n".join(g.lines) + "\r\n"
    with open(out, "w", encoding="ascii", errors="replace", newline="") as fh:
        fh.write(data)
    png = os.path.join(outdir, st["name"] + "_preview.png") if yes(cfg["preview"]) else None
    if png and not preview(moves, st, png, cfg):
        png = None
    kb = len(data) / 1024
    print(f"\n[{st['name']}]")
    print(f"  Layer dipakai   : {', '.join(st['layers'])}"
          + (f"   (diabaikan: {', '.join(st['ignored_layers'])})" if st["ignored_layers"] else ""))
    if st["texts"]:
        print(f"  Teks di gambar  : {' | '.join(st['texts'])}")
    print(f"  Ukuran          : {st['size'][0]:.1f} x {st['size'][1]:.1f} mm, {st['parts']} part")
    print(f"  Lubang dipotong : {st['holes']}" + (f"  (dilewati {st['skipped_holes']})" if st["skipped_holes"] else ""))
    print(f"  Panjang potong  : {st['cut_len'] / 1000:.2f} m, gerak cepat {st['rapid_len'] / 1000:.2f} m, "
          f"{st['pierces']} kali tembus")
    if st["open_paths"]:
        print(f"  Info            : {st['open_paths']} garis terbuka diabaikan (tanda center / garis bantu)")
    print(f"  Output          : {out}  ({st['lines']} baris, {kb:.1f} KB)")
    if png:
        print(f"  Preview         : {png}")
    if st["lines"] > 10000 or kb > 1024:
        print("  PERINGATAN      : melebihi 10.000 baris / 1 MB (batas manual F2100B). Pecah gambarnya.")
    print("  Cek simulasi    : " + ("GAGAL - " + "; ".join(errors[:5]) if errors else "OK"))
    return out, errors


def main(argv=None):
    ap = argparse.ArgumentParser(description="DWG/DXF -> G-code untuk FLSK F2100B")
    ap.add_argument("inputs", nargs="+", help="file .dwg/.dxf atau folder")
    ap.add_argument("-o", "--outdir", help="folder output (default: sama dengan gambar)")
    ap.add_argument("--config", help="file pengaturan (default: dwg2cnc.ini di samping script)")
    for k in DEFAULTS:
        ap.add_argument("--" + k.replace("_", "-"), dest=k, help=f"default: {DEFAULTS[k]}")
    a = ap.parse_args(argv)
    cfg = load_config(a.config)
    for k in DEFAULTS:
        if getattr(a, k) is not None:
            cfg[k] = getattr(a, k)

    files = []
    for p in a.inputs:
        if os.path.isdir(p):
            files += [os.path.join(p, f) for f in sorted(os.listdir(p)) if f.lower().endswith((".dwg", ".dxf"))]
        else:
            files.append(p)
    ok = bad = 0
    for f in files:
        try:
            _, errs = convert(f, cfg, a.outdir)
            ok, bad = (ok + 1, bad) if not errs else (ok, bad + 1)
        except Exception as e:  # noqa: BLE001
            bad += 1
            print(f"\n[{os.path.basename(f)}] GAGAL: {e}")
    print(f"\nSelesai: {ok} berhasil, {bad} bermasalah.")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
