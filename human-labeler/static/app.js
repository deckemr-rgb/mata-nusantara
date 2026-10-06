/* Human Labeler — editor pelabelan kotak manusia di atas bingkai CCTV.
 *
 * Alur: pilih kamera → CAPTURE (bingkai + pre-label YOLOv8 tersimpan
 * 'pending') → koreksi kotak di canvas → SIMPAN & SETUJUI (status
 * 'approved') → ekspor YOLO/COCO.
 *
 * Kotak disimpan dalam koordinat TERNORMALISASI (xc, yc, ww, hh) — format
 * asli YOLO — sehingga ekspor tidak perlu transformasi apa pun.
 */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  cameras: [],
  currentSample: null, // {id, imageUrl, width, height, cameraName, city, status}
  image: null, // HTMLImageElement hasil load
  boxes: [], // {className, xc, yc, ww, hh, conf, source}
  selected: -1,
  autoTimer: null,
  autoCameraId: "",
  drag: null, // {mode:'draw'|'move'|'resize', ...}
};

const canvas = $("editor-canvas");
const ctx = canvas.getContext("2d");

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */

function setStatus(text, kind) {
  const el = $("editor-status");
  el.textContent = text;
  el.dataset.state = kind || "idle";
}

async function api(path, options) {
  const resp = await fetch(path, options);
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(payload.error || `HTTP ${resp.status}`);
  return payload;
}

function classNames() {
  const names = new Set(["person"]);
  for (const box of state.boxes) names.add(box.className);
  return [...names];
}

/* ------------------------------------------------------------------ */
/* Kolektor otomatis                                                   */
/* ------------------------------------------------------------------ */

let collectorPollTimer = null;

function collectorConfigFromUi() {
  return {
    intervalS: Number($("collector-interval").value) || 8,
    minPersons: Number($("collector-min").value),
    maxPending: Number($("collector-max").value) || 300,
    cityId: $("collector-city").value,
  };
}

function renderCollectorStatus(snapshot) {
  const panel = $("collector-stats");
  panel.hidden = false;
  const statusText =
    snapshot.status === "running"
      ? "BERJALAN"
      : snapshot.status === "capturing"
        ? "MENGAMBIL…"
        : snapshot.status === "paused-full"
          ? "JEDA — PENDING PENUH"
          : snapshot.status === "waiting-cameras"
            ? "MENUNGGU KAMERA"
            : "BERHENTI";
  $("coll-status").textContent = statusText;
  $("coll-ai").textContent = snapshot.aiEnabled ? "AKTIF" : "NONAKTIF (butuh kunci)";
  $("coll-captured").textContent = snapshot.stats.captured;
  $("coll-aiapproved").textContent = snapshot.stats.aiApproved || 0;
  $("coll-skipped").textContent = snapshot.stats.skippedEmpty;
  $("coll-aifiltered").textContent = snapshot.stats.aiFiltered || 0;
  $("coll-errors").textContent = snapshot.stats.errors;
  $("coll-pending").textContent = snapshot.stats.pending;
  const decision = snapshot.lastDecision;
  $("coll-decision").textContent = decision
    ? `${decision.camera} · ${decision.cadence} · oleh ${decision.decidedBy}`
    : "—";
  $("coll-camera").textContent = snapshot.stats.lastCamera || "—";
  const btn = $("collector-btn");
  btn.textContent = snapshot.running ? "■ HENTIKAN KOLEKTOR" : "▶ MULAI KOLEKTOR";
  btn.classList.toggle("primary", !snapshot.running);
}

async function pollCollector() {
  try {
    renderCollectorStatus(await api("/api/collector/status"));
  } catch {
    /* layanan sedang tidak terjangkau — coba lagi pada siklus berikut */
  }
}

$("collector-btn").addEventListener("click", async () => {
  const btn = $("collector-btn");
  btn.disabled = true;
  try {
    const running = btn.getAttribute("data-running") === "1";
    const endpoint = running ? "/api/collector/stop" : "/api/collector/start";
    const snapshot = await api(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectorConfigFromUi()),
    });
    btn.setAttribute("data-running", snapshot.running ? "1" : "0");
    renderCollectorStatus(snapshot);
    if (snapshot.running && !collectorPollTimer) {
      collectorPollTimer = setInterval(pollCollector, 3000);
    }
    if (!snapshot.running && collectorPollTimer) {
      clearInterval(collectorPollTimer);
      collectorPollTimer = null;
      await refreshSamples();
      await refreshStats();
    }
  } catch (err) {
    setStatus(`KOLEKTOR GAGAL: ${err.message}`.slice(0, 60), "error");
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* Kamera                                                              */
/* ------------------------------------------------------------------ */

async function loadCameras() {
  setStatus("MEMUAT KAMERA", "busy");
  try {
    const payload = await api("/api/cameras");
    state.cameras = payload.cameras || [];
  } catch (err) {
    setStatus("GEV TIDAK TERJANGKAU", "error");
    return;
  }
  const cities = new Map();
  for (const cam of state.cameras) {
    cities.set(cam.cityId, (cities.get(cam.cityId) || 0) + 1);
  }
  const cityFilter = $("city-filter");
  cityFilter.innerHTML =
    '<option value="">Semua kota</option>' +
    [...cities.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => {
        const sample = state.cameras.find((c) => c.cityId === id);
        return `<option value="${id}">${sample?.city || id} (${count})</option>`;
      })
      .join("");
  // Kota filter juga mengisi pilihan luas kota kolektor.
  $("collector-city").innerHTML = cityFilter.innerHTML;
  fillCameraSelect();
  setStatus("SIAP", "ok");
}

function fillCameraSelect() {
  const cityId = $("city-filter").value;
  const select = $("camera-select");
  const cameras = state.cameras.filter((c) => !cityId || c.cityId === cityId);
  select.innerHTML = cameras
    .map(
      (c) =>
        `<option value="${c.id}">${c.city} · ${c.name} [${c.feedType}]</option>`,
    )
    .join("");
}

$("city-filter").addEventListener("change", fillCameraSelect);

/* ------------------------------------------------------------------ */
/* Capture & sampel                                                    */
/* ------------------------------------------------------------------ */

async function capture() {
  const cameraId = $("camera-select").value;
  if (!cameraId) {
    setStatus("PILIH KAMERA DULU", "error");
    return;
  }
  const captureBtn = $("capture-btn");
  captureBtn.disabled = true;
  setStatus("MENGAMBIL BINGKAI", "busy");
  try {
    const payload = await api("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cameraId }),
    });
    await loadSample(payload.sampleId);
    await refreshSamples();
    await refreshStats();
  } catch (err) {
    setStatus(`CAPTURE GAGAL: ${err.message}`.slice(0, 60), "error");
  } finally {
    captureBtn.disabled = false;
  }
}

$("capture-btn").addEventListener("click", capture);

function toggleAuto() {
  const btn = $("auto-btn");
  const on = btn.getAttribute("aria-pressed") !== "true";
  btn.setAttribute("aria-pressed", String(on));
  btn.textContent = on ? "AUTO AKTIF" : "AUTO MATI";
  clearInterval(state.autoTimer);
  state.autoTimer = null;
  if (on) {
    capture();
    state.autoTimer = setInterval(capture, 20000);
  }
}

$("auto-btn").addEventListener("click", toggleAuto);

async function loadSample(id) {
  const payload = await api(`/api/samples/${id}`);
  state.currentSample = payload;
  state.boxes = (payload.boxes || []).map((b) => ({
    className: b.className,
    xc: b.xc,
    yc: b.yc,
    ww: b.ww,
    hh: b.hh,
    conf: b.conf,
    source: b.source,
  }));
  state.selected = state.boxes.length ? 0 : -1;
  const image = new Image();
  image.onload = () => {
    state.image = image;
    $("canvas-empty").style.display = "none";
    fitCanvasAndDraw();
    syncBoxList();
    syncActionButtons();
    $("editor-title").textContent =
      `#${payload.id} · ${payload.cameraName || payload.cameraId}` +
      ` · ${payload.city} · ${payload.width}×${payload.height}` +
      ` · ${state.boxes.length} kotak · ${payload.status}`;
    setStatus(payload.status === "approved" ? "DISETUJUI" : "PENDING — KOREKSI LALU SIMPAN", "ok");
  };
  image.onerror = () => setStatus("GAMBAR GAGAL DIMUAT", "error");
  image.src = `${payload.imageUrl}?t=${Date.now()}`;
}

function syncActionButtons() {
  const has = !!state.currentSample;
  $("save-btn").disabled = !has;
  $("skip-btn").disabled = !has;
  $("delete-box-btn").disabled = state.selected < 0;
}

/* ------------------------------------------------------------------ */
/* Simpan / buang                                                      */
/* ------------------------------------------------------------------ */

$("save-btn").addEventListener("click", async () => {
  if (!state.currentSample) return;
  setStatus("MENYIMPAN", "busy");
  try {
    // Kelas kotak terpilih mengikuti input kelas bila diubah operator.
    const classInput = $("class-input").value.trim() || "person";
    if (state.selected >= 0 && state.boxes[state.selected]) {
      state.boxes[state.selected].className = classInput;
    }
    await api(`/api/samples/${state.currentSample.id}/boxes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boxes: state.boxes, status: "approved" }),
    });
    setStatus("TERSIMPAN & DISETUJUI", "ok");
    await loadSample(state.currentSample.id);
    await refreshSamples();
    await refreshStats();
  } catch (err) {
    setStatus(`GAGAL SIMPAN: ${err.message}`.slice(0, 60), "error");
  }
});

$("skip-btn").addEventListener("click", async () => {
  if (!state.currentSample) return;
  try {
    await api(`/api/samples/${state.currentSample.id}`, { method: "DELETE" });
  } catch (err) {
    setStatus(`GAGAL MENGHAPUS: ${err.message}`.slice(0, 60), "error");
    return;
  }
  state.currentSample = null;
  state.boxes = [];
  state.image = null;
  state.selected = -1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $("canvas-empty").style.display = "";
  $("editor-title").textContent = "Belum ada sampel — pilih kamera lalu CAPTURE";
  setStatus("SAMPEL DIBUANG", "ok");
  syncBoxList();
  syncActionButtons();
  await refreshSamples();
  await refreshStats();
});

/* ------------------------------------------------------------------ */
/* Canvas editor                                                       */
/* ------------------------------------------------------------------ */

function fitCanvasAndDraw() {
  if (!state.image) return;
  const wrap = $("canvas-wrap");
  const maxW = wrap.clientWidth - 4;
  const maxH = wrap.clientHeight - 4;
  const scale = Math.min(maxW / state.image.width, maxH / state.image.height, 1.6);
  canvas.width = Math.round(state.image.width * scale);
  canvas.height = Math.round(state.image.height * scale);
  draw();
}

window.addEventListener("resize", fitCanvasAndDraw);

const HANDLE = 7; // ukuran handle sudut (px canvas)

function boxRectPx(box) {
  return {
    x: (box.xc - box.ww / 2) * canvas.width,
    y: (box.yc - box.hh / 2) * canvas.height,
    w: box.ww * canvas.width,
    h: box.hh * canvas.height,
  };
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.image) return;
  ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);
  state.boxes.forEach((box, index) => {
    const rect = boxRectPx(box);
    const selected = index === state.selected;
    ctx.strokeStyle = selected ? "#ffd166" : "rgba(37, 99, 235, 0.95)";
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    // label
    const confText =
      box.conf != null ? ` ${Math.round(box.conf * 100)}%` : "";
    const label = `${box.className}${confText}${box.source === "human" ? " ✎" : ""}`;
    ctx.font = "11px monospace";
    const tw = ctx.measureText(label).width;
    const ly = Math.max(0, rect.y - 15);
    ctx.fillStyle = selected ? "rgba(255, 209, 102, 0.95)" : "rgba(37, 99, 235, 0.95)";
    ctx.fillRect(rect.x, ly, tw + 8, 15);
    ctx.fillStyle = "#04070b";
    ctx.fillText(label, rect.x + 4, ly + 11);
    // handle sudut pada kotak terpilih
    if (selected) {
      ctx.fillStyle = "#ffd166";
      for (const [hx, hy] of handlePositions(rect)) {
        ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
      }
    }
  });
}

function handlePositions(rect) {
  return [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
  ];
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function normalizedBox(p1, p2) {
  const x1 = Math.min(p1.x, p2.x) / canvas.width;
  const x2 = Math.max(p1.x, p2.x) / canvas.width;
  const y1 = Math.min(p1.y, p2.y) / canvas.height;
  const y2 = Math.max(p1.y, p2.y) / canvas.height;
  return {
    className: $("class-input").value.trim() || "person",
    xc: (x1 + x2) / 2,
    yc: (y1 + y2) / 2,
    ww: Math.max(0.004, x2 - x1),
    hh: Math.max(0.004, y2 - y1),
    conf: null,
    source: "human",
  };
}

function hitHandle(point) {
  if (state.selected < 0) return -1;
  const rect = boxRectPx(state.boxes[state.selected]);
  return handlePositions(rect).findIndex(
    ([hx, hy]) => Math.abs(point.x - hx) <= HANDLE && Math.abs(point.y - hy) <= HANDLE,
  );
}

function hitBox(point) {
  for (let i = state.boxes.length - 1; i >= 0; i--) {
    const rect = boxRectPx(state.boxes[i]);
    if (
      point.x >= rect.x - 3 &&
      point.x <= rect.x + rect.w + 3 &&
      point.y >= rect.y - 3 &&
      point.y <= rect.y + rect.h + 3
    ) {
      return i;
    }
  }
  return -1;
}

canvas.addEventListener("mousedown", (event) => {
  if (!state.image) return;
  canvas.focus();
  const point = canvasPoint(event);
  const handle = hitHandle(point);
  if (handle >= 0) {
    state.drag = { mode: "resize", handle, start: point, index: state.selected };
    return;
  }
  const hit = hitBox(point);
  if (hit >= 0) {
    state.selected = hit;
    state.drag = { mode: "move", start: point, box: { ...state.boxes[hit] } };
    syncBoxList();
    draw();
    return;
  }
  state.drag = { mode: "draw", start: point };
});

canvas.addEventListener("mousemove", (event) => {
  if (!state.drag || !state.image) return;
  const point = canvasPoint(event);
  const drag = state.drag;
  if (drag.mode === "draw") {
    draw();
    const box = normalizedBox(drag.start, point);
    const rect = boxRectPx(box);
    ctx.strokeStyle = "#8dff87";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.setLineDash([]);
    return;
  }
  if (drag.mode === "move") {
    const dx = (point.x - drag.start.x) / canvas.width;
    const dy = (point.y - drag.start.y) / canvas.height;
    const box = state.boxes[state.selected];
    box.xc = Math.min(1, Math.max(0, drag.box.xc + dx));
    box.yc = Math.min(1, Math.max(0, drag.box.yc + dy));
    box.source = "human";
    box.conf = null;
    draw();
    return;
  }
  if (drag.mode === "resize") {
    const box = state.boxes[state.selected];
    const p1 = { x: drag.start.x, y: drag.start.y };
    // sudut yang berlawanan tetap; sudut terpeg mengikuti kursor
    const rect = boxRectPx({ ...box, xc: 0.5, yc: 0.5, ww: 1, hh: 1 });
    const corners = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    const [cx, cy] = corners[drag.handle];
    const opposite = {
      x: cx === 0 ? rect.x + rect.w : rect.x,
      y: cy === 0 ? rect.y + rect.h : rect.y,
    };
    const newBox = normalizedBox(
      { x: opposite.x, y: opposite.y },
      point,
    );
    box.xc = newBox.xc;
    box.yc = newBox.yc;
    box.ww = newBox.ww;
    box.hh = newBox.hh;
    box.source = "human";
    box.conf = null;
    draw();
  }
});

window.addEventListener("mouseup", (event) => {
  if (!state.drag) return;
  const drag = state.drag;
  state.drag = null;
  if (drag.mode === "draw") {
    const point = canvasPoint(event);
    const box = normalizedBox(drag.start, point);
    // seret terlalu pendek = klik saja → abaikan
    if (box.ww > 0.008 && box.hh > 0.008) {
      state.boxes.push(box);
      state.selected = state.boxes.length - 1;
      syncBoxList();
      refreshClassStats();
      syncActionButtons();
    }
  }
  draw();
});

canvas.addEventListener("keydown", (event) => {
  if (event.key === "Delete" || event.key === "Backspace") {
    if (state.selected >= 0) {
      state.boxes.splice(state.selected, 1);
      state.selected = Math.min(state.selected, state.boxes.length - 1);
      syncBoxList();
      refreshClassStats();
      syncActionButtons();
      draw();
    }
    event.preventDefault();
  }
});

$("delete-box-btn").addEventListener("click", () => {
  if (state.selected < 0) return;
  state.boxes.splice(state.selected, 1);
  state.selected = Math.min(state.selected, state.boxes.length - 1);
  syncBoxList();
  refreshClassStats();
  syncActionButtons();
  draw();
});

/* ------------------------------------------------------------------ */
/* Panel kotak & kelas                                                 */
/* ------------------------------------------------------------------ */

function syncBoxList() {
  const list = $("box-list");
  list.innerHTML = state.boxes
    .map((box, index) => {
      const conf =
        box.conf != null ? `${Math.round(box.conf * 100)}%` : "—";
      const selected = index === state.selected ? " class=\"selected\"" : "";
      return `<li data-index="${index}"${selected}>
        <span class="cls">${box.className}</span>
        <span class="conf">${conf}</span>
        <span class="src">${box.source === "human" ? "✎ manusia" : "🤖 yolo"}</span>
      </li>`;
    })
    .join("");
  refreshClassStats();
}

$("box-list").addEventListener("click", (event) => {
  const item = event.target.closest("li[data-index]");
  if (!item) return;
  state.selected = Number(item.dataset.index);
  $("class-input").value = state.boxes[state.selected].className;
  syncBoxList();
  syncActionButtons();
  draw();
});

function refreshClassStats() {
  const counts = {};
  for (const box of state.boxes) {
    counts[box.className] = (counts[box.className] || 0) + 1;
  }
  $("class-stats").innerHTML = Object.entries(counts)
    .map(([name, count]) => `<li><span>${name}</span><b>${count}</b></li>`)
    .join("");
}

/* ------------------------------------------------------------------ */
/* Sampel & statistik                                                  */
/* ------------------------------------------------------------------ */

async function refreshSamples() {
  const payload = await api("/api/samples");
  const list = $("sample-list");
  list.innerHTML = (payload.samples || [])
    .map(
      (s) => `<li data-id="${s.id}" class="${state.currentSample?.id === s.id ? "selected" : ""}">
        <span>#${s.id} ${s.city || s.cameraId}</span>
        <span class="badge ${s.status}">${s.status === "approved" ? "✓" : "•"} ${s.status}</span>
      </li>`,
    )
    .join("");
}

$("sample-list").addEventListener("click", async (event) => {
  const item = event.target.closest("li[data-id]");
  if (!item) return;
  await loadSample(Number(item.dataset.id));
  await refreshSamples();
});

async function refreshStats() {
  const stats = await api("/api/stats");
  $("stat-samples").textContent = stats.samples;
  $("stat-approved").textContent = stats.approved;
  $("stat-boxes").textContent = stats.boxes;
  $("stat-human").textContent = stats.humanEditedBoxes;
}

/* ------------------------------------------------------------------ */
/* Mulai                                                               */
/* ------------------------------------------------------------------ */

loadCameras().then(() => {
  refreshSamples();
  refreshStats();
  // Kolektor mungkin sudah berjalan sebelum halaman dimuat — sinkronkan UI.
  pollCollector().then(() => {
    const btn = $("collector-btn");
    btn.setAttribute("data-running", $("coll-status").textContent === "BERHENTI" ? "0" : "1");
    if (btn.getAttribute("data-running") === "1" && !collectorPollTimer) {
      collectorPollTimer = setInterval(pollCollector, 3000);
    }
  });
});
