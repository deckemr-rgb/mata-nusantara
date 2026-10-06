import { readFileSync } from 'node:fs';

/**
 * Penerapan identitas merek saat build.
 *
 * KENAPA ADA MODUL INI
 * --------------------
 * Nama produk muncul di judul dokumen, judul di layar, layar pemuatan, tagline,
 * dan favicon. Tanpa modul ini, mengganti merek berarti menyunting lima berkas
 * template dan mengingat kelimanya setiap kali — panduan seperti itu rapuh dan
 * cepat usang. Di sini merek dibaca dari satu berkas, `config/brand.json`.
 *
 * KENAPA MENARGETKAN STRUKTUR, BUKAN TEKS
 * ---------------------------------------
 * Penggantian berdasarkan teks tidak mungkin benar di sini: tagline melewati
 * kamus terjemahan lebih dulu, sehingga saat modul ini berjalan kalimatnya
 * sudah berbunyi "TAK ADA TEMPAT YANG TERLEWAT", bukan lagi bunyi bahasa
 * Inggrisnya. Jadi markup menandai bagiannya dengan atribut `data-brand`, dan
 * modul ini mengganti ISI penanda itu — apa pun bahasanya saat itu.
 *
 * KENAPA DIJALANKAN PALING AKHIR
 * ------------------------------
 * Merek adalah kata terakhir. Ia berjalan SETELAH penerjemahan, karena nama
 * dan tagline yang Anda tulis adalah milik Anda dan tidak boleh diterjemahkan
 * ulang oleh kamus.
 *
 * YANG TIDAK DISENTUH MODUL INI
 * -----------------------------
 * Kredit penyedia data (Google, Cesium, OpenStreetMap, Esri, dan lainnya) dan
 * pemberitahuan hak cipta MIT bukan merek: keduanya kewajiban lisensi yang
 * berdiri sendiri. Lihat docs/WHITELABEL.md.
 */

/** Nilai bawaan, dipakai bila sebuah kunci kosong atau berkasnya tidak terbaca. */
const FALLBACK = Object.freeze({
  name: "GOD'S EYE",
  nameAccent: 'VIEW',
  documentTitle: "God's Eye View",
  tagline: 'NO PLACE LEFT BEHIND',
  logo: '/logo.svg',
  splash: '/splash.svg',
});

/** Lolos-kan teks agar aman disisipkan sebagai isi elemen HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Lolos-kan teks agar aman dipakai sebagai nilai atribut berkutip ganda. */
function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/**
 * Baca identitas merek, dengan nilai bawaan untuk kunci yang hilang.
 *
 * @param {URL|string} [source] Lokasi berkas merek.
 * @returns {{name: string, nameAccent: string, documentTitle: string, tagline: string, logo: string}}
 */
export function loadBrand(source = new URL('../config/brand.json', import.meta.url)) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(source, 'utf8'));
  } catch {
    // Berkas merek yang hilang atau rusak tidak boleh menggagalkan build;
    // aplikasi kembali memakai identitas bawaannya.
    raw = {};
  }
  const pick = (key) => {
    const value = raw?.[key];
    // Tagline dan aksen nama boleh sengaja dikosongkan, jadi string kosong
    // dihormati; hanya nilai yang tidak ada yang jatuh ke bawaan.
    if (typeof value === 'string') return value;
    return FALLBACK[key];
  };
  return {
    name: pick('name'),
    nameAccent: pick('nameAccent'),
    documentTitle: pick('documentTitle'),
    tagline: pick('tagline'),
    logo: pick('logo'),
    splash: pick('splash'),
  };
}

/**
 * Terapkan identitas merek pada markup yang sudah dirakit.
 *
 * @param {string} html Markup hasil perakitan dan penerjemahan.
 * @param {object} brand Hasil {@link loadBrand}.
 * @returns {{html: string, applied: number}}
 */
export function applyBrand(html, brand) {
  let out = String(html ?? '');
  let applied = 0;

  /**
   * Sebuah bidang hanya ditulis bila operator benar-benar mengubahnya.
   *
   * Ini penting untuk tagline: modul ini berjalan setelah penerjemahan, jadi
   * menuliskan kembali nilai bawaan berbahasa Inggris justru akan MEMBATALKAN
   * terjemahan yang baru saja diterapkan. Membiarkan bidang yang tak diubah
   * apa adanya menjaga perilaku build tetap sama bagi siapa pun yang belum
   * menyentuh berkas merek.
   */
  const changed = (key) => brand[key] !== FALLBACK[key];

  const name = escapeHtml(brand.name);
  const accent = escapeHtml(brand.nameAccent);
  const tagline = escapeHtml(brand.tagline);

  // Judul dokumen.
  if (changed('documentTitle')) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, () => {
      applied += 1;
      return `<title>${escapeHtml(brand.documentTitle)}</title>`;
    });
  }

  // Nama produk di layar. Aksen dibungkus span-nya sendiri agar mewarisi warna
  // aksen; nama satu kata menghilangkan span itu sepenuhnya, bukan
  // meninggalkan span kosong yang menyisakan spasi.
  if (changed('name') || changed('nameAccent')) {
    out = out.replace(
      /(<[a-z][a-z0-9]*[^>]*\bdata-brand="name"[^>]*>)[\s\S]*?(<\/[a-z][a-z0-9]*>)/gi,
      (_whole, open, close) => {
        applied += 1;
        const accentMarkup = accent
          ? ` <span class="title-accent">${accent}</span>`
          : '';
        return `${open}${name}${accentMarkup}${close}`;
      },
    );
  }

  // Tagline. Kosong berarti elemennya dikosongkan dan disembunyikan, sehingga
  // tidak menyisakan ruang kosong di bawah judul.
  if (changed('tagline')) {
    out = out.replace(
      /(<[a-z][a-z0-9]*[^>]*\bdata-brand="tagline"[^>]*)(>)[\s\S]*?(<\/[a-z][a-z0-9]*>)/gi,
      (_whole, open, gt, close) => {
        applied += 1;
        if (!tagline) return `${open} hidden${gt}${close}`;
        return `${open}${gt}${tagline}${close}`;
      },
    );
  }

  // Berkas logo: dipakai sebagai gambar di layar sekaligus favicon.
  if (brand.logo && brand.logo !== FALLBACK.logo) {
    const logo = escapeAttribute(brand.logo);
    const before = out;
    out = out.replace(/(["'(])\/logo\.svg(["')])/g, `$1${logo}$2`);
    if (out !== before) applied += 1;
  }

  // Berkas layar pembuka.
  if (brand.splash && brand.splash !== FALLBACK.splash) {
    const splash = escapeAttribute(brand.splash);
    const before = out;
    out = out.replace(/(["'(])\/splash\.svg(["')])/g, `$1${splash}$2`);
    if (out !== before) applied += 1;
  }

  return { html: out, applied };
}
