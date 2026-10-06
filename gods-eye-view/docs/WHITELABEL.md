# Panduan Whitelabel

Cara mengganti nama, logo, dan kata-kata aplikasi ini menjadi merek Anda
sendiri — sambil tetap memenuhi kewajiban lisensi yang melekat pada kode dan
pada data yang ditampilkannya.

Baca **[Bagian 0](#0-yang-tidak-boleh-dihapus)** lebih dulu. Sisanya boleh
Anda ubah sesuka hati.

---

## 0. Yang TIDAK boleh dihapus

Ini bukan soal merek, melainkan syarat hukum. Melanggarnya membuat Anda
kehilangan hak memakai kode atau datanya.

### 0.1 Lisensi MIT kode ini

Berkas [`LICENSE`](../LICENSE) memuat:

```
Copyright (c) 2026 Bilawal Sidhu
```

MIT mengizinkan Anda mengubah, menjual, dan menutup sumber turunan Anda —
**dengan satu syarat**: pemberitahuan hak cipta dan teks lisensi itu ikut
disertakan dalam setiap salinan. Jadi:

- **Jangan** hapus atau ubah `LICENSE`.
- **Boleh** menambahkan hak cipta Anda sendiri untuk bagian yang Anda tulis,
  di bawah hak cipta yang sudah ada.

Contoh yang benar untuk berkas `LICENSE` Anda:

```
MIT License

Copyright (c) 2026 Bilawal Sidhu
Copyright (c) 2026 Nama atau Perusahaan Anda

Permission is hereby granted, free of charge, to any person obtaining a copy
... (sisa teks MIT tidak diubah) ...
```

### 0.2 Kredit penyedia data

Ini kewajiban **terpisah** dari MIT, dan sering disalahpahami. Peta, citra
satelit, dan setiap lapisan data punya lisensinya sendiri yang mensyaratkan
atribusi tampil di aplikasi:

- Logo **Google** / **Google Maps** — wajib oleh Google Maps Platform ToS
- **Cesium ion** — wajib saat memakai token ion
- **OpenStreetMap** — ODbL
- **Esri** — untuk basemap satelit tanpa kunci
- Dan seluruh kredit per-lapisan lainnya

Semuanya tampil di baris kredit kiri-bawah (`#cesium-credits`) dan kotak
"Data attribution" yang bisa dibentangkan. **Jangan sembunyikan baris itu**,
dan jangan hapus pemanggilan `addStaticCredit` di
[`src/data/dataCredits.js`](../src/data/dataCredits.js).

Daftar lengkap kewajiban tiap sumber ada di
[`DATA_SOURCES.md`](../DATA_SOURCES.md). Satu hal yang perlu perhatian khusus
bila Anda memakainya secara komersial: **TeleGeography (kabel bawah laut)
berlisensi NonCommercial** — hapus foldernya atau lisensikan sendiri.

### 0.3 Mencantumkan pengembang asli

Anda berniat tetap mencantumkannya, dan itu memang yang seharusnya. Selain
`LICENSE`, tempat yang wajar untuk itu adalah README Anda:

```markdown
Dibangun di atas [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view)
karya Bilawal Sidhu, berlisensi MIT.
```

---

## 1. Cara cepat: satu berkas

Sebagian besar yang terlihat pengguna diatur dari satu berkas:
**[`config/brand.json`](../config/brand.json)**.

```json
{
  "name": "MATA",
  "nameAccent": "NUSANTARA",
  "documentTitle": "Mata Nusantara",
  "tagline": "PANTAU NEGERI DARI SATU LAYAR",
  "logo": "/logo.svg"
}
```

| Kunci | Mengubah apa |
| --- | --- |
| `name` | Bagian pertama judul besar di layar |
| `nameAccent` | Bagian kedua, tampil dengan warna aksen. Isi `""` bila merek Anda satu kata |
| `documentTitle` | Judul tab peramban dan nama pintasan |
| `tagline` | Baris kecil di bawah judul. Isi `""` untuk menyembunyikannya |
| `logo` | Berkas logo di `public/`. Dipakai untuk logo layar **dan** favicon |
| `splash` | Berkas layar pembuka di `public/`. Memudar penuh dalam 5 detik |

Setelah menyunting, jalankan ulang:

```bash
npm run dev
```

Perubahan berlaku saat build, jadi tidak ada berkas template yang perlu
disentuh.

> **Catatan penting:** bidang yang **tidak** Anda ubah dibiarkan apa adanya.
> Ini disengaja — tagline bawaan diterjemahkan oleh kamus bahasa Indonesia,
> dan menuliskannya ulang justru akan membatalkan terjemahan itu. Begitu Anda
> mengisi tagline sendiri, teks Anda yang menang.

---

## 2. Mengganti logo

Logo dipakai di tiga tempat sekaligus (judul layar, layar pemuatan, favicon),
dan ketiganya membaca berkas yang sama.

**Cara termudah:** timpa [`public/logo.svg`](../public/logo.svg) dengan berkas
Anda, dengan nama yang sama. Tidak perlu mengubah apa pun.

**Bila ingin nama berkas lain:** taruh di `public/`, lalu tulis namanya di
`config/brand.json`:

```json
{ "logo": "/logo-perusahaan.svg" }
```

Yang perlu diperhatikan pada berkas logo:

- **SVG lebih disarankan** — dipakai juga sebagai favicon dan harus tetap tajam
  pada ukuran 16 px maupun besar. PNG bisa, tapi favicon-nya akan buram.
- Logo bawaan punya elemen ber-`id` **`globe`** dan **`globe_cage`** yang
  dianimasikan mengikuti kursor oleh
  [`src/logoGaze.js`](../src/logoGaze.js). Bila logo Anda tidak punya id itu,
  animasinya tidak berjalan — **tidak ada yang rusak**, logonya hanya diam.
  Bila Anda ingin efek itu, beri id `globe` pada bagian yang boleh bergerak.
- Untuk mematikan efek kursor sepenuhnya, hapus atribut `data-logo-gaze` pada
  kedua template di Bagian 5.

---

## 2b. Mengganti layar pembuka (splash)

Layar pembuka bawaan adalah peta Nusantara merah putih yang memudar penuh
dalam 5 detik. Gambarnya satu berkas:
[`public/splash.svg`](../public/splash.svg).

**Cara termudah:** timpa berkas itu dengan gambar Anda, nama tetap sama.

**Bila ingin nama atau format lain:** taruh di `public/`, lalu tulis namanya di
`config/brand.json`:

```json
{ "splash": "/pembuka-saya.gif" }
```

Format apa pun bisa — SVG, PNG, JPG, GIF animasi. **Memudarnya diurus CSS,
bukan berkas gambarnya**, jadi lima detik itu tetap berjalan sama untuk format
apa pun. Ini juga alasan splash bawaan dibuat SVG statis, bukan GIF: animasi di
dalam berkas gambarnya tidak diperlukan, dan SVG tetap tajam di layar mana pun
pada ukuran 30 KB.

### Mengubah durasi atau gerak memudarnya

Ada di aturan `.splash-screen` dalam
[`src/ui/styles/foundation.css`](../src/ui/styles/foundation.css):

```css
animation: splash-fade 5s cubic-bezier(0.37, 0, 0.28, 1) forwards;
```

Angka `5s` adalah durasinya. `cubic-bezier` adalah kurva geraknya — nilai itu
dipilih agar memudarnya terasa halus sejak awal, bukan jatuh mendadak di akhir.

Satu hal yang perlu diketahui: bagi pengguna yang menyalakan **"kurangi gerak"**
di setelan sistemnya, durasinya otomatis menjadi 0,6 detik. Itu disengaja dan
sebaiknya dibiarkan.

### Membangun ulang peta bawaan

Peta Nusantara itu dibangkitkan dari data Natural Earth (domain publik) yang
sudah ada di repositori, bukan digambar tangan:

```bash
node scripts/build-splash-map.mjs
```

Jalankan bila Anda ingin mengubah pulau yang digambar, warnanya, atau
bingkainya — semuanya diatur di bagian atas berkas skrip tersebut.

> **Catatan batas wilayah.** Papua dipotong tepat di 141°BT, yang memang batas
> sesungguhnya dengan Papua Nugini. Batas Kalimantan dengan Malaysia
> **didekatkan dengan dua garis lurus**, karena batas aslinya berkelok
> mengikuti punggung pegunungan dan tidak tersedia di data ini. Cukup benar
> untuk sebuah siluet, tetapi jangan dipakai sebagai rujukan batas resmi.

---

## 3. Mengubah kata-kata antarmuka

Seluruh teks antarmuka berasal dari satu kamus:
**[`src/ui/i18n/id.json`](../src/ui/i18n/id.json)**.

Formatnya `"teks sumber bahasa Inggris": "teks yang tampil"`:

```json
{
  "DATA LAYERS": "LAPISAN DATA",
  "CCTV camera": "Kamera CCTV"
}
```

Untuk mengubah kata mana pun, cari nilainya dan tulis ulang. Kuncinya (sisi
kiri) **jangan diubah** — itulah yang dicocokkan dengan markup.

Tiga hal yang sengaja **tidak** diterjemahkan, dan sebaiknya tetap begitu:

1. **Nama penyedia data** (OpenSky, AISStream, Open-Meteo) — nama diri.
2. **Singkatan teknis** (HUD, CCTV, FOV, NVG, FLIR) — lazim dipakai apa adanya.
3. **Ligatur ikon Material** (`my_location`, `adjust`) — menerjemahkannya
   membuat ikon gagal terbentuk dan yang tampil justru tulisannya.

Sebagian label ditulis langsung oleh JavaScript sehingga tidak melewati kamus.
Yang utama ada di
[`src/ui/cctvPresentation.js`](../src/ui/cctvPresentation.js) (label tombol
panel CCTV). Ubah langsung di berkasnya bila perlu.

---

## 4. Identitas teknis (opsional)

Tidak terlihat pengguna, tetapi terkirim ke pihak lain.

### 4.1 User-Agent ke API publik

Aplikasi memperkenalkan diri saat memanggil API publik. Nilainya tersebar di
`server/providers/`:

```bash
grep -rn "gods-eye-view" server/providers/
```

Anda akan menemukan pola seperti `'gods-eye-view-cctv-proxy/1.0'`. Mengubahnya
menjadi nama Anda itu wajar.

> **Jangan menyamarkannya sebagai peramban.** Beberapa penyedia (OpenSky,
> adsb.lol) mengharapkan klien memperkenalkan diri dengan jujur, dan beberapa
> portal memblokir klien yang berpura-pura. Pakai nama Anda sendiri, misalnya
> `mata-nusantara-cctv-proxy/1.0`.

### 4.2 Nama paket

[`package.json`](../package.json) → `"name"`. Hanya memengaruhi npm, bukan
tampilan.

### 4.3 Perintah ke model AI

Bila Anda memakai fitur suara, nama produk disebutkan ke model di
[`server/providers/openai/instructions.js`](../server/providers/openai/instructions.js)
dan [`src/voice/realtimeController.js`](../src/voice/realtimeController.js).
Ubah agar asisten menyebut merek Anda.

---

## 5. Bila ingin menyunting markup langsung

Anda tidak perlu ini bila memakai `config/brand.json`. Tetapi bila ingin
mengubah strukturnya, inilah tempatnya:

| Berkas | Isi |
| --- | --- |
| [`src/ui/templates/scene-chrome.html`](../src/ui/templates/scene-chrome.html) | Judul dan tagline di kiri atas |
| [`src/ui/templates/hud-loading.html`](../src/ui/templates/hud-loading.html) | Layar pemuatan |
| [`index.html`](../index.html) | Judul dokumen dan tautan favicon |
| [`src/ui/templates/welcome.html`](../src/ui/templates/welcome.html) | Dialog sambutan pertama |

Elemen yang diisi oleh sistem merek ditandai atribut `data-brand="name"` dan
`data-brand="tagline"`. **Pertahankan atribut itu** bila Anda memindahkan
elemennya, atau `config/brand.json` berhenti berpengaruh.

---

## 6. Memeriksa hasilnya

Setelah mengubah merek, jalankan keduanya:

```bash
npm test
```

```bash
npm run build
```

Ada test yang menjaga agar sistem merek tidak rusak
([`src/ui/brandHtml.test.mjs`](../src/ui/brandHtml.test.mjs)), termasuk bahwa
teks merek diloloskan dengan aman sehingga tanda kurung sudut di nama Anda
tidak bisa menyuntikkan markup.

Satu test memastikan repositori ini tetap dikirim dengan identitas aslinya —
whitelabel bersifat memilih-sendiri. Bila Anda mengubah `config/brand.json`
lalu test itu gagal, itu **wajar dan benar**: perbarui atau hapus test
tersebut di fork Anda.

---

## 7. Ringkasan

| Ingin mengubah | Berkas |
| --- | --- |
| Nama, tagline, judul tab, logo | `config/brand.json` |
| Berkas logo | `public/logo.svg` |
| Layar pembuka | `public/splash.svg` |
| Durasi memudar splash | `.splash-screen` di `src/ui/styles/foundation.css` |
| Kata-kata antarmuka | `src/ui/i18n/id.json` |
| Label tombol panel CCTV | `src/ui/cctvPresentation.js` |
| Identitas ke API publik | `server/providers/` |
| **Hak cipta asli** | **`LICENSE` — jangan diubah** |
| **Kredit penyedia data** | **`src/data/dataCredits.js` — jangan dihapus** |
