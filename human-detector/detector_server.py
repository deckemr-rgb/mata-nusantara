"""Deteksi orang YOLOv8 sebagai layanan HTTP kecil untuk God's Eye View.

Diadaptasi dari app.py repo ini (model sama, kelas 0 = person, ambang sama
0.45) supaya panel CCTV GEV bisa menjalankan deteksi atas bingkai kamera:
  POST /detect      body = JPEG/PNG bytes  -> JSON deteksi
  POST /detect-url  body = {"url": ...}    -> ambil satu bingkai dari stream
                                             (HLS/MJPEG/snapshot) lewat
                                             OpenCV/FFmpeg, lalu deteksi
  GET  /health      -> status layanan

Layanan hanya mendengarkan di 127.0.0.1: URL stream tidak pernah diterima
dari klien peramban — server Vite GEV-lah yang meneruskan URL hulu yang
sudah terdaftar di registri kamarnya (lihat server/providers/cctv.js).
"""

import base64
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from ultralytics import YOLO

# Model & parameter inferensi — bisa disetel lewat env tanpa ubah kode:
#   HUMAN_DETECTOR_MODEL=yolov8s.pt  (default; 'yolov8n.pt' lebih cepat
#   tetapi sering melewatkan orang jauh/kecil pada kamera CCTV)
#   HUMAN_DETECTOR_IMGSZ=1280        (resolusi inferensi; 640 kehilangan
#   orang di kejauhan, 1280 menangkap kerumunan)
#   HUMAN_DETECTOR_CONF=0.25         (ambang; 0.45 kehilangan orang samar)
MODEL_PATH = os.environ.get("HUMAN_DETECTOR_MODEL", "yolov8s.pt")
IMGSZ = int(os.environ.get("HUMAN_DETECTOR_IMGSZ", "1280"))
CONF_THRESHOLD = float(os.environ.get("HUMAN_DETECTOR_CONF", "0.25"))
NMS_IOU = float(os.environ.get("HUMAN_DETECTOR_IOU", "0.6"))
HOST = "127.0.0.1"
PORT = 5101

_model = None
_infer_lock = threading.Lock()


def load_model():
    global _model
    if _model is None:
        _model = YOLO(MODEL_PATH)
    return _model


def annotate_frame(frame_bgr, persons):
    """Gambar kotak, label, dan banner jumlah orang — gaya app.py repo ini."""
    annotated = frame_bgr.copy()
    for index, person in enumerate(persons, start=1):
        x1, y1, x2, y2 = (int(v) for v in person["box"])
        cv2.rectangle(annotated, (x1, y1), (x2, y2), (37, 99, 235), 2)
        label = f"Person {index}"
        (lw, lh), _ = cv2.getTextSize(
            label, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1
        )
        cv2.rectangle(
            annotated, (x1, y1 - lh - 8), (x1 + lw + 6, y1), (37, 99, 235), -1
        )
        cv2.putText(
            annotated, label, (x1 + 3, y1 - 4),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1,
        )
    # Banner jumlah orang (kiri atas), sama seperti demo repo.
    overlay_text = f"Persons Detected: {len(persons)}"
    cv2.rectangle(annotated, (0, 0), (280, 42), (37, 99, 235), -1)
    cv2.putText(
        annotated, overlay_text, (10, 28),
        cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2,
    )
    ok, encoded = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        return None
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def detect_persons(frame_bgr):
    """Jalankan deteksi pada satu bingkai BGR; kembalikan hasil JSON-able."""
    model = load_model()
    with _infer_lock:
        results = model(
            frame_bgr,
            stream=True,
            verbose=False,
            imgsz=IMGSZ,
            conf=CONF_THRESHOLD,
            iou=NMS_IOU,
        )
    persons = []
    height, width = frame_bgr.shape[:2]
    for result in results:
        for box in result.boxes:
            cls = int(box.cls[0])
            conf = float(box.conf[0])
            if cls != 0:
                continue
            x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
            persons.append(
                {
                    "box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                    "conf": round(conf, 3),
                }
            )
    persons.sort(key=lambda p: p["conf"], reverse=True)
    annotated_b64 = annotate_frame(frame_bgr, persons)
    ok, clean = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
    clean_b64 = base64.b64encode(clean.tobytes()).decode("ascii") if ok else None
    return {
        "count": len(persons),
        "persons": persons,
        "width": width,
        "height": height,
        "model": MODEL_PATH,
        "imgsz": IMGSZ,
        "confThreshold": CONF_THRESHOLD,
        "annotated": annotated_b64,
        # Bingkai bersih tanpa anotasi — dipakai alat pelabelan data sebagai
        # gambar sumber (labeling karena pratinjaunya harus polos).
        "frame": clean_b64,
    }


def grab_frame_from_url(url, timeout_seconds=12.0):
    """Ambil satu bingkai dari URL stream (HLS/MJPEG/HTTP image) via FFmpeg.

    cv2.VideoCapture dengan backend FFmpeg mampu membuka HLS — persis yang
    dibutuhkan kamera ATCS Indonesia yang berumpan HLS.
    """
    cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        return None, "cannot open stream"
    try:
        # FFmpeg kadang butuh beberapa bingkai sebelum bingkai dekode pertama
        # siap (terutama HLS); beri kesempatan sampai batas waktu.
        deadline = cv2.getTickCount() + int(timeout_seconds * cv2.getTickFrequency())
        while cv2.getTickCount() < deadline:
            ok, frame = cap.read()
            if ok and frame is not None:
                return frame, None
        return None, "timeout reading stream"
    finally:
        cap.release()


class DetectorHandler(BaseHTTPRequestHandler):
    server_version = "HumanDetector/1.0"

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "model": MODEL_PATH, "imgsz": IMGSZ, "confThreshold": CONF_THRESHOLD})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        try:
            body = self._read_body()
            if self.path == "/detect":
                arr = np.frombuffer(body, dtype=np.uint8)
                frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                if frame is None:
                    self._send_json(400, {"error": "invalid image body"})
                    return
                self._send_json(200, detect_persons(frame))
                return
            if self.path == "/detect-url":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                except json.JSONDecodeError:
                    self._send_json(400, {"error": "invalid JSON body"})
                    return
                url = str(payload.get("url") or "").strip()
                if not url:
                    self._send_json(400, {"error": "missing url"})
                    return
                frame, error = grab_frame_from_url(url)
                if frame is None:
                    self._send_json(502, {"error": error or "frame unavailable"})
                    return
                self._send_json(200, detect_persons(frame))
                return
            self._send_json(404, {"error": "not found"})
        except Exception as exc:  # jangan biarkan satu kamera buruk menjatuhkan layanan
            self._send_json(500, {"error": str(exc)})

    def log_message(self, fmt, *args):  # senyapkan log akses per permintaan
        pass


if __name__ == "__main__":
    load_model()
    server = ThreadingHTTPServer((HOST, PORT), DetectorHandler)
    print(f"Human-Detector service listening on http://{HOST}:{PORT}")
    server.serve_forever()
