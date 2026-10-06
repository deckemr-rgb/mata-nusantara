# PRI NUSANTARA — menjalankan dengan Docker di VPS Hostinger

Panduan menjalankan aplikasi ini sebagai satu kontainer bernama
**`pri-nusantara`** di VPS Hostinger, lengkap dengan domain dan HTTPS.

Baca **[Bagian 0](#0-yang-perlu-diketahui-sebelum-mulai)** lebih dulu. Ada satu
hal di sana yang bila terlewat akan menghapus seluruh isi VPS Anda.

> Untuk menjalankan tanpa Docker (langsung dengan systemd), lihat
> [DEPLOY-VPS.md](DEPLOY-VPS.md). Keduanya menghasilkan hal yang sama; Docker
> membuat pemasangan ulang dan pemindahan server jauh lebih mudah.

---

## 0. Yang perlu diketahui sebelum mulai

### 0.1 JANGAN mengganti template OS bila VPS Anda sudah berisi

hPanel menyediakan template "Ubuntu 24.04 with Docker" yang praktis. Tetapi
dokumentasi Hostinger sendiri menyatakan:

> "Changing or reinstalling the operating system on your VPS will permanently
> delete all your current data, including the snapshot, if there is any."

Artinya: **memasang template Docker akan menghapus habis isi VPS Anda**,
termasuk snapshot yang ada di dalamnya. Bila Anda sudah memasang apa pun di
sana — termasuk aplikasi ini lewat panduan sebelumnya — jangan tempuh jalur itu.

Jalur yang aman ada di [Bagian 1](#1-menyiapkan-docker). Docker dipasang di atas
sistem yang sudah berjalan, tanpa menghapus apa pun. Hasil akhirnya sama saja.

### 0.2 Ini bukan situs statis

Aplikasi ini **butuh Node.js berjalan**, bukan sekadar folder yang disajikan
Nginx. Seluruh lapisan CCTV melewati proxy di `/api/cctv/*` — proxy itulah yang
menulis ulang playlist HLS dan meneruskan segmen videonya. Tanpa dia, kamera
Indonesia tidak akan tampil sama sekali, karena portal ATCS Bandung tidak
mengirim header CORS dan peramban menolak streamnya.

Itu sebabnya yang dijalankan adalah kontainer, bukan hasil `dist/` saja.

### 0.3 Setiap pengunjung membebani server pemerintah daerah

Ketika seseorang membuka kamera Yogyakarta di situs Anda, **server Anda** yang
menarik videonya dari `cctvjss.jogjakota.go.id` lalu meneruskannya. Sepuluh
penonton berarti sepuluh aliran video yang ditarik terus-menerus dari portal
pemda.

Portal itu dibiayai APBD untuk melayani warganya. Bila situs Anda ramai,
batasi jumlah kamera lewat `CCTV_*_MAX_SOURCES`. Bila sebuah portal mulai
memblokir IP Anda, itu jawaban yang wajar — turunkan bebannya, jangan cari
jalan memutar.

### 0.4 Yang Anda butuhkan

| | |
| --- | --- |
| VPS Hostinger | RAM **minimal 2 GB**, disarankan 4 GB |
| Disk kosong | ± 3 GB |
| Domain | sudah diarahkan ke IP VPS (A record) |
| Akses | root, lewat SSH atau Terminal hPanel |

Catatan RAM: yang paling rakus adalah proses `npm run build` di dalam image.
Pada mesin 1 GB ia bisa terbunuh di tengah jalan. [Bagian 1.3](#13-menambah-swap-bila-ram-pas-pasan)
menyediakan jalan keluarnya.

---

## 1. Menyiapkan Docker

### 1.1 Masuk ke VPS

Cara termudah tanpa menyiapkan apa pun: di hPanel buka **VPS → Manage**, lalu
klik **Terminal**. Sebuah sesi SSH terbuka di tab baru, sudah masuk sebagai
`root`.

Dari komputer sendiri juga bisa:

```bash
ssh root@IP_VPS_ANDA
```

### 1.2 Memasang Docker tanpa menghapus apa pun

Periksa dulu — bila VPS Anda memakai template Docker, ini sudah terpasang:

```bash
docker --version && docker compose version
```

Bila keduanya menjawab versi, lewati ke [Bagian 2](#2-mengambil-kode).

Bila belum, pasang dengan skrip resmi Docker. Ini **tidak** menghapus data:

```bash
curl -fsSL https://get.docker.com | sh
```

Nyalakan dan pastikan hidup setelah reboot:

```bash
systemctl enable --now docker && docker run --rm hello-world
```

Baris terakhir menarik image kecil dan menjalankannya. Bila ia mencetak "Hello
from Docker!", Docker Anda sehat.

### 1.3 Menambah swap bila RAM pas-pasan

Lewati bila RAM VPS Anda 4 GB atau lebih. Periksa dulu:

```bash
free -h
```

Bila `Mem` total di bawah 4 GB dan `Swap` masih 0, tambahkan 2 GB swap:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Swap memang lebih lambat daripada RAM, tetapi build yang lambat jauh lebih baik
daripada build yang terbunuh di tengah jalan.

---

## 2. Mengambil kode

```bash
git clone https://github.com/faris315mfaf-ai/gods-eye-view.git /opt/pri-nusantara && cd /opt/pri-nusantara
```

Seluruh perintah selanjutnya dijalankan dari `/opt/pri-nusantara`.

---

## 3. Berkas `.env`

Ini satu-satunya berkas yang perlu Anda sunting. Buat dengan:

```bash
cat > /opt/pri-nusantara/.env <<'EOF'
ALLOWED_HOSTS=pri.contoh.id,www.pri.contoh.id
HOST_PORT=8080
EOF
```

Ganti `pri.contoh.id` dengan domain Anda yang sebenarnya.

| Variabel | Arti |
| --- | --- |
| `ALLOWED_HOSTS` | **Wajib.** Domain yang dilayani, dipisah koma. Vite menolak Host yang tak dikenalnya — pertahanan terhadap DNS rebinding. Tanpa ini domain Anda dijawab `403 Blocked request` dan tidak ada petunjuk lain |
| `HOST_PORT` | Porta di mesin host yang dipakai Nginx menghubungi kontainer. Ubah bila 8080 sudah terpakai |

Kunci API bersifat opsional; daftar lengkapnya ada di `.env.example`. Aplikasi
berjalan penuh tanpa satu pun kunci, **termasuk seluruh 250 kamera Indonesia**.

> **`HOST` sengaja tidak ada di sini.** Di dalam kontainer nilainya harus
> `0.0.0.0`, dan `docker-compose.yml` sudah memaksanya. Menyalin
> `HOST=127.0.0.1` dari panduan non-Docker ke sini adalah kesalahan yang paling
> sering terjadi dan paling membingungkan: kontainernya hidup, sehat menurut
> dirinya sendiri, dan tidak terjangkau dari mana pun.

> `.env` sudah masuk `.gitignore` dan `.dockerignore`. Jangan pernah
> meng-commit-nya, dan ia memang tidak ikut masuk ke dalam image.

### Bila Anda punya kunci Google Maps atau Cesium

Keduanya disuntikkan **saat image dibangun**, bukan saat kontainer berjalan —
Vite mengganti teksnya di dalam bundel. Menambahkannya ke `.env` setelah image
jadi tidak akan berpengaruh apa pun. Tambahkan sebelum membangun:

```bash
echo 'GOOGLE_MAPS_API_KEY=isi_kunci_anda' >> /opt/pri-nusantara/.env
```

Bila Anda menambahkannya belakangan, bangun ulang dengan `--build` (Bagian 8).

---

## 4. Menjalankan

```bash
cd /opt/pri-nusantara && docker compose up -d --build
```

Pembangunan pertama memakan **5–15 menit**: ia mengunduh image Node, memasang
dependensi, lalu membangun bundel. Pembangunan berikutnya jauh lebih cepat
karena lapisan dependensinya dipakai ulang.

Melihat prosesnya:

```bash
docker compose logs -f
```

Memeriksa keadaannya:

```bash
docker compose ps
```

Kolom `STATUS` harus berbunyi `Up ... (healthy)`. Statusnya mulai dari
`health: starting` selama kira-kira satu setengah menit — itu wajar, katalog
CCTV sedang ditarik dari portal luar.

---

## 5. Nginx dan HTTPS

Nginx dijalankan di mesin host, bukan di dalam Docker. Dengan begitu `certbot`
dapat mengurus sertifikat secara otomatis tanpa tambahan apa pun.

```bash
apt-get update && apt-get install -y nginx
```

Buat `/etc/nginx/sites-available/pri-nusantara`:

```bash
cat > /etc/nginx/sites-available/pri-nusantara <<'EOF'
server {
    listen 80;
    server_name pri.contoh.id www.pri.contoh.id;

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
EOF
```

Ganti `pri.contoh.id` dengan domain Anda, di kedua tempat.

`proxy_set_header Host $host` itu penting: nilai itulah yang dicocokkan dengan
`ALLOWED_HOSTS` Anda.

Aktifkan:

```bash
ln -sf /etc/nginx/sites-available/pri-nusantara /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
```

Bila domain Anda masih menampilkan halaman sambutan bawaan Nginx, situs
`default` masih aktif dan mendahului milik Anda. Matikan — perintah ini hanya
melepas tautan halaman sambutan itu, bukan menghapus situs lain:

```bash
rm -f /etc/nginx/sites-enabled/default && nginx -t && systemctl reload nginx
```

Pasang sertifikat:

```bash
apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d pri.contoh.id -d www.pri.contoh.id
```

Certbot menyunting sendiri berkas di atas menjadi HTTPS dan memasang pembaruan
otomatis.

---

## 6. Firewall — ada dua lapis, dan ini sering terlewat

Hostinger punya firewall sendiri di hPanel, **terpisah** dari firewall di dalam
VPS. Bila salah satunya menutup sebuah porta, porta itu tertutup — tidak peduli
yang satunya mengizinkan.

**Lapis pertama, di hPanel:** buka **VPS → Security → Firewall**, lalu izinkan
masuk ke porta **22** (SSH), **80** (HTTP) dan **443** (HTTPS).

**Lapis kedua, di dalam VPS:**

```bash
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

Porta aplikasi (8080) **tidak** perlu dibuka di mana pun. `docker-compose.yml`
memetakannya hanya ke `127.0.0.1`, jadi yang dapat menghubunginya cuma Nginx,
dari mesin yang sama.

> **Docker menembus ufw, dan ini penting.** Porta yang dipublikasikan Docker
> memasang aturan iptables-nya sendiri yang memotong rantai INPUT ufw. Artinya
> `ufw deny 8080` **tidak** akan melindungi porta yang dipublikasikan Docker ke
> seluruh antarmuka.
>
> Yang melindungi Anda di sini bukan ufw, melainkan awalan `127.0.0.1:` pada
> pemetaan porta. Bila Anda mengubahnya menjadi `"8080:8080"`, aplikasi ini
> akan terbuka ke seluruh internet tanpa HTTPS — dan ufw tidak akan
> menghentikannya. Biarkan awalan itu.

> Jalankan `ufw allow OpenSSH` **sebelum** `ufw enable`. Terbalik urutannya,
> Anda akan terkunci di luar VPS sendiri — meski Terminal hPanel biasanya masih
> bisa menyelamatkan.

---

## 7. Memastikan berhasil

Dari dalam VPS:

```bash
curl -s -o /dev/null -w "halaman: %{http_code}\n" -H "Host: pri.contoh.id" http://127.0.0.1:8080/
```

```bash
curl -s -o /dev/null -w "API CCTV: %{http_code}\n" -H "Host: pri.contoh.id" http://127.0.0.1:8080/api/cctv/sources
```

Keduanya harus menjawab `200`. Bila halaman menjawab **403**, domainnya belum
tercantum di `ALLOWED_HOSTS`.

Menghitung kamera Indonesia yang benar-benar termuat:

```bash
curl -s -H "Host: pri.contoh.id" http://127.0.0.1:8080/api/cctv/sources | grep -o '"city":"[^"]*"' | grep -ciE 'jakarta|bandung|yogya'
```

Jawaban yang sehat berkisar **250**.

Dari peramban, buka domain Anda dan periksa tiga hal:

1. Peta pembuka merah putih muncul di atas Nusantara lalu memudar.
2. Tekan `C` — lapisan CCTV menyala dan kamera bermunculan.
3. Pilih satu kamera Yogyakarta lalu **LAYAR PENUH** — videonya harus jalan.
   Bila langkah 3 gagal sementara 1 dan 2 berhasil, yang bermasalah adalah
   proxy, bukan hasil build.

---

## 8. Memperbarui

```bash
cd /opt/pri-nusantara && git pull && docker compose up -d --build
```

Docker membangun image baru lebih dulu, baru mengganti kontainernya. Waktu mati
hanya beberapa detik saat pergantian.

Bila Anda mengubah merek (`config/brand.json`) atau peta pembuka, `--build`
wajib — keduanya diterapkan saat build, bukan saat dijalankan.

---

## 9. Perintah harian

| Keperluan | Perintah |
| --- | --- |
| Menjalankan | `docker compose up -d` |
| Menghentikan | `docker compose stop` |
| Memulai ulang | `docker compose restart` |
| Melihat catatan | `docker compose logs -f` |
| Keadaan dan kesehatan | `docker compose ps` |
| Masuk ke dalam kontainer | `docker compose exec app sh` |
| Membangun ulang penuh | `docker compose up -d --build` |
| Membuang semuanya | `docker compose down` |
| Membuang berikut cache-nya | `docker compose down -v` |
| Merapikan image lama | `docker image prune -f` |

> `docker compose down -v` juga menghapus volume cache. Tidak berbahaya —
> cache itu akan terisi kembali sendiri — tetapi beberapa menit pertama
> sesudahnya akan terasa lebih lambat.

---

## 10. Bila ada yang tidak jalan

| Gejala | Sebab yang paling sering |
| --- | --- |
| `403 Blocked request` | Domain belum ada di `ALLOWED_HOSTS`, atau Nginx tidak meneruskan header `Host` |
| Kontainer terus memulai ulang | Lihat `docker compose logs`; paling sering `.env` salah tulis |
| Build terbunuh, pesan `killed` | Kehabisan RAM — tambahkan swap, [Bagian 1.3](#13-menambah-swap-bila-ram-pas-pasan) |
| `502 Bad Gateway` dari Nginx | Kontainer belum siap; tunggu, atau `docker compose ps` |
| Domain tidak terjangkau sama sekali | Firewall hPanel, [Bagian 6](#6-firewall--ada-dua-lapis-dan-ini-sering-terlewat) |
| `port is already allocated` | Porta 8080 dipakai layanan lain; ubah `HOST_PORT` di `.env` |
| Globe jalan, kamera kosong | Portal sumbernya sedang mati, atau IP VPS Anda diblokir portal itu |
| Kamera kadang gagal kadang jalan | Portal membuang paket SYN saat sibuk — sudah ditangani aplikasi; lihat [DEPLOY-VPS.md Bagian 9.1](DEPLOY-VPS.md#91-kamera-yang-gagalnya-berpindah-pindah) |

Memeriksa porta yang sudah terpakai sebelum menjalankan:

```bash
ss -ltnp | grep -E ':(80|443|8080)\b'
```

Memeriksa apakah portal sumbernya yang bermasalah, bukan server Anda:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://cctvjss.jogjakota.go.id/atcs/ATCS_pkumuh.stream/playlist.m3u8
```

---

## 11. Mengganti nama dan merek

Nama `pri-nusantara` di panduan ini hanyalah nama **image, kontainer dan
folder** — nama di tingkat Docker. Merek yang terlihat di layar diatur terpisah
di `config/brand.json`, dan saat ini berbunyi **MATA NUSANTARA**.

Untuk menyamakannya, sunting `config/brand.json` lalu bangun ulang dengan
`--build`. Panduan lengkapnya ada di [WHITELABEL.md](WHITELABEL.md).

Untuk mengganti nama Docker-nya saja, ubah `name:`, `image:` dan
`container_name:` di `docker-compose.yml`.

---

## 12. Ringkasan

| Keperluan | Perintah atau berkas |
| --- | --- |
| Pasang Docker | `curl -fsSL https://get.docker.com \| sh` |
| Ambil kode | `git clone … /opt/pri-nusantara` |
| Konfigurasi | `.env` → `ALLOWED_HOSTS`, `HOST_PORT` |
| Jalankan | `docker compose up -d --build` |
| HTTPS | Nginx di host + certbot |
| Firewall | hPanel **dan** `ufw` — keduanya |
| Perbarui | `git pull && docker compose up -d --build` |
| Catatan jalan | `docker compose logs -f` |

---

## Sumber

Langkah khusus Hostinger di atas mengacu pada dokumentasi resmi mereka:

- [How to use the Docker VPS template at Hostinger](https://www.hostinger.com/support/8306612-how-to-use-the-docker-vps-template-at-hostinger/)
- [How to change the operating system of your VPS at Hostinger](https://www.hostinger.com/support/4965922-how-to-change-the-operating-system-of-your-vps-at-hostinger/)
- [How to connect to your VPS via SSH at Hostinger](https://www.hostinger.com/support/5723772-how-to-connect-to-your-vps-via-ssh-at-hostinger/)
- [How to use a managed VPS firewall at Hostinger](https://support.hostinger.com/en/articles/8172641-how-to-use-a-managed-vps-firewall)
