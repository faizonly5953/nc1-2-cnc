#!/usr/bin/env bash
# NC1 Auto Nesting - launcher Linux (juga jalan di Git Bash Windows). Padanan BUKA-NESTING.bat.
set -euo pipefail
cd "$(dirname "$0")"

PY=""
for c in python3 python py; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python belum terpasang (mis. sudo apt install python3 python3-pip)." >&2
  exit 1
fi

if ! "$PY" -c "import ezdxf" >/dev/null 2>&1; then
  echo "Memasang modul ezdxf dan matplotlib (sekali saja, butuh internet)..."
  "$PY" -m pip install --user ezdxf matplotlib
fi

URL="http://127.0.0.1:${NEST_PORT:-8768}/nest.html"
( sleep 1
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  elif command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$URL"
  fi >/dev/null 2>&1 || true ) &

exec "$PY" server.py
