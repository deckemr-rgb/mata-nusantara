# syntax=docker/dockerfile:1

# =============================================================================
# PRI NUSANTARA
#
# Dua hal tentang aplikasi ini menentukan bentuk berkas ini, dan keduanya tidak
# kentara:
#
# 1. RUNTIME-NYA BUKAN SERVER STATIS, DAN BUKAN PULA HANYA PRODUCTION DEPS.
#    Seluruh lapisan CCTV melewati proxy di /api/cctv/*, dan proxy itu berupa
#    plugin Vite yang didaftarkan pada server preview. Artinya yang menyajikan
#    aplikasi ini adalah `vite preview` -- dan `vite` ada di devDependencies.
#    Jadi `npm ci --omit=dev` pada tahap runtime akan menghasilkan kontainer
#    yang gagal start. node_modules dibawa utuh, disengaja.
#
# 2. KUNCI API DISUNTIKKAN SAAT BUILD, BUKAN SAAT JALAN.
#    GOOGLE_MAPS_API_KEY dan CESIUM_ION_TOKEN masuk lewat `define` Vite, yang
#    mengganti teksnya di dalam bundel ketika dibangun. Memberikannya sebagai
#    variabel lingkungan runtime tidak akan berpengaruh apa pun -- bundelnya
#    sudah jadi. Karena itu keduanya berupa ARG di tahap pembangun.
#    Aplikasi berjalan penuh tanpa satu pun kunci, termasuk seluruh CCTV
#    Indonesia; keduanya hanya menambah citra Google dan terrain Cesium.
# =============================================================================


# --- Tahap 1: membangun -------------------------------------------------------
FROM node:24-bookworm-slim AS builder

# Debian, bukan Alpine. sharp (pembuat peta layar pembuka) memakai binari
# prebuilt untuk glibc; di Alpine yang bermusl ia harus dikompilasi sendiri,
# yang menyeret python, make dan g++ ke dalam image.

# Puppeteer hanya dipakai skrip QA. Tanpa baris ini `npm ci` mengunduh Chromium
# sekitar 150 MB yang tidak pernah dijalankan di sini.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# package.json mensyaratkan Node >=24.14 <25 atau >=26 <27. Tag `node:24` ikut
# bergerak; bila suatu hari ia bergeser ke luar rentang itu, gagalnya harus di
# sini dengan pesan yang jelas, bukan berupa galat aneh di tengah build.
RUN node -e "const [a,b]=process.versions.node.split('.').map(Number); if(!((a===24&&b>=14)||a===26)){console.error('Node '+process.versions.node+' di luar engines package.json (>=24.14 <25 || >=26 <27)');process.exit(1);}"

# Manifest lebih dulu, sumber belakangan: selama dependensi tidak berubah,
# lapisan npm ci dipakai ulang dan build ulang hanya memakan hitungan detik.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Diteruskan dari docker-compose.yml. Kosong berarti fitur berbayarnya mati,
# bukan aplikasinya yang mati.
ARG GOOGLE_MAPS_API_KEY=""
ARG CESIUM_ION_TOKEN=""
ENV GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY} \
    CESIUM_ION_TOKEN=${CESIUM_ION_TOKEN}

RUN npm run build


# --- Tahap 2: menjalankan -----------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    HOST=0.0.0.0 \
    PORT=8080

# HOST=0.0.0.0 wajib DI DALAM kontainer. Nilai 127.0.0.1 yang dipakai panduan
# VPS tanpa Docker akan membuat server hanya terdengar di dalam namespace
# jaringan kontainer -- hidup, sehat menurut dirinya sendiri, dan tak terjangkau
# dari mana pun. Yang membatasi akses pada susunan Docker adalah pemetaan porta
# ke 127.0.0.1 di sisi host, bukan nilai ini.

WORKDIR /app

# Hanya /app yang dibawa: cache npm di HOME milik tahap pembangun ditinggalkan.
COPY --from=builder --chown=node:node /app /app

# Beberapa penyedia menulis cache ke ./.gev-cache saat berjalan. Direktorinya
# dibuat dan diserahkan sekarang, selagi masih root; pengguna `node` tidak akan
# bisa membuatnya sendiri di dalam /app nanti.
RUN mkdir -p /app/.gev-cache && chown node:node /app/.gev-cache

USER node

EXPOSE 8080

# Tanpa curl di image; `node -e` sudah ada dan cukup.
#
# Alamat IPv4 harfiah sengaja dipakai: penjaga DNS rebinding Vite selalu
# meloloskan Host berupa alamat IPv4, sehingga pemeriksaan ini tidak ikut gagal
# hanya karena ALLOWED_HOSTS diubah.
#
# start-period panjang karena katalog CCTV ditarik dari portal luar saat start;
# kontainer belum tentu menjawab cepat pada detik-detik pertama.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "preview"]
