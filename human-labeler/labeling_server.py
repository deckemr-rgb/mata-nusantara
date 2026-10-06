"""Human Labeler — alat pelabelan data manusia full-stack untuk God's Eye View.

Arsitektur
----------
[GEV CCTV proxy :4173]  --/api/cctv/detect/:id-->  [detector YOLOv8 :5101]
        |                                              (buka HLS via FFmpeg)
        |  frame bersih + pre-label kotak orang (JSON, base64)
        v
[Human Labeler :5102]  <-- aplikasi pelabelan ini
  - Backend  : API + SQLite (samples, boxes) + ekspor YOLO/COCO (stdlib saja)
  - Frontend : editor kotak bounding berbasis canvas (static/index.html)

Alur kerja pelabelan:
  1. CAPTURE  — ambil bingkai kamera CCTV terpilih; YOLOv8 memberi pre-label.
     Sampel tersimpan berstatus 'pending'.
  2. EDIT     — operator mengoreksi kotak (geser, ubah ukuran, hapus, tambah,
     ganti kelas) di editor canvas.
  3. SAVE     — kotak final disimpan, sampel berstatus 'approved'.
  4. EXPORT   — unduh dataset YOLO (images/ + labels/ + classes.txt) atau COCO
     JSON untuk pelatihan ulang model.

Layanan hanya mendengarkan di 127.0.0.1.
"""

import base64
import io
import json
import os
import sqlite3
import threading
import time
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request as urlrequest

BASE_DIR = Path(__file__).resolve().parent
DATASET_DIR = BASE_DIR / "dataset"
IMAGES_DIR = DATASET_DIR / "images"
STATIC_DIR = BASE_DIR / "static"
DB_PATH = DATASET_DIR / "labels.db"

HOST = "127.0.0.1"
PORT = 5102
GEV_BASE = os.environ.get("GEV_BASE", "http://localhost:4173").rstrip("/")
GEV_TIMEOUT_S = 60.0  # capture HLS butuh waktu (buka stream + ambil bingkai)
CAMERA_CACHE_TTL_S = 300.0

# RLock (re-entrant): handler /api/capture membungkus store_capture_sample
# yang juga mengunci sendiri — Lock biasa akan deadlock di sini.
_db_lock = threading.RLock()
_camera_cache = {"at": 0.0, "sources": []}

for _dir in (IMAGES_DIR,):
    _dir.mkdir(parents=True, exist_ok=True)


def _load_env_file():
    """Baca .env di samping server (KEY=VALUE per baris) — kunci API tetap
    server-side, tidak pernah dikirim ke peramban."""
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_env_file()


# ---------------------------------------------------------------------------
# Kolektor berkelanjutan (continuous collector)
# ---------------------------------------------------------------------------

class Collector:
    """Pengumpul data otomatis: berputar (round-robin) di antara kamera CCTV,
    mengambil bingkai aktual lewat proxy GEV + detektor YOLOv8, dan menyimpan
    sampel pending secara berkelanjutan.

    Menghormati: jeda antar capture, jeda minimal per kamera (hindari bingkai
    kembar), batas sampel pending, dan filter kota. Kamera yang sepi (di bawah
    minPersons) dilewati supaya dataset memang berisi orang.
    """

    def __init__(self):
        self.running = False
        self.thread = None
        self.status = "idle"
        self.config = {
            "intervalS": 8,
            "minPersons": 1,
            "maxPending": 300,
            "minCameraGapS": 120,
            "cityId": "",
        }
        self.stats = {
            "captured": 0,
            "skippedEmpty": 0,
            "aiFiltered": 0,
            "aiApproved": 0,
            "aiPending": 0,
            "aiErrors": 0,
            "errors": 0,
            "lastError": "",
            "lastCamera": "",
            "lastSampleId": None,
            "lastDecision": None,
            "startedAt": None,
        }
        self.camera_history = {}
        self._last_capture_by_camera = {}
        self._stop_event = threading.Event()

    def start(self, config_patch):
        if self.running:
            self.configure(config_patch)
            return False
        self.configure(config_patch)
        self.running = True
        self.status = "running"
        self.stats["startedAt"] = datetime.now(timezone.utc).isoformat()
        self._stop_event.clear()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        return True

    def stop(self):
        was_running = self.running
        self.running = False
        self.status = "stopped"
        self._stop_event.set()
        return was_running

    def configure(self, patch):
        for key in ("intervalS", "minPersons", "maxPending", "minCameraGapS"):
            if key in patch:
                try:
                    self.config[key] = max(0, int(patch[key]))
                except (TypeError, ValueError):
                    pass
        if "cityId" in patch:
            self.config["cityId"] = str(patch["cityId"] or "")

    def snapshot(self):
        pending = 0
        with _db_lock:
            pending = DB.execute(
                "SELECT COUNT(*) c FROM samples WHERE status='pending'"
            ).fetchone()["c"]
        uptime = None
        if self.stats["startedAt"] and self.running:
            started = datetime.fromisoformat(self.stats["startedAt"])
            uptime = round((datetime.now(timezone.utc) - started).total_seconds())
        return {
            "running": self.running,
            "status": self.status,
            "config": self.config,
            "aiEnabled": bool(typesafe_api_key()),
            "lastDecision": self.stats.get("lastDecision"),
            "stats": {**self.stats, "pending": pending, "uptimeS": uptime},
        }

    # -- loop utama --------------------------------------------------------

    def _loop(self):
        index = 0
        while self.running and not self._stop_event.is_set():
            cfg = dict(self.config)
            cameras = [
                c
                for c in list_cameras()
                if not cfg["cityId"] or c.get("cityId") == cfg["cityId"]
            ]
            if not cameras:
                self.status = "waiting-cameras"
                self._stop_event.wait(5)
                continue
            with _db_lock:
                pending = DB.execute(
                    "SELECT COUNT(*) c FROM samples WHERE status='pending'"
                ).fetchone()["c"]
            if cfg["maxPending"] and pending >= cfg["maxPending"]:
                # Menunggu operator menyetujui/membuang sampel pending.
                self.status = "paused-full"
                self._stop_event.wait(10)
                continue

            # ---- KEPUTUSAN JEV #1: kamera mana yang di-capture berikutnya,
            #      dan seberapa cepat ritmenya (fail-open ke round-robin).
            camera_stats = [
                {
                    "id": c["id"],
                    "name": c.get("name", ""),
                    "city": c.get("city", ""),
                    **self.camera_history.get(c["id"], {}),
                }
                for c in cameras
            ]
            decision = typesafe_decide_next(camera_stats)
            camera = None
            chosen_id = decision.get("nextCamera")
            if chosen_id:
                camera = next(
                    (c for c in cameras if c["id"] == chosen_id), None
                )
            if camera is None:
                camera = cameras[index % len(cameras)]
                index += 1
            gap = self._last_capture_by_camera.get(camera["id"], 0)
            if time.time() - gap < cfg["minCameraGapS"]:
                self._stop_event.wait(1)
                continue
            wait_s = {"fast": 3, "normal": 8, "slow": 20}.get(
                decision.get("cadence"), cfg["intervalS"]
            )
            self.stats["lastDecision"] = {
                "camera": camera.get("name", camera["id"]),
                "cadence": decision.get("cadence") or "round-robin",
                "decidedBy": "jev" if decision else "round-robin",
            }
            self.stats["lastCamera"] = f"{camera.get('city', '')} · {camera.get('name', '')}"
            self.status = "capturing"
            try:
                payload = capture_from_gev(camera["id"])
                persons = payload.get("persons", []) or []
                # Gerbang murah dulu (tanpa AI): YOLO tak melihat orang.
                if len(persons) < cfg["minPersons"]:
                    self.stats["skippedEmpty"] += 1
                    self._last_capture_by_camera[camera["id"]] = time.time()
                    self._stop_event.wait(max(2, wait_s))
                    continue
                # ---- KEPUTUSAN JEV #2: routing sampel — approved / pending /
                #      discard, dari verdikt ber-tipe atas bingkai ini.
                verdict = typesafe_route(camera, payload, persons)
                if verdict.get("enabled") and verdict.get("failOpen"):
                    self.stats["aiErrors"] += 1
                if verdict.get("route") == "discard":
                    self.stats["aiFiltered"] += 1
                    self._note_camera(camera, persons, verdict, error=False)
                    self._last_capture_by_camera[camera["id"]] = time.time()
                    self._stop_event.wait(max(2, wait_s))
                    continue
                sample_id = store_capture_sample(camera, payload, verdict)
                if sample_id:
                    self.stats["captured"] += 1
                    self.stats["lastSampleId"] = sample_id
                    if verdict.get("route") == "approved":
                        self.stats["aiApproved"] += 1
                    else:
                        self.stats["aiPending"] += 1
                self._note_camera(camera, persons, verdict, error=False)
            except Exception as exc:  # layanan turun / upstream error — lanjut
                self.stats["errors"] += 1
                self.stats["lastError"] = str(exc)[:200]
                self._note_camera(camera, None, None, error=True)
                self._stop_event.wait(min(15, wait_s or cfg["intervalS"]))
            # Jeda antar capture; interruptible agar stop responsif.
            self._stop_event.wait(max(2, wait_s))
        self.status = "stopped" if not self.running else self.status

    def _note_camera(self, camera, persons, verdict, error):
        """Simpan statistik terakhir per kamera — state untuk keputusan Jev."""
        history = self.camera_history.setdefault(camera["id"], {"errors": 0})
        if error:
            history["errors"] = history.get("errors", 0) + 1
            history["lastAt"] = datetime.now(timezone.utc).isoformat()
            return
        history.update(
            {
                "lastCount": len(persons or []),
                "lastQuality": verdict.get("quality") if verdict else None,
                "lastScene": verdict.get("scene") if verdict else None,
                "lastAt": datetime.now(timezone.utc).isoformat(),
            }
        )


COLLECTOR = Collector()


def store_capture_sample(camera, payload, ai_verdict=None):
    """Simpan satu sampel hasil capture + pre-label kotaknya. → id sampel.

    Rute dari keputusan Jev menentukan status awal: 'approved' langsung sah,
    'pending' menunggu tinjauan manusia. Route 'discard' tidak disimpan.
    """
    route = (ai_verdict or {}).get("route") or "pending"
    if route == "discard":
        return None
    status = "approved" if route == "approved" else "pending"
    image_bytes = base64.b64decode(payload["frame"])
    width = int(payload.get("width") or 0)
    height = int(payload.get("height") or 0)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
    image_file = f"{camera['id']}_{stamp}.jpg"
    (IMAGES_DIR / image_file).write_bytes(image_bytes)
    with _db_lock:
        cursor = DB.execute(
            "INSERT INTO samples (camera_id, camera_name, city, image_file,"
            " width, height, status) VALUES (?,?,?,?,?,?,?)",
            (
                camera["id"],
                camera.get("name", ""),
                camera.get("city", ""),
                image_file,
                width,
                height,
                status,
            ),
        )
        sample_id = cursor.lastrowid
        for person in payload.get("persons", []) or []:
            x1, y1, x2, y2 = person["box"]
            xc = ((x1 + x2) / 2) / max(width, 1)
            yc = ((y1 + y2) / 2) / max(height, 1)
            ww = (x2 - x1) / max(width, 1)
            hh = (y2 - y1) / max(height, 1)
            DB.execute(
                "INSERT INTO boxes (sample_id, class_name, xc, yc, ww, hh,"
                " conf, source) VALUES (?,?,?,?,?,?,?,?)",
                (sample_id, "person", xc, yc, ww, hh, person["conf"], "model"),
            )
        if ai_verdict and ai_verdict.get("enabled") and not ai_verdict.get("failOpen"):
            DB.execute(
                "INSERT OR REPLACE INTO ai_checks (sample_id, worthiness,"
                " quality, scene, raw) VALUES (?,?,?,?,?)",
                (
                    sample_id,
                    ai_verdict.get("worthiness"),
                    ai_verdict.get("quality"),
                    ai_verdict.get("scene"),
                    json.dumps(ai_verdict.get("raw", {}))[:4000],
                ),
            )
        DB.commit()
    return sample_id


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


DB = get_db()
DB.executescript(
    """
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      camera_id TEXT NOT NULL,
      camera_name TEXT DEFAULT '',
      city TEXT DEFAULT '',
      image_file TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
      class_name TEXT NOT NULL DEFAULT 'person',
      xc REAL NOT NULL,
      yc REAL NOT NULL,
      ww REAL NOT NULL,
      hh REAL NOT NULL,
      conf REAL,
      source TEXT NOT NULL DEFAULT 'model'
    );
    CREATE INDEX IF NOT EXISTS idx_boxes_sample ON boxes(sample_id);
    """
)
DB.commit()

# Hasil penilaian TypeSafe (Jev) per sampel — tabel terpisah agar skema
# inti tidak berubah bila layanan AI tidak dipakai.
DB.executescript(
    """
    CREATE TABLE IF NOT EXISTS ai_checks (
      sample_id INTEGER PRIMARY KEY REFERENCES samples(id) ON DELETE CASCADE,
      worthiness REAL,
      quality REAL,
      scene TEXT,
      raw TEXT
    );
    """
)
DB.commit()


def typesafe_api_key():
    return os.environ.get("TYPESAFE_API_KEY") or ""


def typesafe_route(camera, payload, persons):
    """Keputusan Jev (TypeSafe System One) atas SATU bingkai hasil capture.

    Satu permintaan, tiga pertanyaan paralel:
      - real_person_present (noul): apakah deteksi YOLO wajar sebagai manusia
        nyata yang terlihat jelas;
      - frame_labeling_value (score 0-3): nilai bingkai sebagai data latih;
      - scene_type (choice): klasifikasi adegan (metadata dataset).

    Dari verdikt itu KODE memutuskan rutenya:
      worthiness >= 0.75 dan quality >= 2.5  -> 'approved' (langsung sah)
      worthiness >= 0.5                      -> 'pending'  (tinjau manusia)
      selain itu                             -> 'discard'  (buang)
    Gagal jaringan/API = fail-open ke 'pending' — keputusan akhir tetap di
    manusia, pengumpulan tidak pernah berhenti karena AI.
    """
    key = typesafe_api_key()
    if not key:
        return {"enabled": False, "route": "pending"}
    width = max(int(payload.get("width") or 1), 1)
    height = max(int(payload.get("height") or 1), 1)
    confs = [p["conf"] for p in persons if p.get("conf") is not None]
    areas = [
        (p["box"][2] - p["box"][0]) * (p["box"][3] - p["box"][1]) / (width * height)
        for p in persons
        if len(p.get("box", [])) == 4
    ]
    state = {
        "cameraName": camera.get("name", ""),
        "city": camera.get("city", ""),
        "detectedCount": len(persons),
        "maxConfidence": round(max(confs), 3) if confs else 0,
        "avgConfidence": round(sum(confs) / len(confs), 3) if confs else 0,
        "avgBoxAreaFraction": round(sum(areas) / len(areas), 4) if areas else 0,
        "localHour": datetime.now().hour,
    }
    body = json.dumps(
        {
            "state": state,
            "model": "jev-latest",
            "questions": {
                "real_person_present": {
                    "type": "noul",
                    "instructions": {
                        "question": (
                            "Berdasarkan pola deteksi ini, apakah bingkai CCTV"
                            " benar-benar memuat setidaknya satu manusia nyata"
                            " yang terlihat jelas?"
                        ),
                        "detections": "`detectedCount` deteksi YOLOv8 (kelas person)",
                        "confidence": "`maxConfidence` dan `avgConfidence`",
                        "context": "kamera `cameraName` di `city`, jam lokal `localHour`",
                    },
                    "criteria": {
                        "true": "Pola deteksi wajar untuk manusia nyata pada adegan seperti ini",
                        "false": "Deteksi kemungkinan salah — siluet, bayangan, manekin, atau kualitas malam",
                    },
                },
                "frame_labeling_value": {
                    "type": "score",
                    "instructions": (
                        "Seberapa bernilai bingkai ini sebagai data latih"
                        " deteksi manusia? Pertimbangkan jumlah, keyakinan,"
                        " ukuran objek, dan konteks waktu-tempat."
                    ),
                    "criteria": [
                        "Tidak bernilai — tidak ada manusia yang bisa dipakai",
                        "Lemah — indikasi tipis, sulit dipakai melatih model",
                        "Cukup — ada manusia yang bisa dilabeli",
                        "Baik — adegan ramai manusia, citra dan deteksi mantap",
                    ],
                },
                "scene_type": {
                    "type": "choice",
                    "instructions": "Klasifikasikan adegan bingkai CCTV ini.",
                    "criteria": {
                        "empty": "Jalan/area kosong tanpa pejalan kaki terlihat",
                        "sparse": "Satu hingga beberapa pejalan kaki",
                        "moderate": "Keramaian sedang — banyak pejalan kaki terpisah",
                        "dense": "Kerumunan padat",
                        "unusable": "Kualitas tidak memadai (gelap, rusak, sudut tak berguna)",
                    },
                },
            },
        }
    ).encode("utf-8")
    request = urlrequest.Request(
        "https://api.typesafe.ai/v1/systemone",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(request, timeout=20) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        return {
            "enabled": True,
            "error": str(exc)[:200],
            "failOpen": True,
            "route": "pending",
        }
    answers = result.get("answers", {})
    worthiness = answers.get("real_person_present", {}).get("noul")
    quality = answers.get("frame_labeling_value", {}).get("score")
    scene = answers.get("scene_type", {}).get("choice")
    # Kode yang memutuskan rute dari verdikt ber-tipe — kebijakan eksplisit.
    if worthiness is not None and worthiness >= 0.75 and (
        quality is not None and quality >= 2.5
    ):
        route = "approved"
    elif worthiness is None or worthiness >= 0.5:
        route = "pending"
    else:
        route = "discard"
    return {
        "enabled": True,
        "worthiness": worthiness,
        "quality": quality,
        "scene": scene,
        "route": route,
        "raw": result,
    }


def typesafe_decide_next(camera_stats):
    """Keputusan Jev atas PENJADWALAN: kamera mana yang paling prospektif
    untuk di-capture berikutnya, dan seberapa cepat ritmenya.

    Satu permintaan, dua pertanyaan paralel atas statistik semua kamera:
      - next_camera (choice): kamera dengan prospek data terbaik saat ini;
      - capture_cadence (choice): cepat / normal / santai.

    Gagal = fail-open: kode melanjutkan round-robin biasa.
    """
    key = typesafe_api_key()
    if not key or not camera_stats:
        return {}
    body = json.dumps(
        {
            "state": {
                "localHour": datetime.now().hour,
                "cameras": camera_stats,
            },
            "model": "jev-latest",
            "questions": {
                "next_camera": {
                    "type": "choice",
                    "instructions": {
                        "question": (
                            "Kamera CCTV mana yang paling prospektif di-capture"
                            " BERIKUTNYA untuk dataset deteksi manusia?"
                        ),
                        "how_to_choose": (
                            "Utamakan kamera dengan deteksi manusia terkini yang"
                            " kaya namun belum terlalu sering diambil; hindari"
                            " kamera yang sering gagal atau selalu kosong."
                        ),
                        "candidates": "daftar `cameras` (id, nama, statistik terakhir)",
                    },
                    "criteria": {
                        c["id"]: f"{c.get('name', '')} — orang terakhir:"
                        f" {c.get('lastCount', '?')}, kualitas Jev:"
                        f" {c.get('lastQuality', '?')}, galat:"
                        f" {c.get('errors', 0)}"
                        for c in camera_stats
                    },
                },
                "capture_cadence": {
                    "type": "choice",
                    "instructions": (
                        "Seberapa cepat siklus capture berikutnya? Dasarkan pada"
                        " kesibukan adegan kamera-kamera saat ini."
                    ),
                    "criteria": {
                        "fast": "Adegan ramai berubah cepat — ambil sesering mungkin",
                        "normal": "Aktivitas biasa — ritme standar",
                        "slow": "Kamera sepi/hampir kosong — jangan buang kuota",
                    },
                },
            },
        }
    ).encode("utf-8")
    request = urlrequest.Request(
        "https://api.typesafe.ai/v1/systemone",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(request, timeout=15) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return {}
    answers = result.get("answers", {})
    return {
        "nextCamera": answers.get("next_camera", {}).get("choice"),
        "cadence": answers.get("capture_cadence", {}).get("choice"),
    }


def sample_to_dict(row, with_boxes=False):
    data = {
        "id": row["id"],
        "cameraId": row["camera_id"],
        "cameraName": row["camera_name"],
        "city": row["city"],
        "width": row["width"],
        "height": row["height"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "imageUrl": f"/api/samples/{row['id']}/image",
    }
    if with_boxes:
        boxes = DB.execute(
            "SELECT id, class_name, xc, yc, ww, hh, conf, source"
            " FROM boxes WHERE sample_id = ? ORDER BY id",
            (row["id"],),
        ).fetchall()
        data["boxes"] = [
            {
                "id": b["id"],
                "className": b["class_name"],
                "xc": b["xc"],
                "yc": b["yc"],
                "ww": b["ww"],
                "hh": b["hh"],
                "conf": b["conf"],
                "source": b["source"],
            }
            for b in boxes
        ]
        ai = DB.execute(
            "SELECT worthiness, quality, scene FROM ai_checks WHERE sample_id = ?",
            (row["id"],),
        ).fetchone()
        if ai:
            data["ai"] = {
                "worthiness": ai["worthiness"],
                "quality": ai["quality"],
                "scene": ai["scene"],
            }
    return data


# ---------------------------------------------------------------------------
# GEV CCTV integration
# ---------------------------------------------------------------------------

def fetch_gev_json(path, timeout=GEV_TIMEOUT_S):
    req = urlrequest.Request(f"{GEV_BASE}{path}", headers={"Accept": "application/json"})
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def list_cameras():
    now = time.time()
    if now - _camera_cache["at"] > CAMERA_CACHE_TTL_S or not _camera_cache["sources"]:
        try:
            payload = fetch_gev_json("/api/cctv/sources")
            _camera_cache["sources"] = payload.get("sources", [])
            _camera_cache["at"] = now
        except Exception:
            # GEV sedang tidak jalan — pakai cache apa adanya (boleh kosong).
            pass
    return _camera_cache["sources"]


def capture_from_gev(camera_id, attempts=2):
    """Ambil satu sampel dari kamera CCTV via proxy GEV + detektor YOLOv8.

    Pembukaan stream HLS kadang gagal pada percobaan pertama (portal lambat
    menjawab) — dua percobaan menaikkan keberhasilan tanpa menambah beban
    berarti. Melempar Exception bila semua percobaan gagal.
    """
    last_error = None
    for attempt in range(attempts):
        try:
            payload = fetch_gev_json(
                f"/api/cctv/detect/{urlrequest.quote(str(camera_id), safe='')}"
            )
            if payload.get("frame"):
                return payload
            last_error = RuntimeError(
                payload.get("error") or "no frame returned"
            )
        except Exception as exc:
            last_error = exc
        if attempt + 1 < attempts:
            time.sleep(2)
    raise RuntimeError(str(last_error))


# ---------------------------------------------------------------------------
# Ekspor dataset
# ---------------------------------------------------------------------------

def class_index_map():
    rows = DB.execute(
        "SELECT DISTINCT class_name FROM boxes ORDER BY class_name"
    ).fetchall()
    names = [r["class_name"] for r in rows] or ["person"]
    if "person" not in names:
        names.insert(0, "person")
    return {name: idx for idx, name in enumerate(names)}


def export_yolo_zip():
    """Dataset format YOLO: images/<id>.jpg + labels/<id>.txt + classes.txt.

    Kotak disimpan ternormalisasi (xc, yc, ww, hh) — persis format YOLO.
    """
    classes = class_index_map()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("classes.txt", "\n".join(classes.keys()) + "\n")
        samples = DB.execute("SELECT * FROM samples ORDER BY id").fetchall()
        for row in samples:
            image_path = IMAGES_DIR / row["image_file"]
            if not image_path.exists():
                continue
            zf.writestr(f"images/{row['image_file']}", image_path.read_bytes())
            boxes = DB.execute(
                "SELECT class_name, xc, yc, ww, hh FROM boxes WHERE sample_id = ?",
                (row["id"],),
            ).fetchall()
            lines = [
                f"{classes[b['class_name']]} {b['xc']:.6f} {b['yc']:.6f}"
                f" {b['ww']:.6f} {b['hh']:.6f}"
                for b in boxes
            ]
            stem = Path(row["image_file"]).stem
            zf.writestr(f"labels/{stem}.txt", "\n".join(lines) + ("\n" if lines else ""))
        zf.writestr(
            "README.txt",
            "YOLO human-detection dataset from God's Eye View CCTV labelling\n"
            f"exported: {datetime.now(timezone.utc).isoformat()}\n"
            f"samples: {len(samples)}\n"
            "labels: class_idx x_center y_center width height (normalized)\n",
        )
    return buf.getvalue(), len(classes)


def export_coco_json():
    """Dataset format COCO (images + annotations + categories)."""
    classes = class_index_map()
    images = []
    annotations = []
    ann_id = 1
    samples = DB.execute("SELECT * FROM samples ORDER BY id").fetchall()
    for row in samples:
        file_name = f"{row['camera_id'] or 'cam'}_{row['id']}.jpg"
        images.append(
            {
                "id": row["id"],
                "file_name": file_name,
                "width": row["width"],
                "height": row["height"],
                "date_captured": row["created_at"],
                "cctv_camera": row["camera_name"],
                "cctv_city": row["city"],
            }
        )
        boxes = DB.execute(
            "SELECT id, class_name, xc, yc, ww, hh, conf FROM boxes WHERE sample_id = ?",
            (row["id"],),
        ).fetchall()
        for b in boxes:
            x_center, y_center = b["xc"] * row["width"], b["yc"] * row["height"]
            w, h = b["ww"] * row["width"], b["hh"] * row["height"]
            annotations.append(
                {
                    "id": ann_id,
                    "image_id": row["id"],
                    "category_id": classes[b["class_name"]] + 1,  # COCO mulai 1
                    "bbox": [
                        round(x_center - w / 2, 2),
                        round(y_center - h / 2, 2),
                        round(w, 2),
                        round(h, 2),
                    ],
                    "area": round(w * h, 2),
                    "iscrowd": 0,
                    "attributes": {"confidence": b["conf"], "source": "cctv-labeler"},
                }
            )
            ann_id += 1
    return {
        "info": {
            "description": "Human detection labels from God's Eye View CCTV",
            "date_created": datetime.now(timezone.utc).isoformat(),
        },
        "categories": [
            {"id": idx + 1, "name": name} for name, idx in classes.items()
        ],
        "images": images,
        "annotations": annotations,
    }


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".zip": "application/zip",
}


class LabelerHandler(BaseHTTPRequestHandler):
    server_version = "HumanLabeler/1.0"

    # -- helpers ----------------------------------------------------------

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, status, body, content_type, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if filename:
            self.send_header(
                "Content-Disposition", f'attachment; filename="{filename}"'
            )
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, rel_path):
        target = (STATIC_DIR / rel_path).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            self._send_json(404, {"error": "not found"})
            return
        body = target.read_bytes()
        mime = MIME.get(target.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", mime)
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

    # -- GET ---------------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path == "/" or path == "/index.html":
                self._send_static("index.html")
                return
            if path.startswith("/static/"):
                self._send_static(path[len("/static/"):])
                return
            if path == "/api/health":
                self._send_json(200, {"ok": True, "gevBase": GEV_BASE})
                return
            if path == "/api/collector/status":
                self._send_json(200, COLLECTOR.snapshot())
                return
            if path == "/api/cameras":
                sources = list_cameras()
                cameras = [
                    {
                        "id": s["id"],
                        "name": s["name"],
                        "city": s["city"],
                        "cityId": s.get("cityId") or s["city"],
                        "feedType": s.get("feedType", "image"),
                    }
                    for s in sources
                ]
                self._send_json(200, {"cameras": cameras})
                return
            if path == "/api/stats":
                with _db_lock:
                    total = DB.execute("SELECT COUNT(*) c FROM samples").fetchone()["c"]
                    approved = DB.execute(
                        "SELECT COUNT(*) c FROM samples WHERE status='approved'"
                    ).fetchone()["c"]
                    boxes = DB.execute("SELECT COUNT(*) c FROM boxes").fetchone()["c"]
                    human_boxes = DB.execute(
                        "SELECT COUNT(*) c FROM boxes WHERE source='human'"
                    ).fetchone()["c"]
                    by_class = {
                        r["class_name"]: r["c"]
                        for r in DB.execute(
                            "SELECT class_name, COUNT(*) c FROM boxes"
                            " GROUP BY class_name ORDER BY c DESC"
                        ).fetchall()
                    }
                self._send_json(
                    200,
                    {
                        "samples": total,
                        "approved": approved,
                        "pending": total - approved,
                        "boxes": boxes,
                        "humanEditedBoxes": human_boxes,
                        "boxesByClass": by_class,
                    },
                )
                return
            if path == "/api/samples":
                status = self.path.split("status=")[-1].split("&")[0] if "status=" in self.path else None
                query = "SELECT * FROM samples"
                params = ()
                if status in ("pending", "approved"):
                    query += " WHERE status = ?"
                    params = (status,)
                query += " ORDER BY id DESC LIMIT 200"
                with _db_lock:
                    rows = DB.execute(query, params).fetchall()
                self._send_json(
                    200, {"samples": [sample_to_dict(r) for r in rows]}
                )
                return
            if path.startswith("/api/samples/"):
                parts = path.strip("/").split("/")
                # /api/samples/:id[/image]
                sample_id = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None
                if sample_id is None:
                    self._send_json(400, {"error": "bad sample id"})
                    return
                with _db_lock:
                    row = DB.execute(
                        "SELECT * FROM samples WHERE id = ?", (sample_id,)
                    ).fetchone()
                if row is None:
                    self._send_json(404, {"error": "sample not found"})
                    return
                if len(parts) > 3 and parts[3] == "image":
                    image_path = IMAGES_DIR / row["image_file"]
                    if not image_path.exists():
                        self._send_json(404, {"error": "image missing"})
                        return
                    self._send_bytes(200, image_path.read_bytes(), "image/jpeg")
                    return
                with _db_lock:
                    self._send_json(200, sample_to_dict(row, with_boxes=True))
                return
            if path == "/api/export/yolo":
                body, _ = export_yolo_zip()
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                self._send_bytes(
                    200, body, "application/zip", f"human-dataset-yolo-{stamp}.zip"
                )
                return
            if path == "/api/export/coco":
                body = json.dumps(export_coco_json(), indent=1).encode("utf-8")
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                self._send_bytes(
                    200,
                    body,
                    "application/json",
                    f"human-dataset-coco-{stamp}.json",
                )
                return
            self._send_json(404, {"error": "not found"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    # -- POST / PUT / DELETE ------------------------------------------------

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/api/collector/start":
                body = self._read_json_body()
                started = COLLECTOR.start(body)
                self._send_json(200, {**COLLECTOR.snapshot(), "justStarted": started})
                return
            if path == "/api/collector/stop":
                stopped = COLLECTOR.stop()
                self._send_json(200, {**COLLECTOR.snapshot(), "justStopped": stopped})
                return
            if path == "/api/capture":
                body = self._read_json_body()
                camera_id = str(body.get("cameraId") or "").strip()
                if not camera_id:
                    self._send_json(400, {"error": "cameraId required"})
                    return
                cameras = {c["id"]: c for c in list_cameras()}
                camera = cameras.get(camera_id, {"name": camera_id, "city": ""})
                try:
                    payload = capture_from_gev(camera_id)
                except Exception as exc:
                    self._send_json(
                        502,
                        {
                            "error": f"capture failed: {exc}",
                            "hint": "pastikan aplikasi GEV (4173) dan layanan deteksi (5101) berjalan",
                        },
                    )
                    return
                frame_b64 = payload["frame"]
                width = int(payload.get("width") or 0)
                height = int(payload.get("height") or 0)
                sample_id = store_capture_sample(camera, payload)
                self._send_json(
                    200,
                    {
                        "sampleId": sample_id,
                        "cameraId": camera_id,
                        "cameraName": camera.get("name", ""),
                        "city": camera.get("city", ""),
                        "width": width,
                        "height": height,
                        "preLabels": len(payload.get("persons", [])),
                        "imageUrl": f"/api/samples/{sample_id}/image",
                    },
                )
                return
            if path.startswith("/api/samples/") and path.endswith("/boxes"):
                sample_id = int(path.strip("/").split("/")[2])
                body = self._read_json_body()
                boxes = body.get("boxes") or []
                status = body.get("status")
                if status not in (None, "pending", "approved"):
                    self._send_json(400, {"error": "bad status"})
                    return
                with _db_lock:
                    row = DB.execute(
                        "SELECT id FROM samples WHERE id = ?", (sample_id,)
                    ).fetchone()
                    if row is None:
                        self._send_json(404, {"error": "sample not found"})
                        return
                    DB.execute("DELETE FROM boxes WHERE sample_id = ?", (sample_id,))
                    for box in boxes:
                        DB.execute(
                            "INSERT INTO boxes (sample_id, class_name, xc, yc,"
                            " ww, hh, conf, source) VALUES (?,?,?,?,?,?,?,?)",
                            (
                                sample_id,
                                str(box.get("className") or "person"),
                                float(box["xc"]),
                                float(box["yc"]),
                                float(box["ww"]),
                                float(box["hh"]),
                                box.get("conf"),
                                str(box.get("source") or "human"),
                            ),
                        )
                    if status:
                        DB.execute(
                            "UPDATE samples SET status = ? WHERE id = ?",
                            (status, sample_id),
                        )
                    DB.commit()
                self._send_json(200, {"ok": True, "boxes": len(boxes), "status": status})
                return
            self._send_json(404, {"error": "not found"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def do_DELETE(self):
        path = self.path.split("?")[0]
        try:
            if path.startswith("/api/samples/"):
                sample_id = int(path.strip("/").split("/")[2])
                with _db_lock:
                    row = DB.execute(
                        "SELECT image_file FROM samples WHERE id = ?", (sample_id,)
                    ).fetchone()
                    if row is None:
                        self._send_json(404, {"error": "sample not found"})
                        return
                    DB.execute("DELETE FROM boxes WHERE sample_id = ?", (sample_id,))
                    DB.execute("DELETE FROM samples WHERE id = ?", (sample_id,))
                    DB.commit()
                image_path = IMAGES_DIR / row["image_file"]
                if image_path.exists():
                    image_path.unlink()
                self._send_json(200, {"ok": True})
                return
            self._send_json(404, {"error": "not found"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), LabelerHandler)
    print(f"Human Labeler listening on http://{HOST}:{PORT} (GEV: {GEV_BASE})")
    server.serve_forever()
