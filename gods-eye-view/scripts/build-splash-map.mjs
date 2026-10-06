/**
 * Bangun ulang berkas peta splash Indonesia dari data Natural Earth.
 *
 * Dijalankan manual, bukan saat build:
 *
 *   node scripts/build-splash-map.mjs
 *
 * KENAPA DIBANGKITKAN, BUKAN DIGAMBAR
 * -----------------------------------
 * Menggambar siluet Nusantara dengan tangan berarti menebak bentuk lima pulau
 * besar dan belasan pulau kecil. Repositori ini sudah memuat poligon Natural
 * Earth 10m (public domain) di src/data/local_data/natural_earth/, jadi
 * petanya diturunkan dari garis pantai sungguhan.
 *
 * KENAPA BORNEO DAN PAPUA DIPOTONG
 * --------------------------------
 * Natural Earth memberi PULAU, bukan negara. Borneo dibagi dengan Malaysia dan
 * Brunei; Pulau Papua dibagi dengan Papua Nugini. Mewarnai keduanya penuh
 * dengan merah putih berarti mengecat wilayah negara tetangga — jadi keduanya
 * dipotong lebih dulu:
 *
 *   - Papua dipotong di bujur 141°BT. Itu batas sesungguhnya, dan kebetulan
 *     berupa garis lurus, sehingga potongannya tepat.
 *   - Kalimantan dipotong dengan poligon batas yang DIDEKATKAN, bukan tepat.
 *     Batas Kalimantan–Sarawak/Sabah berkelok mengikuti punggung pegunungan
 *     dan tidak tersedia di berkas ini. Bentuknya cukup benar untuk sebuah
 *     siluet, tetapi jangan dibaca sebagai garis batas resmi.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const REGIONS = path.join(
  ROOT,
  'src/data/local_data/natural_earth/regions.json',
);
const OUT = path.join(ROOT, 'public/splash.svg');

/** Pulau yang digambar. Nama persis seperti di Natural Earth. */
const ISLANDS = [
  'Sumatra',
  'Java',
  'Borneo',
  'Sulawesi',
  'New Guinea',
  'Bali',
  'Lombok',
  'Sumbawa',
  'Flores',
  'Sumba',
  'Timor',
  'Halmahera',
  'Buru',
  'Bangka',
  'Belitung',
  'Nias',
  'Siberut',
];

/** Batas timur wilayah Indonesia di Pulau Papua. */
const PAPUA_EAST_LIMIT = 141.0;

/**
 * Wilayah Kalimantan, sebagai DUA poligon cembung yang berdampingan.
 *
 * Dipecah dua karena batasnya cekung: garis Kalbar–Sarawak mendatar, lalu
 * garis Kaltara–Sabah menekuk NAIK ke timur laut. Sutherland–Hodgman hanya
 * benar untuk pemotong cembung, dan tekukan itu membuat bentuk keseluruhannya
 * cekung — dua percobaan sebelumnya gagal karenanya: satu poligon cekung
 * menyisakan pulau hanya sampai 0,4°LS, dan irisan dua setengah-bidang
 * memotong Kalimantan Utara di 2,2°LU. Memotong terhadap dua bagian cembung
 * lalu menggabungkan hasilnya memberi bentuk cekung yang benar.
 */
const KALIMANTAN_PARTS = [
  // Barat: Kalimantan Barat/Tengah, dibatasi garis Kalbar–Sarawak.
  [
    [108.0, 1.05],
    [114.2, 1.75],
    [114.2, -5.0],
    [108.0, -5.0],
  ],
  // Timur: Kalimantan Timur/Utara, dibatasi garis Kaltara–Sabah yang naik.
  [
    [114.2, 1.75],
    [118.4, 4.4],
    [120.0, 4.4],
    [120.0, -5.0],
    [114.2, -5.0],
  ],
];

/**
 * Potong sebuah poligon dengan satu setengah-bidang (Sutherland–Hodgman).
 *
 * @param {Array<[number,number]>} polygon
 * @param {(point: [number,number]) => boolean} inside
 * @param {(a: [number,number], b: [number,number]) => [number,number]} intersect
 * @returns {Array<[number,number]>}
 */
function clipHalfPlane(polygon, inside, intersect) {
  const out = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const previous = polygon[(i + polygon.length - 1) % polygon.length];
    const currentIn = inside(current);
    const previousIn = inside(previous);
    if (currentIn) {
      if (!previousIn) out.push(intersect(previous, current));
      out.push(current);
    } else if (previousIn) {
      out.push(intersect(previous, current));
    }
  }
  return out;
}

/**
 * Potong poligon terhadap satu poligon pemotong CEMBUNG.
 *
 * Titik pemotong harus urut searah jarum jam, sehingga bagian dalam berada di
 * sisi kanan tiap sisinya.
 *
 * @param {Array<[number,number]>} polygon
 * @param {Array<[number,number]>} convex
 * @returns {Array<[number,number]>}
 */
function clipToConvex(polygon, convex) {
  let result = polygon;
  for (let i = 0; i < convex.length; i += 1) {
    const a = convex[i];
    const b = convex[(i + 1) % convex.length];
    const side = (p) =>
      (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    result = clipHalfPlane(
      result,
      (p) => side(p) <= 0,
      (p, q) => {
        const sp = side(p);
        const sq = side(q);
        const t = sp / (sp - sq);
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      },
    );
    if (!result.length) break;
  }
  return result;
}

/** Potong poligon pada batas bujur timur. */
function clipEastOf(polygon, limit) {
  return clipHalfPlane(
    polygon,
    (p) => p[0] <= limit,
    (p, q) => {
      const t = (limit - p[0]) / (q[0] - p[0]);
      return [limit, p[1] + (q[1] - p[1]) * t];
    },
  );
}

const data = JSON.parse(fs.readFileSync(REGIONS, 'utf8'));
const byName = new Map();
for (const feature of data.features) {
  if (!ISLANDS.includes(feature.name)) continue;
  // Natural Earth memuat dua fitur bernama "Flores"; yang dipakai adalah yang
  // poligonnya lebih besar, karena yang kecil adalah Flores di Azores.
  const points = feature.polygons.reduce((n, p) => n + p.length, 0);
  const existing = byName.get(feature.name);
  if (!existing || points > existing.points) {
    byName.set(feature.name, { feature, points });
  }
}

/** Kumpulkan seluruh cincin, sudah dipotong bila perlu. */
const rings = [];
for (const name of ISLANDS) {
  const entry = byName.get(name);
  if (!entry) {
    console.warn(`  lewat: ${name} tidak ada di Natural Earth`);
    continue;
  }
  for (const polygon of entry.feature.polygons) {
    let ring = polygon.map(([lon, lat]) => [lon, lat]);
    if (name === 'New Guinea') ring = clipEastOf(ring, PAPUA_EAST_LIMIT);
    if (name === 'Borneo') {
      // Dua bagian cembung, digambar berdampingan sebagai dua cincin.
      for (const part of KALIMANTAN_PARTS) {
        const piece = clipToConvex(ring, part);
        if (piece.length >= 3) rings.push({ name, ring: piece });
      }
      continue;
    }
    if (ring.length >= 3) rings.push({ name, ring });
  }
}

// Bingkai gambar: seluruh Nusantara, dengan sedikit ruang napas.
const PAD = 0.6;
let minLon = Infinity;
let maxLon = -Infinity;
let minLat = Infinity;
let maxLat = -Infinity;
for (const { ring } of rings) {
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
}
minLon -= PAD;
maxLon += PAD;
minLat -= PAD;
maxLat += PAD;

// Equirectangular MURNI — bujur dan lintang dipetakan lurus, tanpa koreksi
// cos(lintang). Itu wajib: berkas ini dipasang di globe sebagai Rectangle
// bujur/lintang (lihat src/ui/splashOverlay.js), dan koreksi apa pun akan
// menggeser gambarnya dari garis pantai di bawahnya. Nusantara berada di
// khatulistiwa, jadi melarnya hanya 0,08% dan tidak kasat mata.
const WIDTH = 1600;
const spanLon = maxLon - minLon;
const spanLat = maxLat - minLat;
const HEIGHT = Math.round((WIDTH * spanLat) / spanLon);

const project = ([lon, lat]) => [
  ((lon - minLon) * WIDTH) / spanLon,
  ((maxLat - lat) * HEIGHT) / spanLat,
];

const round = (n) => Math.round(n * 10) / 10;
const paths = rings
  .map(({ ring }) => {
    const d = ring
      .map((point, index) => {
        const [x, y] = project(point);
        return `${index === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`;
      })
      .join('');
    return `${d}Z`;
  })
  .join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Peta Indonesia">
  <title>Peta Indonesia</title>
  <defs>
    <!-- Merah di atas, putih di bawah: warna Sang Saka. Merahnya #CE1126,
         merah bendera Indonesia. -->
    <linearGradient id="merahPutih" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#CE1126"/>
      <stop offset="48%" stop-color="#CE1126"/>
      <stop offset="52%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#FFFFFF"/>
    </linearGradient>
  </defs>
  <g fill="url(#merahPutih)">
    <path d="${paths}"/>
  </g>
</svg>
`;

fs.writeFileSync(OUT, svg);
console.log(`peta splash ditulis: ${path.relative(ROOT, OUT)}`);
console.log(`  pulau     : ${new Set(rings.map((r) => r.name)).size}`);
console.log(`  cincin    : ${rings.length}`);
console.log(`  ukuran    : ${WIDTH}x${HEIGHT}`);
console.log(`  bingkai   : ${round(minLon)}..${round(maxLon)} BT, ${round(minLat)}..${round(maxLat)} LU`);
console.log(`  berkas    : ${(svg.length / 1024).toFixed(1)} KB`);

// Bingkai geografisnya ikut ditulis, supaya kode yang menempelkan gambar ini ke
// globe tidak perlu menebak — dan supaya keduanya tidak bisa lepas sinkron.
const boundsPath = path.join(ROOT, 'config/splash-bounds.json');
fs.writeFileSync(
  boundsPath,
  `${JSON.stringify(
    {
      _readme:
        'Bingkai geografis public/splash.svg, ditulis oleh scripts/build-splash-map.mjs. Dipakai src/ui/splashOverlay.js untuk menempelkan gambar itu tepat di atas Nusantara pada globe. Bila Anda mengganti splash.svg dengan gambar sendiri yang bingkainya berbeda, sesuaikan angka di sini agar tetap pas.',
      west: Number(minLon.toFixed(4)),
      south: Number(minLat.toFixed(4)),
      east: Number(maxLon.toFixed(4)),
      north: Number(maxLat.toFixed(4)),
    },
    null,
    2,
  )}\n`,
);
console.log(`  bingkai   : ${path.relative(ROOT, boundsPath)}`);

/*
 * Versi PNG, untuk dipasang di globe.
 *
 * SVG-nya tetap ditulis karena itu sumber yang bisa disunting, tetapi TIDAK
 * dapat dipakai sebagai tekstur: Cesium mengunggah gambar lapisan citra ke
 * WebGL lewat createImageBitmap, dan peramban menolak mendekode SVG di jalur
 * itu ("The source image could not be decoded"). PNG yang dirender dari SVG
 * yang sama menyelesaikannya tanpa mengubah apa pun yang terlihat.
 */
const pngPath = path.join(ROOT, 'public/splash.png');
const sharp = (await import('sharp')).default;
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(pngPath);
const pngBytes = fs.statSync(pngPath).size;
console.log(
  `  tekstur   : ${path.relative(ROOT, pngPath)} (${(pngBytes / 1024).toFixed(1)} KB)`,
);
