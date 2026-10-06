"""Human Counter — sistem pencatatan orang melewati CCTV (full stack).

Arsitektur
----------
[GEV CCTV :4173] ──stream HLS──>  [Human Counter :5103]  <── deteksi + pelacak IoU di peramban
                                      ├─ SQLite: events (kunci unik + anti-duplikat bbox)
                                      ├─ API: /api/events, /api/stats, /api/cameras
                                      ├─ proxy /api/stream/:id → HLS GEV (same-origin)
                                      └─ static/ : dashboard (TANPA peta — hanya CCTV)

ATURAN ANTI-DUPLIKASI (dua lapis)
---------------------------------
1. event_key unik: "kamera:nomor-jejak:sesi" — INSERT OR IGNORE membuat
   pengiriman ulang klien tidak pernah menduplikasi baris.
2. Anti-duplikat lintas sesi/reload: event baru dibandingkan dengan bbox
   event terakhir per kamera (10 menit terakhir) — IoU tinggi + jarak waktu
   pendek dianggap ORANG YANG SAMA: baris lama diperpanjang, bukan baris baru.

Semantik hitungan: satu ORANG yang berdiri di depan kamera = SATU catatan
selama ia terlihat (jejak hidup). Ia meninggalkan kamera lalu kembali
setelah jeda lebih dari REENTRY_COOLDOWN_S dihitung sebagai LEWATAN baru —
itulah yang dimaksud "melewati kamera".
"""

import json
import os
import sqlite3
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = BASE_DIR / "counter.db"

HOST = "127.0.0.1"
PORT = 5103
GEV_BASE = os.environ.get("GEV_BASE", "http://localhost:4173").rstrip("/")
CAMERA_CACHE_TTL_S = 300.0
REENTRY_COOLDOWN_S = 600.0  # 10 menit
DEDUP_IOU = 0.5

_db_lock = threading.RLock()
_camera_cache = {"at": 0.0, "sources": []}

DB = sqlite3.connect(DB_PATH, check_same_thread=False)
DB.row_factory = sqlite3.Row
DB.executescript(
    """
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      camera_id TEXT NOT NULL,
      camera_name TEXT DEFAULT '',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      frames INTEGER NOT NULL DEFAULT 1,
      max_conf REAL,
      bbox_first TEXT,
      bbox_last TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_camera ON events(camera_id);
    CREATE INDEX IF NOT EXISTS idx_events_first ON events(first_seen);
    """
)
DB.commit()

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def list_cameras():
    now = time.time()
    if now - _camera_cache["at"] > CAMERA_CACHE_TTL_S or not _camera_cache["sources"]:
        try:
            with urllib.request.urlopen(f"{GEV_BASE}/api/cctv/sources", timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            _camera_cache["sources"] = payload.get("sources", [])
            _camera_cache["at"] = now
        except Exception:
            pass
    return _camera_cache["sources"]


def iou(a, b):
    """IoU dua kotak [x1,y1,x2,y2] — ukuran tumpang-tindih 0..1."""
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def find_duplicate(camera_id, bbox, now):
    """Cari event kamera yang sama pada 10 menit terakhir dengan tumpang-
    tindih kotak tinggi → ORANG YANG SAMA (anti-duplikat lintas reload)."""
    cutoff = datetime.fromtimestamp(now - REENTRY_COOLDOWN_S, timezone.utc).isoformat(
        timespec="seconds"
    )
    rows = DB.execute(
        "SELECT id, camera_id, bbox_last, last_seen FROM events"
        " WHERE camera_id = ? AND last_seen >= ? ORDER BY last_seen DESC LIMIT 40",
        (camera_id, cutoff),
    ).fetchall()
    for row in rows:
        try:
            last_box = json.loads(row["bbox_last"] or "null")
        except json.JSONDecodeError:
            continue
        if last_box and bbox and iou(last_box, bbox) >= DEDUP_IOU:
            return row["id"]
    return None


class CounterHandler(BaseHTTPRequestHandler):
    server_version = "HumanCounter/1.0"

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, rel_path):
        target = (STATIC_DIR / rel_path).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            self._send_json(404, {"error": "not found"})
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(target.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def log_message(self, fmt, *args):
        pass

    # -- GET -----------------------------------------------------------------

    def do_GET(self):
        path = urlsplit(self.path).path
        try:
            if path in ("/", "/index.html"):
                self._send_static("index.html")
                return
            if path.startswith("/static/"):
                self._send_static(path[len("/static/"):])
                return
            if path == "/api/health":
                self._send_json(200, {"ok": True, "gevBase": GEV_BASE})
                return
            if path == "/api/cameras":
                cameras = [
                    {
                        "id": s["id"],
                        "name": s["name"],
                        "city": s["city"],
                        "streamUrl": f"/api/stream/{s['id']}",
                    }
                    for s in list_cameras()
                ]
                self._send_json(200, {"cameras": cameras})
                return
            if path.startswith("/api/stream/"):
                # Proxy HLS GEV → same-origin. Playlist ditulis-ulang: URI di
                # dalamnya menunjuk /api/cctv/media/ milik GEV — diganti ke
                # /api/media/ milik server ini (rute proxy di bawah), karena
                # hls.js menyelesaikan URL relatif terhadap origin halaman.
                camera_id = path.split("/api/stream/")[-1]
                upstream = f"{GEV_BASE}/api/cctv/media/{camera_id}"
                try:
                    with urllib.request.urlopen(upstream, timeout=30) as resp:
                        body = resp.read()
                        content_type = resp.headers.get("Content-Type", "application/octet-stream")
                        if "mpegurl" in content_type:
                            body = body.replace(
                                b"/api/cctv/media/", b"/api/media/"
                            )
                        self.send_response(resp.status)
                        self.send_header("Content-Type", content_type)
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        self.wfile.write(body)
                except Exception as exc:
                    self._send_json(502, {"error": str(exc)[:120]})
                return
            if path.startswith("/api/media/"):
                # Proxy segmen/playlist lanjutan HLS (URI hasil penulisan-ulang).
                # Sub-playlist juga ditulis-ulang: URI segmennya menunjuk
                # /api/cctv/media/ milik GEV — harus diarahkan ke proxy ini.
                rest = path.split("/api/media/")[-1]
                upstream = f"{GEV_BASE}/api/cctv/media/{rest}"
                if urlsplit(self.path).query:
                    upstream += "?" + urlsplit(self.path).query
                try:
                    with urllib.request.urlopen(upstream, timeout=30) as resp:
                        body = resp.read()
                        content_type = resp.headers.get("Content-Type", "application/octet-stream")
                        if "mpegurl" in content_type:
                            body = body.replace(
                                b"/api/cctv/media/", b"/api/media/"
                            )
                        self.send_response(resp.status)
                        self.send_header("Content-Type", content_type)
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        self.wfile.write(body)
                except Exception as exc:
                    self._send_json(502, {"error": str(exc)[:120]})
                return
            if path == "/api/stats":
                with _db_lock:
                    total = DB.execute("SELECT COUNT(*) c FROM events").fetchone()["c"]
                    today = DB.execute(
                        "SELECT COUNT(*) c FROM events WHERE first_seen >= date('now','localtime')\n                         OR first_seen >= ?",
                        (datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="seconds"),),
                    ).fetchone()["c"]
                    hour_ago = datetime.fromtimestamp(time.time() - 3600, timezone.utc).isoformat(timespec="seconds")
                    last_hour = DB.execute(
                        "SELECT COUNT(*) c FROM events WHERE first_seen >= ?", (hour_ago,)
                    ).fetchone()["c"]
                    per_camera = [
                        dict(r)
                        for r in DB.execute(
                            "SELECT camera_id, camera_name, COUNT(*) count FROM events"
                            " GROUP BY camera_id ORDER BY count DESC"
                        ).fetchall()
                    ]
                    per_minute = [
                        dict(r)
                        for r in DB.execute(
                            "SELECT strftime('%Y-%m-%dT%H:%M:00', first_seen) minute, COUNT(*) count"
                            " FROM events WHERE first_seen >= ?"
                            " GROUP BY minute ORDER BY minute",
                            (datetime.fromtimestamp(time.time() - 1800, timezone.utc).isoformat(timespec="seconds"),),
                        ).fetchall()
                    ]
                self._send_json(
                    200,
                    {
                        "total": total,
                        "today": today,
                        "lastHour": last_hour,
                        "perCamera": per_camera,
                        "perMinute": per_minute,
                        "serverTime": now_iso(),
                    },
                )
                return
            if path == "/api/events":
                limit = 40
                with _db_lock:
                    rows = DB.execute(
                        "SELECT * FROM events ORDER BY first_seen DESC, id DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
                self._send_json(
                    200,
                    {
                        "events": [
                            {
                                "id": r["id"],
                                "cameraId": r["camera_id"],
                                "cameraName": r["camera_name"],
                                "firstSeen": r["first_seen"],
                                "lastSeen": r["last_seen"],
                                "frames": r["frames"],
                                "maxConf": r["max_conf"],
                            }
                            for r in rows
                        ]
                    },
                )
                return
            self._send_json(404, {"error": "not found"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)[:200]})

    # -- POST ----------------------------------------------------------------

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            if path == "/api/events":
                body = self._read_json_body()
                event_key = str(body.get("eventKey") or "").strip()
                camera_id = str(body.get("cameraId") or "").strip()
                bbox = body.get("bbox") or []
                if not event_key or not camera_id:
                    self._send_json(400, {"error": "eventKey & cameraId wajib"})
                    return
                cameras = {c["id"]: c for c in list_cameras()}
                camera_name = cameras.get(camera_id, {}).get("name", camera_id)
                now = time.time()
                bbox_json = json.dumps(bbox) if bbox else None
                conf = body.get("conf")
                with _db_lock:
                    # Lapis 1: event_key unik (kirim ulang klien).
                    existing = DB.execute(
                        "SELECT id FROM events WHERE event_key = ?", (event_key,)
                    ).fetchone()
                    if existing:
                        DB.execute(
                            "UPDATE events SET last_seen = ?, frames = frames + 1,"
                            " max_conf = MAX(COALESCE(max_conf,0), COALESCE(?,0))"
                            " WHERE id = ?",
                            (now_iso(), conf, existing["id"]),
                        )
                        DB.commit()
                        self._send_json(200, {"ok": True, "id": existing["id"], "duplicate": "key"})
                        return
                    # Lapis 2: orang yang sama (IoU bbox) di kamera sama dekat
                    # waktu sama → perpanjang catatan lama, jangan buat baru.
                    dup_id = find_duplicate(camera_id, bbox, now)
                    if dup_id:
                        DB.execute(
                            "UPDATE events SET last_seen = ?, frames = frames + 1,"
                            " max_conf = MAX(COALESCE(max_conf,0), COALESCE(?,0))"
                            " WHERE id = ?",
                            (now_iso(), conf, dup_id),
                        )
                        DB.commit()
                        self._send_json(200, {"ok": True, "id": dup_id, "duplicate": "person"})
                        return
                    cursor = DB.execute(
                        "INSERT INTO events (event_key, camera_id, camera_name,"
                        " first_seen, last_seen, frames, max_conf, bbox_first, bbox_last)"
                        " VALUES (?,?,?,?,?,?,?,?,?)",
                        (
                            event_key,
                            camera_id,
                            camera_name,
                            now_iso(),
                            now_iso(),
                            1,
                            conf,
                            bbox_json,
                            bbox_json,
                        ),
                    )
                    DB.commit()
                    self._send_json(200, {"ok": True, "id": cursor.lastrowid, "registered": True})
                return
            if path == "/api/events/heartbeat":
                body = self._read_json_body()
                event_key = str(body.get("eventKey") or "").strip()
                if not event_key:
                    self._send_json(400, {"error": "eventKey wajib"})
                    return
                with _db_lock:
                    DB.execute(
                        "UPDATE events SET last_seen = ?, frames = frames + 1"
                        " WHERE event_key = ?",
                        (now_iso(), event_key),
                    )
                    DB.commit()
                self._send_json(200, {"ok": True})
                return
            self._send_json(404, {"error": "not found"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)[:200]})


if __name__ == "__main__":
    print(f"Human Counter listening on http://{HOST}:{PORT} (GEV: {GEV_BASE})")
    ThreadingHTTPServer((HOST, PORT), CounterHandler).serve_forever()
