/* Human Counter — papan kendali: grid CCTV live + statistik pencatatan.
 *
 * Alur: kamera dimuat dari backend → tiap kamera satu kartu (HLS + hls.js),
 * COCO-SSD + PelacakKamera berjalan di atas videonya, orang baru dikirim ke
 * POST /api/events (kunci unik + anti-duplikat di backend), statistik &
 * feed disegarkan tiap 5 detik.
 */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  model: null,
  cameras: [],
  trackers: new Map(), // cameraId -> PelacakKamera
  counters: new Map(), // cameraId -> jumlah orang kamera ini
  queue: [], // event yang menunggu dikirim (retry dengan kunci yang sama)
};

async function api(path, options) {
  const resp = await fetch(path, options);
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(payload.error || `HTTP ${resp.status}`);
  return payload;
}

/* ------------------------------------------------------------------ */
/* Kirim event (dengan antrean ulang berkunci)                          */
/* ------------------------------------------------------------------ */

function queueEvent(event) {
  state.queue.push(event);
  flushQueue();
}

let flushing = false;
async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    while (state.queue.length) {
      const event = state.queue[0];
      try {
        await api("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        });
        state.queue.shift();
        refreshStats();
      } catch {
        break; // backend belum siap — coba lagi pada siklus berikutnya
      }
    }
  } finally {
    flushing = false;
  }
}

setInterval(async () => {
  // heartbeat jejak yang masih hidup agar last_seen terbarui di backend
  for (const tracker of state.trackers.values()) {
    for (const track of tracker.tracks) {
      if (performance.now() - track.lastSeenMs <= 4000 && track.frames > 1) {
        try {
          await api("/api/events/heartbeat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ eventKey: track.key }),
          });
        } catch { /* coba lagi nanti */ }
      }
    }
  }
}, 5000);

/* ------------------------------------------------------------------ */
/* Muat model & kamera                                                  */
/* ------------------------------------------------------------------ */

async function boot() {
  try {
    state.model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
  } catch (err) {
    document.getElementById("camera-grid").innerHTML =
      `<div class="boot-error">Gagal memuat model deteksi: ${err.message}</div>`;
    return;
  }
  const payload = await api("/api/cameras").catch(() => ({ cameras: [] }));
  state.cameras = payload.cameras || [];
  $("stat-cameras").textContent = state.cameras.length;
  buildGrid();
  refreshStats();
  setInterval(refreshStats, 5000);
}

function buildGrid() {
  const grid = $("camera-grid");
  grid.innerHTML = "";
  for (const camera of state.cameras) {
    const card = document.createElement("div");
    card.className = "cam-card";
    card.innerHTML = `
      <div class="cam-head">
        <span class="cam-name" title="${camera.name}">${camera.name}</span>
        <span class="cam-count" id="count-${camera.id}">0 di kamera</span>
      </div>
      <div class="cam-stage">
        <video id="video-${camera.id}" class="cam-video" muted autoplay playsinline></video>
        <canvas id="canvas-${camera.id}" class="cam-canvas"></canvas>
      </div>
      <div class="cam-foot" id="foot-${camera.id}">menghubungkan…</div>`;
    grid.appendChild(card);

    const video = card.querySelector(`#video-${CSS.escape(camera.id)}`);
    const canvas = card.querySelector(`#canvas-${CSS.escape(camera.id)}`);
    attachHls(video, camera.streamUrl);
    const tracker = new window.PelacakKamera({
      cameraId: camera.id,
      video,
      canvas,
      model: state.model,
      onNewPerson: queueEvent,
      onLiveCount: (cameraId, count) => {
        state.counters.set(cameraId, count);
        const el = $(`count-${CSS.escape(cameraId)}`);
        if (el) el.textContent = `${count} di kamera`;
      },
    });
    state.trackers.set(camera.id, tracker);
  }
}

function attachHls(video, url) {
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.play?.().catch(() => {});
    return;
  }
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ liveDurationInfinity: true });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        // pemulihan otomatis: coba lagi setelah 3 detik
        setTimeout(() => {
          hls.destroy();
          attachHls(video, url);
        }, 3000);
      }
    });
    return;
  }
  const foot = video.closest(".cam-card")?.querySelector(".cam-foot");
  if (foot) foot.textContent = "peramban tidak mendukung HLS";
}

/* ------------------------------------------------------------------ */
/* Statistik & feed                                                     */
/* ------------------------------------------------------------------ */

async function refreshStats() {
  try {
    const stats = await api("/api/stats");
    $("stat-total").textContent = stats.total;
    $("stat-today").textContent = stats.today;
    $("stat-hour").textContent = stats.lastHour;
    $("per-camera").innerHTML = (stats.perCamera || [])
      .map(
        (c) =>
          `<li><span>${c.camera_name || c.camera_id}</span><b>${c.count}</b></li>`,
      )
      .join("") || "<li><span>belum ada data</span></li>";
    drawChart(stats.perMinute || []);
    void refreshFeed;
  } catch { /* backend sibuk — siklus berikutnya */ }
}

let feedThrottle = 0;
function refreshFeed() {
  const now = Date.now();
  if (now - feedThrottle < 4000) return;
  feedThrottle = now;
  api("/api/events")
    .then((payload) => {
      $("feed").innerHTML = (payload.events || [])
        .slice(0, 12)
        .map((e) => {
          const time = (e.firstSeen || "").replace("T", " ").slice(5, 16);
          return `<li><span class="feed-name">#${e.id} · ${e.cameraName || e.cameraId}</span>
            <span class="feed-time">${time}</span></li>`;
        })
        .join("");
    })
    .catch(() => {});
}

function drawChart(perMinute) {
  const canvas = $("chart");
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const map = new Map(perMinute.map((r) => [r.minute, r.count]));
  const nowMinute = Math.floor(Date.now() / 60000) * 60000;
  const values = [];
  for (let i = 29; i >= 0; i--) {
    const minute = new Date(nowMinute - i * 60000).toISOString().slice(0, 19);
    values.push(map.get(minute) || 0);
  }
  const max = Math.max(1, ...values);
  const barW = canvas.width / values.length;
  values.forEach((value, index) => {
    const h = (value / max) * (canvas.height - 20);
    context.fillStyle = value ? "rgba(0, 212, 255, 0.75)" : "rgba(255,255,255,0.08)";
    context.fillRect(index * barW + 1, canvas.height - h - 12, barW - 2, h);
    if (value) {
      context.fillStyle = "#cfe9f5";
      context.font = "9px monospace";
      context.fillText(value, index * barW + 2, canvas.height - h - 15);
    }
  });
  context.fillStyle = "#6f8b9c";
  context.font = "9px monospace";
  context.fillText("-30 mnt", 2, canvas.height - 2);
  context.fillText("sekarang", canvas.width - 52, canvas.height - 2);
}

setInterval(refreshFeed, 5000);
window.addEventListener("load", () => {
  boot();
  refreshFeed();
});
