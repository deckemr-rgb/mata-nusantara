# Menjalankan di VPS

Panduan menaruh aplikasi ini di server sendiri sehingga dapat diakses lewat
domain.

Baca **[Bagian 0](#0-yang-perlu-diketahui-sebelum-mulai)** lebih dulu — ada tiga
hal yang lebih baik diketahui sebelum server menyala, bukan sesudah.

> Lebih suka Docker? Lihat
> [DOCKER-PRI-NUSANTARA.md](DOCKER-PRI-NUSANTARA.md), yang menjalankan hal yang
> sama sebagai satu kontainer dan memuat langkah khusus VPS Hostinger.

---

## 0. Yang perlu diketahui sebelum mulai

### 0.1 Ini bukan situs statis

Aplikasi ini **butuh Node.js berjalan di server**, bukan sekadar folder yang
disajikan Apache atau Nginx.

Alasannya: seluruh lapisan CCTV melewati proxy di `/api/cctv/*`. Proxy itu yang
menulis ulang playlist HLS dan meneruskan segmen videonya — tanpa dia, kamera
Indonesia tidak akan tampil sama sekali, karena portal ATCS Bandung tidak
mengirim header CORS dan peramban akan menolak streamnya. Menaruh isi `dist/`
saja ke hosting statis menghasilkan globe yang jalan tanpa satu pun kamera.

### 0.2 Setiap pengunjung membebani server pemerintah daerah

Ini bagian yang paling mudah terlewat. Ketika seseorang membuka kamera
Yogyakarta di situs Anda, **server Anda** yang mengambil videonya dari
`cctvjss.jogjakota.go.id`, lalu meneruskannya. Sepuluh pengunjung menonton
sepuluh kamera berarti sepuluh aliran video yang ditarik server Anda dari
portal pemda, terus-menerus.

Portal-portal itu dibiayai APBD dan dibangun untuk melayani warganya, bukan
untuk menjadi sumber video sebuah layanan lain. Bila situs Anda ramai:

- Pertimbangkan membatasi jumlah kamera lewat `CCTV_*_MAX_SOURCES`.
- Awasi trafik keluar server Anda ke domain `.go.id`.
- Bila sebuah portal mulai memblokir alamat IP Anda, itu jawaban yang wajar —
  turunkan bebannya, jangan cari jalan memutar.

### 0.3 Tidak ada kata sandi

Siapa pun yang tahu alamatnya dapat membuka aplikasi ini sepenuhnya. Tidak ada
pendaftaran, tidak ada pembatasan laju, tidak ada pencatatan pengguna. Bila
Anda memerlukan salah satunya, pasang di lapisan Nginx (Bagian 5), bukan di
aplikasi.

---

## 1. Spesifikasi VPS

| | Minimal | Disarankan |
| --- | --- | --- |
| RAM | 2 GB | 4 GB |
| Disk | 5 GB | 10 GB |
| CPU | 1 vCPU | 2 vCPU |
| Node.js | 24.14+ | 24 LTS |

Catatan disk: `node_modules` sekitar **238 MB** dan hasil build `dist` sekitar
**29 MB**. Proses `npm run build` sendiri yang paling banyak memakan RAM —
pada mesin 1 GB ia bisa terbunuh di tengah jalan.

Node harus **24.14 ke atas (bukan 25)** atau **26.x**; ini dikunci di
`package.json`.

---

## 2. Menyiapkan server

Contoh berikut memakai Ubuntu 22.04/24.04 dan pengguna bernama `mata`.

```bash
sudo adduser --disabled-password --gecos "" mata
```

Pasang Node.js 24:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs git
```

Ambil kodenya:

```bash
sudo -u mata git clone https://github.com/faris315mfaf-ai/gods-eye-view.git /home/mata/app
```

Pasang dependensi dan bangun:

```bash
cd /home/mata/app && sudo -u mata npm ci && sudo -u mata npm run build
```

`npm ci` memakai `package-lock.json` apa adanya — itu yang membuat hasil di
server sama persis dengan yang Anda uji.

---

## 3. Berkas konfigurasi

Buat `/home/mata/app/.env`:

```bash
HOST=127.0.0.1
PORT=8080
ALLOWED_HOSTS=mata.contoh.id,www.mata.contoh.id
```

| Variabel | Arti |
| --- | --- |
| `HOST` | Alamat yang didengarkan. Pakai `127.0.0.1` bila ada Nginx di depan (disarankan), atau `0.0.0.0` bila aplikasi diakses langsung |
| `PORT` | Porta aplikasi |
| `ALLOWED_HOSTS` | **Wajib diisi domain Anda.** Vite menolak permintaan dengan Host yang tak dikenalnya — sebuah pertahanan terhadap DNS rebinding. Tanpa ini, domain Anda dijawab `403 Blocked request` |

Kunci API bersifat opsional; daftar lengkapnya ada di `.env.example`. Aplikasi
berjalan penuh tanpa satu pun kunci — termasuk seluruh CCTV Indonesia.

> `.env` sudah masuk `.gitignore`. Jangan pernah meng-commit-nya.

---

## 4. Menjalankan sebagai layanan

Agar aplikasi hidup kembali setelah server dinyalakan ulang atau proses mati,
jalankan lewat systemd. Buat `/etc/systemd/system/mata.service`:

```ini
[Unit]
Description=Mata Nusantara
After=network.target

[Service]
Type=simple
User=mata
WorkingDirectory=/home/mata/app
EnvironmentFile=/home/mata/app/.env
ExecStart=/usr/bin/npm run preview
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Nyalakan:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now mata && sudo systemctl status mata
```

Melihat catatannya:

```bash
sudo journalctl -u mata -f
```

> **Kenapa `npm run preview`, bukan server tersendiri.** Middleware API ini
> berbentuk plugin Vite, dan didaftarkan pada server build maupun server
> pengembangan. `vite preview` karenanya menyajikan aplikasi yang sudah
> dibangun **berikut** seluruh API-nya. Vite sendiri menyebut preview sebagai
> alat pratinjau, bukan peladen produksi kelas berat — untuk situs sepi hingga
> menengah di belakang Nginx itu memadai, tetapi bila trafik Anda tumbuh besar,
> yang perlu dilakukan adalah memindahkan middleware itu ke peladen Node
> tersendiri, bukan menambah beban pada preview.

---

## 5. Nginx dan HTTPS

Nginx di depan aplikasi memberi Anda HTTPS, kompresi, dan tempat memasang
pembatasan bila diperlukan.

`/etc/nginx/sites-available/mata`:

```nginx
server {
    listen 80;
    server_name mata.contoh.id www.mata.contoh.id;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Segmen video HLS berdatangan terus; jangan diputus di tengah aliran.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

`proxy_set_header Host $host` itu penting: nilai itulah yang dicocokkan Vite
dengan `ALLOWED_HOSTS` Anda.

Aktifkan dan pasang sertifikat:

```bash
sudo ln -s /etc/nginx/sites-available/mata /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo apt-get install -y certbot python3-certbot-nginx && sudo certbot --nginx -d mata.contoh.id -d www.mata.contoh.id
```

Certbot menyunting sendiri berkas Nginx di atas menjadi HTTPS dan memasang
pembaruan otomatis.

---

## 6. Firewall

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

Porta aplikasi (8080) **tidak** perlu dibuka: yang menghubunginya hanya Nginx,
dari dalam mesin yang sama.

---

## 7. Memperbarui

```bash
cd /home/mata/app && sudo -u mata git pull && sudo -u mata npm ci && sudo -u mata npm run build && sudo systemctl restart mata
```

Bila Anda mengubah merek atau peta pembuka, jalankan build ulang seperti di
atas — keduanya diterapkan pada saat build, bukan saat dijalankan.

---

## 8. Memastikan berhasil

Dari dalam server:

```bash
curl -s -o /dev/null -w "halaman: %{http_code}\n" -H "Host: mata.contoh.id" http://127.0.0.1:8080/
```

```bash
curl -s -o /dev/null -w "API CCTV: %{http_code}\n" -H "Host: mata.contoh.id" http://127.0.0.1:8080/api/cctv/sources
```

Keduanya harus menjawab `200`. Bila halaman menjawab **403**, domainnya belum
tercantum di `ALLOWED_HOSTS`.

Dari peramban, buka domain Anda dan periksa tiga hal:

1. Peta pembuka merah putih muncul di atas Nusantara lalu memudar.
2. Tekan `C` — lapisan CCTV menyala dan kamera bermunculan.
3. Pilih satu kamera Yogyakarta lalu **LAYAR PENUH** — videonya harus jalan.
   Bila langkah 3 gagal sementara 1 dan 2 berhasil, yang bermasalah adalah
   proxy, bukan hasil build.

---

## 9. Bila ada yang tidak jalan

| Gejala | Sebab yang paling sering |
| --- | --- |
| `403 Blocked request` | Domain belum ada di `ALLOWED_HOSTS` |
| Halaman kosong, tak ada globe | `npm run build` belum dijalankan, atau gagal kehabisan RAM |
| Globe jalan, kamera kosong | Layanan tidak hidup — periksa `journalctl -u mata` |
| Kamera ada, video tidak jalan | Portal sumbernya sedang mati, atau IP server Anda diblokir portal itu |
| Kamera kadang gagal, kadang jalan, kamera yang sama | Portal itu membuang paket SYN saat sedang sibuk; lihat Bagian 9.1 |
| Layanan mati sendiri lalu hidup | Kehabisan RAM; naikkan RAM atau tambahkan swap |

Memeriksa apakah portal sumbernya yang bermasalah, bukan server Anda:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://cctvjss.jogjakota.go.id/atcs/ATCS_pkumuh.stream/playlist.m3u8
```

### 9.1 Kamera yang gagalnya berpindah-pindah

Gejalanya khas: kamera yang sama kadang tampil, kadang menjawab 502, lalu
tampil lagi tanpa ada yang diubah. Itu **bukan** kamera yang mati, dan bukan
pula IP Anda yang diblokir.

Sebagian portal membuang paket SYN ketika sedang padat. Paket yang dibuang
tidak dilaporkan kepada siapa pun -- kernel diam-diam mengirim ulang menurut
tangga tetap, sehingga sambungan baru jadi setelah 1 detik, lalu 3, lalu 7,
lalu 15. Pengukuran ke `cctvjss.jogjakota.go.id` menunjukkan sambungan biasanya
jadi dalam 24-90 milidetik, dan sisanya mendarat tepat di anak tangga itu.

Aplikasi ini sudah menanganinya: sambungan yang tidak menjawab dalam 5 detik
ditinggalkan, lalu dibuka sambungan baru -- yang umumnya tersambung seketika.
Jadi bila gejala ini muncul sesekali, tidak ada yang perlu Anda lakukan.

Yang perlu diperiksa hanya bila gejalanya **terus-menerus**. Itu tandanya beban
yang Anda kirim ke portal itu memang berlebihan, dan jawabannya adalah
menurunkan jumlah kamera lewat `CCTV_*_MAX_SOURCES` (lihat Bagian 0.2), bukan
menaikkan batas waktunya.

---

## 10. Ringkasan

| Keperluan | Perintah atau berkas |
| --- | --- |
| Pasang dan bangun | `npm ci && npm run build` |
| Jalankan | `npm run preview` (lewat systemd) |
| Alamat dan domain | `.env` → `HOST`, `PORT`, `ALLOWED_HOSTS` |
| HTTPS | Nginx + certbot |
| Perbarui | `git pull && npm ci && npm run build && systemctl restart mata` |
| Catatan jalan | `journalctl -u mata -f` |
