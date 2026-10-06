# Melanjutkan di mesin lain (macOS, Linux, Windows)

Panduan singkat memindahkan pekerjaan ini ke komputer lain, atau mengajak orang
lain ikut mengerjakannya.

Seluruh kode ada di Git. Tidak ada yang perlu disalin lewat flash disk, dan
tidak ada rahasia yang perlu dipindahkan — repositori ini tidak menyimpan satu
pun kunci.

---

## 1. Node.js versi yang tepat

`package.json` mensyaratkan **Node >= 24.14 (bukan 25)** atau **26.x**.
Versi lain akan membuat `npm ci` gagal dengan pesan yang tidak menyebut versi
sama sekali, jadi pastikan ini lebih dulu:

```bash
node --version
```

Cara paling tidak merepotkan di macOS adalah lewat `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Buka ulang terminal, lalu:

```bash
nvm install 24 && nvm use 24
```

> Pengguna Homebrew bisa memakai `brew install node@24`. Keduanya sama baik;
> `nvm` lebih mudah bila Anda juga mengerjakan proyek lain dengan versi Node
> berbeda.

---

## 2. Mengambil kode

```bash
git clone https://github.com/faris315mfaf-ai/gods-eye-view.git && cd gods-eye-view
```

Unduhannya sekitar **76 MB** — sebagian besar berupa GIF demo di `docs/media`.
Bila sambungan Anda lambat dan Anda hanya ingin kodenya, ambil riwayat
dangkal saja:

```bash
git clone --depth 1 https://github.com/faris315mfaf-ai/gods-eye-view.git
```

> `--depth 1` membuat `git log` hanya berisi satu commit. Untuk menyunting dan
> mengirim perubahan tetap cukup, tetapi bila nanti Anda butuh riwayat penuh:
> `git fetch --unshallow`.

---

## 3. Memasang dan menjalankan

```bash
npm ci
```

`npm ci` memakai `package-lock.json` apa adanya — itu yang membuat hasil di
mesin baru sama persis dengan yang sudah diuji.

> **Jangan menyalin `node_modules` dari mesin lama.** `sharp` dan `puppeteer`
> memasang binari khusus sistem operasi; folder dari Windows tidak akan jalan
> di macOS. Biarkan `npm ci` yang mengerjakannya.

Memastikan semuanya sehat:

```bash
npm test
```

Menjalankan:

```bash
npm run dev
```

---

## 4. Hal-hal yang hanya terasa di mesin lain

Dua hal di bawah ini sudah ditangani repositori, tetapi baik diketahui agar
tidak membingungkan bila suatu saat muncul.

### Akhir baris

`.gitattributes` memaksa seluruh berkas teks diambil dengan LF di semua sistem
operasi. Ini bukan soal rapi-rapian: puluhan uji membaca berkas sumbernya
sendiri dan mencocokkannya dengan pola yang berpatok pada `\n`. Tanpa
normalisasi itu, clone bersih di Windows gagal pada ujinya sendiri.

Bila Anda melihat seluruh berkas tampak berubah padahal tidak Anda sentuh,
penyebabnya hampir pasti ini:

```bash
git config core.autocrlf false && git rm --cached -r . && git reset --hard
```

### Bit eksekusi pada skrip

`npm run dev:secure` memanggil `./scripts/dev-secure.sh` secara langsung, jadi
berkas itu harus punya bit eksekusi. Windows menyetel `core.filemode=false` dan
tidak pernah merekamnya — artinya skrip baru yang ditambahkan dari Windows akan
sampai ke macOS dalam keadaan tidak bisa dijalankan, sementara penulisnya tidak
melihat ada yang salah.

Bila Anda menambahkan skrip `.sh` baru dari Windows:

```bash
git update-index --chmod=+x scripts/nama-skrip-anda.sh
```

Ada uji yang menjaga ini (`src/ui/repoPortability.test.mjs`), jadi `npm test`
akan memberi tahu Anda sebelum orang lain menemukannya.

---

## 5. Kunci API

Aplikasi berjalan penuh tanpa satu pun kunci, **termasuk seluruh 250 kamera
CCTV Indonesia**. Kunci hanya menambah citra Google dan terrain Cesium.

Bila Anda memakainya, buat `.env` di mesin baru dengan menyalin contohnya:

```bash
cp .env.example .env
```

`.env` tidak pernah masuk Git, jadi ia memang tidak ikut terbawa saat clone —
itu disengaja. Isi ulang di setiap mesin.

---

## 6. Mengirim perubahan

```bash
git add -A && git commit -m "pesan Anda" && git push
```

Bila Anda baru pertama kali push dari mesin ini, GitHub akan meminta kredensial.
Cara paling praktis adalah `gh`:

```bash
brew install gh && gh auth login
```

---

## 7. Bila ada yang tidak jalan

| Gejala | Sebab yang paling sering |
| --- | --- |
| `npm ci` gagal tanpa menyebut versi | Node di luar rentang — periksa `node --version`, lihat Bagian 1 |
| `permission denied: ./scripts/...` | Bit eksekusi hilang — `chmod +x`, lihat Bagian 4 |
| Seluruh berkas tampak berubah | Akhir baris — lihat Bagian 4 |
| Uji gagal pada clone yang bersih | Hampir selalu akhir baris; jalankan perintah di Bagian 4 |
| `npm test` lambat sekali | Ada uji anggaran bingkai yang peka beban; tutup aplikasi berat lain lebih dulu |
| Globe jalan, kamera kosong | Portal sumbernya sedang mati, bukan mesin Anda |
| `refusing to allow ... workflow` saat push | Token Anda tidak punya izin `workflow`. Itu hanya diperlukan bila Anda menyunting `.github/workflows/`. Perbaiki dengan `gh auth refresh -s workflow` |

---

## 8. Panduan lain

| Keperluan | Berkas |
| --- | --- |
| Menjalankan di VPS dengan Docker | [DOCKER-PRI-NUSANTARA.md](DOCKER-PRI-NUSANTARA.md) |
| Menjalankan di VPS tanpa Docker | [DEPLOY-VPS.md](DEPLOY-VPS.md) |
| Mengganti merek dan logo | [WHITELABEL.md](WHITELABEL.md) |
