#!/usr/bin/env bash
# Auto-update + server untuk VPS Linux.
# Menjalankan server.py, lalu berkala mengecek GitHub. Kalau ada commit baru di branch:
#   git pull (fast-forward) -> restart server -> cek server hidup; gagal = kembali ke commit lama.
# Jadwal cek: jam kerja (Senin-Jumat 08:00-17:00) tiap 5 menit, di luar itu tiap 1 jam.
#
#   deploy/update.sh            jalan terus (pakai systemd, lihat deploy/nc1-nesting.service)
#   deploy/update.sh --once     satu kali cek + update, lalu keluar (tanpa mengelola server)
#   deploy/update.sh --schedule tampilkan jeda cek berikutnya (tes jadwal; waktu bisa diatur lewat NOW=...)
set -uo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
export TZ="${TZ:-Asia/Jakarta}"
WORK_DAYS="${WORK_DAYS:-1-5}"        # 1 = Senin ... 7 = Minggu
WORK_START="${WORK_START:-8}"        # jam mulai (inklusif)
WORK_END="${WORK_END:-17}"           # jam selesai (eksklusif)
FAST="${FAST:-300}"                  # detik, jam kerja
SLOW="${SLOW:-3600}"                 # detik, di luar jam kerja
export NEST_HOST="${NEST_HOST:-0.0.0.0}"
export NEST_PORT="${NEST_PORT:-8768}"
PY="${PY:-$(command -v python3 || command -v python)}"
SERVER_PID=""
BAD_COMMIT=""                        # commit yang gagal start: tidak dicoba lagi sampai ada commit lebih baru

log() { echo "$(date '+%F %T') $*"; }

now_epoch() { if [ -n "${NOW:-}" ]; then date -d "$NOW" +%s; else date +%s; fi; }

is_work_day() {   # $1 = hari 1..7
  local lo=${WORK_DAYS%-*} hi=${WORK_DAYS#*-}
  [ "$1" -ge "$lo" ] && [ "$1" -le "$hi" ]
}

# Detik sampai cek berikutnya. Di luar jam kerja tetap bangun tepat saat jam kerja mulai.
next_sleep() {
  local t dow hour
  t=$(now_epoch); dow=$(date -d "@$t" +%u); hour=$((10#$(date -d "@$t" +%H)))
  if is_work_day "$dow" && [ "$hour" -ge "$WORK_START" ] && [ "$hour" -lt "$WORK_END" ]; then
    echo "$FAST"; return
  fi
  local best=$SLOW d s
  for d in 0 1 2 3 4 5 6 7; do   # awal jam kerja berikutnya
    s=$(date -d "$(date -d "@$t" +%F) +$d day $WORK_START:00" +%s)
    if [ "$s" -gt "$t" ] && is_work_day "$(date -d "@$s" +%u)"; then
      [ $((s - t)) -lt "$best" ] && best=$((s - t))
      break
    fi
  done
  echo "$best"
}

healthy() {
  local url="http://127.0.0.1:$NEST_PORT/nest.html" i
  for i in $(seq 1 20); do
    if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then return 1; fi   # server sudah crash
    if "$PY" -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('$url', timeout=3).status == 200 else 1)" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_server() {
  ( cd "$REPO_DIR" && exec "$PY" server.py ) &
  SERVER_PID=$!
  log "server jalan (pid $SERVER_PID) di $NEST_HOST:$NEST_PORT, commit $(git -C "$REPO_DIR" rev-parse --short HEAD)"
}

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  SERVER_PID=""
}

ensure_deps() {
  "$PY" -c "import ezdxf" 2>/dev/null || "$PY" -m pip install --user -q ezdxf matplotlib
}

# Return 0 kalau ada update yang dipasang.
check_update() {
  local manage=$1 old new
  if ! git -C "$REPO_DIR" fetch -q "$REMOTE" "$BRANCH"; then
    log "gagal fetch $REMOTE/$BRANCH (jaringan?), coba lagi nanti"; return 1
  fi
  old=$(git -C "$REPO_DIR" rev-parse HEAD)
  new=$(git -C "$REPO_DIR" rev-parse "$REMOTE/$BRANCH")
  if [ "$old" = "$new" ]; then log "tidak ada update ($(git -C "$REPO_DIR" rev-parse --short HEAD))"; return 1; fi
  if [ "$new" = "$BAD_COMMIT" ]; then log "commit ${new:0:7} pernah gagal, dilewati sampai ada commit baru"; return 1; fi
  log "commit baru: ${old:0:7} -> ${new:0:7} ($(git -C "$REPO_DIR" log -1 --format=%s "$new"))"
  if ! git -C "$REPO_DIR" merge -q --ff-only "$new"; then
    log "ERROR: tidak bisa fast-forward (ada perubahan lokal di VPS?). Update dilewati."; return 1
  fi
  ensure_deps
  [ "$manage" = 1 ] || return 0
  stop_server; start_server
  if healthy; then log "update OK, server hidup"; return 0; fi
  log "ERROR: server tidak hidup setelah update, kembali ke ${old:0:7}"
  BAD_COMMIT=$new
  git -C "$REPO_DIR" reset -q --hard "$old"
  stop_server; start_server
  healthy && log "rollback OK" || log "ERROR: server tetap mati setelah rollback"
  return 1
}

case "${1:-}" in
  --schedule) next_sleep; exit 0 ;;
  --once) check_update 0; exit 0 ;;
esac

trap 'stop_server; exit 0' INT TERM
ensure_deps
start_server
healthy || log "PERINGATAN: server belum menjawab di port $NEST_PORT"
while true; do
  check_update 1
  if [ -n "$SERVER_PID" ] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    log "server mati, dijalankan ulang"; start_server
  fi
  s=$(next_sleep)
  log "cek berikutnya dalam $((s / 60)) menit"
  sleep "$s" & wait $!   # wait: supaya sinyal stop dari systemd langsung diproses
done
