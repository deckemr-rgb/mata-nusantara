"""Ukur kesibukan 50 kamera Jakarta: hitung orang per bingkai via YOLOv8.

Memakai POST /detect-url layanan Human-Detector langsung (buka HLS lewat
FFmpeg → satu bingkai → inferensi). Paralel agar 50 stream selesai dalam
beberapa menit. Keluaran: JSON terurut dari yang paling ramai.
"""
import concurrent.futures
import json
import sys
import urllib.request

DETECTOR = "http://127.0.0.1:5101/detect-url"
CAMERAS = json.load(open("jakarta-all.json", encoding="utf-8"))
WORKERS = 6


def measure(camera):
    body = json.dumps({"url": camera["url"]}).encode()
    req = urllib.request.Request(
        DETECTOR, data=body, headers={"Content-Type": "application/json"}
    )
    # Dua percobaan: pembukaan HLS kadang gagal di percobaan pertama.
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                payload = json.loads(resp.read())
            return {
                "id": camera["id"],
                "name": camera["name"],
                "url": camera["url"],
                "count": payload.get("count", 0),
                "lat": camera["lat"],
                "lon": camera["lon"],
            }
        except Exception as exc:
            err = str(exc)[:80]
            if attempt == 1:
                return {"id": camera["id"], "name": camera["name"], "url": camera["url"], "count": -1, "error": err, "lat": camera["lat"], "lon": camera["lon"]}
    return None


results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
    for result in pool.map(measure, CAMERAS):
        results.append(result)
        mark = "GALAT" if result["count"] < 0 else f"{result['count']} orang"
        print(f"{result['count']:+3d} | {mark:9s} | {result['name'][:52]}", flush=True)

ok = [r for r in results if r["count"] >= 0]
ok.sort(key=lambda r: r["count"], reverse=True)
json.dump(ok, open("jakarta-busy-rank.json", "w"), indent=1)
print(f"\nTerukur: {len(ok)}/{len(results)} kamera")
print("5 TERAMAI:")
for r in ok[:5]:
    print(f"  {r['count']} orang — {r['name'][:60]}")
