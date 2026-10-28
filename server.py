#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Server lokal NC1 Auto Nesting: melayani folder web/ dan endpoint ekspor.

    python server.py            -> http://127.0.0.1:8768/nest.html

POST /api/export  body JSON {"name", "files": [{"file": "PLAT01A.TXT", "text", "dwg": layout (lihat dwgwrite.py)}], "report"}
  -> ZIP berisi per file G-code: PLAT01A.TXT + PLAT01A.dwg + PLAT01A.dxf (part yang sama, koordinat sama), LAPORAN.txt.
  Tiap DWG dibaca balik & dicocokkan dengan layout-nya. Gagal -> HTTP 422 {"error": "..."}; tidak ada ZIP setengah jadi.
"""
import io
import json
import os
import re
import sys
import tempfile
import threading
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import dwgwrite

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
PORT = int(os.environ.get("NEST_PORT", "8768"))
HOST = os.environ.get("NEST_HOST", "127.0.0.1")   # VPS: 0.0.0.0 (atau tetap lokal di balik reverse proxy)
MAX_BODY = 64 * 1024 * 1024
DWG_LOCK = threading.Lock()   # satu konversi AutoCAD sekaligus
SAFE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")


def build_zip(req):
    name = req.get("name") or "NESTING"
    if not SAFE.match(name):
        raise ValueError(f"nama file tidak valid: {name!r}")
    files = req.get("files", [])
    if not files:
        raise ValueError("tidak ada file G-code")
    for f in files:
        if not SAFE.match(f.get("file", "")):
            raise ValueError(f"nama file G-code tidak valid: {f.get('file')!r}")
        if not (f.get("dwg") or {}).get("plates"):
            raise ValueError(f"{f['file']}: layout DWG kosong")
    with tempfile.TemporaryDirectory() as td:
        conv = None
        with DWG_LOCK:
            for f in files:
                stem = os.path.splitext(f["file"])[0]
                dwg = os.path.join(td, stem + ".dwg")
                _, conv = dwgwrite.write_dwg(dwg, f["dwg"])
                errs = dwgwrite.verify(dwg, f["dwg"])
                if errs:
                    raise ValueError(f"{stem}.dwg tidak cocok dengan layout: " + "; ".join(errs))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for f in files:
                stem = os.path.splitext(f["file"])[0]
                z.writestr(f["file"], f["text"].encode("ascii", "replace"))
                z.write(os.path.join(td, stem + ".dwg"), stem + ".dwg")
                z.write(os.path.join(td, stem + ".dxf"), stem + ".dxf")
            if req.get("report"):
                z.writestr("LAPORAN.txt", (req["report"] + f"DWG disimpan oleh {conv} (format AutoCAD 2018).\r\n").encode("utf-8"))
        return name, conv, buf.getvalue()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")   # selalu versi terbaru setelah update
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/export":
            return self._json(404, {"error": "tidak ada"})
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_BODY:
            return self._json(413, {"error": "ukuran request tidak valid"})
        try:
            name, conv, data = build_zip(json.loads(self.rfile.read(n)))
        except Exception as e:  # noqa: BLE001 - semua kegagalan ekspor dilaporkan ke UI
            return self._json(422, {"error": str(e)})
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f'attachment; filename="{name}.zip"')
        self.send_header("X-Dwg-Converter", conv)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"NC1 Auto Nesting berjalan di http://{HOST}:{PORT}/nest.html  (tutup jendela ini untuk berhenti)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
