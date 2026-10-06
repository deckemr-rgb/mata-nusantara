# Mata Nusantara — Sistem Pengawasan & Analitik CCTV Orang

Satu monorepo berisi seluruh sistem: konsol intelijen CCTV real-time, deteksi
orang, pelabelan dataset, dan penghitung orang melewati kamera — tanpa peta,
berbasis CCTV.

## Komponen

| Folder | Apa itu | Port |
|---|---|---|
| `gods-eye-view/` | Konsol utama: globe CCTV, 5 kamera Jakarta (HLS), deteksi orang real-time (panel + layar penuh), tautan ke alat lain | 4173 |
| `human-detector/` | Layanan deteksi orang YOLOv8 (HTTP): `/detect`, `/detect-url`, `/health` — HLS dibuka via FFmpeg | 5101 |
| `human-labeler/` | Pelabelan dataset: kolektor otomatis + keputusan TypeSafe Jev + editor kotak + ekspor YOLO/COCO | 5102 |
| `human-counter/` | Penghitung orang melewati kamera: deteksi real-time di peramban + pelacak IoU + anti-duplikasi dua lapis + dashboard statistik (tanpa peta) | 5103 |

## Cara Menjalankan (semua dari root repo)

```bash
# 1. Konsol utama (butuh Node 20+)
cd gods-eye-view && npm install && npm run dev   # → http://localhost:4173

# 2. Layanan deteksi YOLOv8 (butuh Python 3.10+, `pip install ultralytics opencv-python-headless`)
cd human-detector && python detector_server.py   # → http://127.0.0.1:5101

# 3. Human Labeler (opsional, untuk pelabelan dataset)
cd human-labeler && python labeling_server.py    # → http://localhost:5102

# 4. Human Counter (opsional, penghitung orang)
cd human-counter && python counter_server.py     # → http://localhost:5103
```

Konfigurasi kunci API melalui `.env` (lihat `gods-eye-view/.env.example`);
`.env` tidak pernah ikut repositori.

## Arsitektur

```
[GEV :4173] ──proxy CCTV──> kamera Jakarta (HLS, 20 fps)
     │
     ├── /api/cctv/detect/:id ──> [human-detector :5101] YOLOv8s @1280px
     │                              (panel CCTV: kotak real-time + hasil anotasi)
     ├── [human-counter :5103] deteksi in-browser (COCO-SSD WebGL) + pelacak
     │    IoU + SQLite — setiap orang yang lewat tercatat sekali
     └── [human-labeler :5102] kolektor otomatis + TypeSafe Jev + ekspor
          dataset YOLO/COCO
```

## Lisensi

- `gods-eye-view` mengikuti lisensi proyek aslinya (MIT, lihat foldernya).
- `human-detector` memuat kode dari repo [muqadasejaz/Human-Detector](https://github.com/muqadasejaz/Human-Detector) (MIT).
- `human-labeler` dan `human-counter`: MIT.
