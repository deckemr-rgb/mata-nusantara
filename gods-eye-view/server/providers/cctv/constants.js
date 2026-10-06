export const DEFAULT_CCTV_SOURCE_FILE = 'config/cctv_sources.austin.json';
/** Austin Open Data portal endpoint for traffic camera records. */
export const DEFAULT_AUSTIN_ROWS_URL =
  'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD';
/** Default cap on Austin cameras after distance-based prioritization. */
export const DEFAULT_AUSTIN_MAX_SOURCES = 250;
/**
 * Catalog-wide safety ceiling on served cameras. Each pack already caps
 * itself (nearest-to-anchor first); this bound only matters when the packs
 * together exceed it, and it is then filled round-robin across packs (see
 * cap.js) so no region is silently dropped. Sized above the sum of the
 * default per-pack caps so a default install never trims.
 */
export const DEFAULT_CCTV_MAX_SOURCES = 4000;
/** Hard upper bound for CCTV_MAX_SOURCES; also sizes the health map. */
export const CCTV_MAX_SOURCES_CEILING = 5000;
/** Reference point for Austin camera prioritization (Congress & 6th). */
export const AUSTIN_DOWNTOWN = { lat: 30.2672, lon: -97.7431 };
/** Caltrans CCTV: one JSON feed per district, identical schema statewide. */
/** TxDOT ITS: one keyless JSON catalog per district (25 districts statewide). */
export const TXDOT_ORIGIN = 'https://its.txdot.gov';
export const TXDOT_CCTV_STATUS_URL = (district) =>
  `${TXDOT_ORIGIN}/its/DistrictIts/GetCctvStatusListByDistrict?districtCode=${encodeURIComponent(district)}`;
/** Per-camera frame. Returns JSON `{snippet:<base64 jpeg>}`, not an image body;
 * media.js decodes it (fetchTxdotSnapshot) and only for this origin. */
export const TXDOT_CCTV_SNAPSHOT_URL = `${TXDOT_ORIGIN}/its/DistrictIts/GetCctvSnapshotByIcdId`;
/** Valid TxDOT district codes (the ITS map's own districtCodes list). */
export const TXDOT_DISTRICTS = new Set([
  'ABL',
  'AMA',
  'ATL',
  'AUS',
  'BMT',
  'BWD',
  'BRY',
  'CHS',
  'CRP',
  'DAL',
  'ELP',
  'FTW',
  'HOU',
  'LRD',
  'LBB',
  'LFK',
  'ODA',
  'PAR',
  'PHR',
  'SJT',
  'SAT',
  'TYL',
  'WAC',
  'WFS',
  'YKM',
]);
/** Districts fetched by default: Austin (the reference camera city) and San
 * Antonio. A statewide default was rejected: per-pack prioritization is
 * nearest-to-any-anchor, so Dallas's dense core would take most slots.
 * CCTV_TXDOT_DISTRICTS opens up the rest ("AUS,SAT,HOU,DAL,FTW" for the five
 * big metros, or any of the 25 codes). */
export const DEFAULT_TXDOT_DISTRICTS = 'AUS,SAT';
export const DEFAULT_TXDOT_MAX_SOURCES = 500;
/** Prioritization anchors: downtown cores of the metro districts a user can
 * select. Cameras rank by distance to the NEAREST anchor, so a widened
 * CCTV_TXDOT_DISTRICTS still ranks sensibly instead of against Austin alone. */
export const TXDOT_ANCHORS = [
  { lat: 30.2672, lon: -97.7431 }, // Austin
  { lat: 29.4241, lon: -98.4936 }, // San Antonio
  { lat: 29.7604, lon: -95.3698 }, // Houston
  { lat: 32.7767, lon: -96.797 }, // Dallas
  { lat: 32.7555, lon: -97.3308 }, // Fort Worth
];
/** Ground-elevation priors in metres, by district. The TxDOT payload carries
 * no elevation, and on a keyless (no-tileset) stack the client's ground snap
 * never fires, so this prior is the only height a camera gets there. Texas
 * spans sea level (Houston) to ~1,140 m (El Paso). */
export const TXDOT_DISTRICT_ELEVATION_M = Object.freeze({
  ABL: 520,
  AMA: 1099,
  ATL: 105,
  AUS: 149,
  BMT: 5,
  BWD: 425,
  BRY: 111,
  CHS: 250,
  CRP: 7,
  DAL: 131,
  ELP: 1140,
  FTW: 199,
  HOU: 15,
  LRD: 132,
  LBB: 992,
  LFK: 91,
  ODA: 890,
  PAR: 185,
  PHR: 30,
  SJT: 585,
  SAT: 198,
  TYL: 165,
  WAC: 143,
  WFS: 289,
  YKM: 70,
});
export const TXDOT_DEFAULT_ELEVATION_M = 150;
export const CALTRANS_CCTV_URL = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
/** Districts fetched by default: SF Bay (4), LA (7), San Diego (11), Sacramento (3). */
export const DEFAULT_CALTRANS_DISTRICTS = '4,7,11,3';
export const DEFAULT_CALTRANS_MAX_SOURCES = 300;
/** Prioritization anchors: downtown cores of the four default metros. */
export const CALTRANS_ANCHORS = [
  { lat: 37.7793, lon: -122.4193 }, // San Francisco
  { lat: 34.0537, lon: -118.2428 }, // Los Angeles
  { lat: 32.7157, lon: -117.1611 }, // San Diego
  { lat: 38.5816, lon: -121.4944 }, // Sacramento
];
/** TfL JamCams: one keyless list endpoint; frames live on a public S3 bucket. */
export const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
export const TFL_IMAGE_ORIGIN =
  'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';
export const DEFAULT_TFL_MAX_SOURCES = 250;
export const LONDON_CENTER = { lat: 51.5074, lon: -0.1278 };
/** Ontario 511: keyless CARS/511 camera catalog; frame URLs are still images. */
export const ONTARIO_511_CAMERAS_URL =
  'https://511on.ca/api/v2/get/cameras?format=json&lang=en';
export const ONTARIO_511_IMAGE_ORIGIN = 'https://511on.ca/map/Cctv/';
export const DEFAULT_ONTARIO_MAX_SOURCES = 1000;
export const ONTARIO_ANCHORS = [
  { lat: 43.4516, lon: -80.4925 }, // Kitchener
  { lat: 43.6532, lon: -79.3832 }, // Toronto
  { lat: 45.4215, lon: -75.6972 }, // Ottawa
  { lat: 43.2557, lon: -79.8711 }, // Hamilton
  { lat: 42.9849, lon: -81.2453 }, // London, Ontario
  { lat: 42.3149, lon: -83.0364 }, // Windsor
];
/** Fintraffic road weather cameras (Digitraffic): one keyless GeoJSON list
 * covering all of Finland. Each STATION carries N presets (fixed camera views)
 * that share the station position; one preset is one camera here. */
export const FINTRAFFIC_STATIONS_URL =
  'https://tie.digitraffic.fi/api/weathercam/v1/stations';
/** Frames: `<origin><presetId>.jpg`. Preset ids are synthesized into this
 * origin rather than read from the payload, so no upstream field can steer the
 * frame proxy off-host. */
export const FINTRAFFIC_IMAGE_ORIGIN = 'https://weathercam.digitraffic.fi/';
/** Digitraffic asks every client to identify itself on API calls. */
export const DIGITRAFFIC_USER = 'gods-eye-view';
export const DEFAULT_FINTRAFFIC_MAX_SOURCES = 300;
/** Ground-elevation prior, in metres, for stations that report no altitude.
 * 228 of 809 stations carry a real metre value (median 94 m); the rest report
 * 0, which means "not reported" rather than sea level — Kouvola (~80 m of real
 * elevation) reports 0. The observed median stands in for those. */
export const FINTRAFFIC_GROUND_ELEVATION_M = 90;
/** Prioritization anchors: the population centres strung along Finland's main
 * road spine (vt1 Turku, vt3 Tampere, vt4 Jyväskylä–Oulu–Rovaniemi, vt5
 * Kuopio), so a cap keeps national coverage rather than just the capital. */
export const FINLAND_ANCHORS = [
  { lat: 60.1699, lon: 24.9384 }, // Helsinki
  { lat: 60.4518, lon: 22.2666 }, // Turku
  { lat: 61.4978, lon: 23.761 }, // Tampere
  { lat: 62.2426, lon: 25.7473 }, // Jyväskylä
  { lat: 62.8924, lon: 27.677 }, // Kuopio
  { lat: 65.0121, lon: 25.4651 }, // Oulu
  { lat: 66.5039, lon: 25.7294 }, // Rovaniemi
];
/** Global cap on total CCTV sources served by the proxy: the default per-pack
 * caps summed (Austin 250 + Caltrans 300 + TfL 250 + DriveBC 250). */
/** DriveBC highway cameras (British Columbia): the keyless camera list served by
 * the DriveBC.ca site (github.com/bcgov/DriveBC.ca). The DataBC HighwayCams CSV
 * lists the same cameras but still carries retired images.drivebc.ca frame URLs,
 * so frames are built from the numeric camera id on the current image host. */
export const DRIVEBC_WEBCAMS_URL = 'https://www.drivebc.ca/api/webcams/';
export const DRIVEBC_IMAGE_URL = (id) =>
  `https://www.drivebc.ca/images/${id}.jpg`;
export const DEFAULT_DRIVEBC_MAX_SOURCES = 250;
/** Prioritization anchors: downtown Vancouver and Victoria. */
export const DRIVEBC_ANCHORS = [
  { lat: 49.2827, lon: -123.1207 }, // Vancouver
  { lat: 48.4284, lon: -123.3656 }, // Victoria
];
/** Tallinn intersection cameras: curated catalog + public stills on ristmikud.tallinn.ee. */
export const DEFAULT_TALLINN_SOURCE_FILE = 'config/cctv_sources.tallinn.json';
export const DEFAULT_TALLINN_MAX_SOURCES = 255;
export const TALLINN_IMAGE_ORIGIN = 'https://ristmikud.tallinn.ee/';
export const TALLINN_CENTER = { lat: 59.437, lon: 24.753 };
/** Transpordiamet / Tarktee road-weather cameras: keyless DATEX2 feeds. */
export const TARKTEE_LOCATIONS_URL =
  'https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraLocations';
export const TARKTEE_IMAGES_URL =
  'https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraImages';
export const TARKTEE_IMAGE_ORIGIN = 'https://tarktee.transpordiamet.ee/images/';
export const DEFAULT_TARKTEE_MAX_SOURCES = 179;
export const TARKTEE_ANCHORS = [
  { lat: 59.437, lon: 24.753 }, // Tallinn
  { lat: 58.378, lon: 26.729 }, // Tartu
  { lat: 58.3859, lon: 24.4971 }, // Pärnu
  { lat: 59.3797, lon: 28.1791 }, // Narva
];
/** Warendorf (Germany): the Marktplatz municipal webcam from a curated catalog file. */
export const DEFAULT_WARENDORF_SOURCE_FILE =
  'config/cctv_sources.warendorf.json';
export const WARENDORF_IMAGE_ORIGINS = Object.freeze([
  'http://webcam.warendorf.de/',
  'https://www.kreis-warendorf.de/',
]);
/** Live Traffic NSW (Transport for NSW): keyless public camera catalog. */
export const NSW_CAMERAS_URL =
  'https://data.livetraffic.com/cameras/traffic-cam.json';
export const NSW_IMAGE_ORIGIN = 'https://webcams.transport.nsw.gov.au/';
export const DEFAULT_NSW_MAX_SOURCES = 250;
export const SYDNEY_CENTER = { lat: -33.8688, lon: 151.2093 };
/**
 * The NSW webcam host answers non-browser clients with HTTP 200 and a short
 * HTML body instead of the frame (verified 2026-09-13), so the proxy
 * identifies as a browser for that one host. See media.js.
 */
export const NSW_IMAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/**
 * Longest NSW `view` sentence still usable as a label. NSW occasionally
 * repurposes `view` for a multi-paragraph works notice; real descriptions top
 * out around 120 characters.
 */
export const NSW_MAX_VIEW_LABEL = 140;
/** Open Calgary traffic cameras: one keyless Socrata endpoint for the whole
 * city; frames are stills on a City of Calgary host. */
export const DEFAULT_CALGARY_ROWS_URL =
  'https://data.calgary.ca/resource/k7p9-kppz.json?$limit=500';
/** The only origin Calgary camera frames may come from. The catalog publishes
 * most rows as `http://`; that host serves HTTPS and 301-redirects to it, so
 * URLs are upgraded and then pinned here before registration. */
export const CALGARY_IMAGE_ORIGIN = 'https://trafficcam.calgary.ca/';
export const DEFAULT_CALGARY_MAX_SOURCES = 220;
/** Centre Street / 7 Avenue: the prioritization anchor. */
export const CALGARY_DOWNTOWN = { lat: 51.0461, lon: -114.0626 };
/** Hard ceiling on the Calgary catalog body. The whole city is ~215 rows and
 * under 100 KB; this only exists so an upstream that streams an unbounded
 * body cannot be buffered without limit. */
export const CALGARY_MAX_CATALOG_BYTES = 4 * 1024 * 1024;

/* ---------------------------------------------------------------------------
 * Indonesia — ATCS (Area Traffic Control System) city portals
 *
 * Indonesian cities publish their traffic cameras through ATCS portals run by
 * each Dinas Perhubungan (city transport agency). The feeds are published for
 * road users to watch, and every endpoint below is the same one the portal's
 * own public map calls with no key, no login, and no scraping of a private
 * area. Each city runs its own stack, so each gets its own loader.
 * ------------------------------------------------------------------------- */

/** Yogyakarta: one keyless JSON call returns the whole catalog — coordinates,
 * title, and a direct HLS URL per camera. The portal's own map uses it. */
export const DEFAULT_JOGJA_CCTV_URL =
  'https://cctv.jogjakota.go.id/home/getdata';
/** Every Jogja stream lives here; URLs outside it are rejected. The host sends
 * `Access-Control-Allow-Origin: *`, so these play without the media proxy. */
export const JOGJA_STREAM_ORIGIN = 'https://cctvjss.jogjakota.go.id/';
export const DEFAULT_JOGJA_MAX_SOURCES = 160;
/** Tugu Yogyakarta: the prioritization anchor. */
export const JOGJA_CENTER = { lat: -7.7828, lon: 110.3671 };

/** Bandung: a three-call portal. `/ajax/lokasi` lists intersections with
 * coordinates, `/ajax/cctv-list` returns the cameras at one intersection as an
 * HTML fragment, and `/ajax/cctv-info` resolves one camera to its HLS URL. */
export const BANDUNG_ATCS_ORIGIN = 'https://atcs-dishub.bandung.go.id/';
export const BANDUNG_LOCATIONS_URL = `${BANDUNG_ATCS_ORIGIN}ajax/lokasi`;
export const BANDUNG_CAMERA_LIST_URL = `${BANDUNG_ATCS_ORIGIN}ajax/cctv-list`;
export const BANDUNG_CAMERA_INFO_URL = `${BANDUNG_ATCS_ORIGIN}ajax/cctv-info`;
/** Bandung streams come off a media port on the same host. Serves no CORS
 * headers at all, so these MUST go through the media proxy to play. */
export const BANDUNG_STREAM_ORIGIN = 'https://atcs-dishub.bandung.go.id:1990/';
export const DEFAULT_BANDUNG_MAX_SOURCES = 120;
/** Alun-Alun Bandung: the prioritization anchor. */
export const BANDUNG_CENTER = { lat: -6.9218, lon: 107.6071 };
/** Bandung resolves one camera per request. Capping the fan-out keeps a
 * catalog refresh from opening hundreds of sockets against a city server. */
export const BANDUNG_RESOLVE_CONCURRENCY = 6;

/** Curated Indonesian cameras (cities without a machine-readable portal).
 * Ships empty; operators and contributors add entries. */
/** Jakarta: the DKI provincial government publishes a public CCTV wall at
 * jakcctv.jakarta.go.id/publik. The page is static HTML whose cards embed one
 * Flussonic player per camera; the catalog is read from those cards. */
export const DEFAULT_JAKARTA_PORTAL_URL =
  'https://jakcctv.jakarta.go.id/publik';
/** The two Flussonic media hosts the portal embeds. A stream URL on any other
 * host is dropped rather than registered. */
export const JAKARTA_STREAM_ORIGINS = Object.freeze([
  'https://dki-jkt.balitower.co.id:7028',
  'https://cctv-jsc.balitower.co.id:8011',
]);
/** The portal publishes NO coordinates. This file carries points geocoded once
 * from the street names and verified inside Jakarta — see its own _readme. */
export const DEFAULT_JAKARTA_LOCATIONS_FILE =
  'config/cctv_jakarta_locations.json';
export const DEFAULT_JAKARTA_MAX_SOURCES = 200;
/** Bundaran HI: the prioritization anchor. */
export const JAKARTA_CENTER = { lat: -6.195, lon: 106.823 };
/** Jakarta is coastal and nearly flat; the client's ground snap refines this. */
export const JAKARTA_GROUND_ELEVATION_M = 8;

export const DEFAULT_INDONESIA_SOURCE_FILE =
  'config/cctv_sources.indonesia.json';

/** Hard ceiling on any single Indonesian catalog body. The largest today
 * (Jogja, ~154 cameras) is ~100 KB; this only bounds a runaway upstream. */
export const INDONESIA_MAX_CATALOG_BYTES = 4 * 1024 * 1024;

/** Indonesian ATCS cameras are street-corner poles on mast arms, typically a
 * little higher than the North American norm and looking further down the
 * approach they watch. Priors only — the client's ground snap and the
 * calibration gizmo correct them. */
export const INDONESIA_CAMERA_DEFAULTS = Object.freeze({
  pitchDeg: -16,
  fovDeg: 50,
  rangeM: 170,
  mountHeightM: 9,
});

/** Camera CATALOGS change rarely; 15 min keeps multi-megabyte upstream list refetches (Austin rows.json + 4 Caltrans districts + TfL + Ontario 511) infrequent. Frames are fetched per-request and are unaffected. */
export const CCTV_SOURCE_CACHE_MS = 15 * 60 * 1000;
/** Per-provider catalog-fetch timeout. Bounds the worst-case refresh so one
 * stalled upstream can't leave getCctvSources (and thus every CCTV route)
 * pending forever — a hung fetch aborts, the loader returns [], and
 * serve-stale/other packs take over. */
export const CCTV_SOURCE_FETCH_TIMEOUT_MS = 15 * 1000;

/*
 * Catalogs reconnect on the same reasoning as media -- see the note beside
 * CCTV_MEDIA_ATTEMPT_TIMEOUT_MS -- with one difference that matters.
 *
 * A media deadline stops at the response headers, because a live video body is
 * meant to run for minutes. A catalog deadline does not: the download has to
 * finish, and the constant above exists precisely so a stalled portal cannot
 * leave getCctvSources pending. So the budget below covers the body too, and
 * two attempts still add up to the same 15 seconds a single attempt was
 * allowed before.
 *
 * A failed catalog is quieter than a failed camera -- the loader returns an
 * empty list and the previous snapshot is served on -- but the cameras in that
 * pack vanish from the globe until the next refresh. One reconnection is worth
 * it; more would mean leaning on a municipal server that is already busy.
 */

/** Budget for every catalog attempt but the last, body included. */
export const CCTV_SOURCE_ATTEMPT_TIMEOUT_MS = 5 * 1000;

/** Catalog connections opened before a pack is given up on for this refresh. */
export const CCTV_SOURCE_FETCH_ATTEMPTS = 2;
/** Individual CCTV image fetches must settle before the active 10-second
 * client refresh cadence. A bounded miss can fall through to Street View or
 * the synthetic frame instead of leaving the browser preview pending. */
export const CCTV_FRAME_FETCH_TIMEOUT_MS = 8 * 1000;

/** Maximum buffered snapshot size. */
export const CCTV_FRAME_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Hard cap on an HLS playlist body. A live sliding-window playlist is a
 * few KB; this only bounds a VOD-sized or runaway index, which is buffered in
 * full because every URI in it has to be rewritten before the player sees it. */
export const CCTV_PLAYLIST_MAX_BYTES = 2 * 1024 * 1024;

/** Deadline for upstream response headers; live bodies keep streaming afterward.
 * This is the budget for the whole attempt sequence, not for one connection. */
export const CCTV_MEDIA_FETCH_TIMEOUT_MS = 15 * 1000;

/*
 * Why the media fetch retries, and why each attempt is cut short
 * -------------------------------------------------------------
 * Some of the camera portals drop inbound SYN packets under load. A dropped
 * SYN is not reported to the client; the kernel simply retransmits on a fixed
 * ladder, so the connection completes after 1s, then 3s, then 7s, then 15s.
 * Measured against cctvjss.jogjakota.go.id, connect latency was 24-90ms in the
 * median case and landed on exactly those ladder steps otherwise -- the same
 * host, seconds apart, with no failure in between.
 *
 * That shape is what makes a single long wait the wrong answer. Sitting on a
 * connection that has already missed the first rung buys a 3s, 7s or 15s
 * answer, while a fresh SYN opened alongside it usually lands in well under a
 * tenth of a second. So each attempt is given a budget just past the 3s rung
 * and then abandoned in favour of a new one.
 *
 * The undici default made this worse than it had to be: it gives up at 10s,
 * which falls between the 7s and 15s rungs. A camera whose SYN was dropped
 * three times spent ten seconds failing, and the viewer saw 502 on a camera
 * that was working.
 */

/*
 * The first attempt is impatient; the last one is patient.
 *
 * Only the earlier attempts are held to the budget below -- the final attempt
 * runs to whatever is left of the total. That split is deliberate. Cutting
 * every attempt short would break a camera that is slow for an honest reason:
 * one that consistently needs eight seconds to answer would be abandoned three
 * times and reported as a failure, having previously worked. Leaving the last
 * attempt the remaining ten seconds keeps that camera working, while the short
 * first attempt still converts a dropped SYN into a fresh connection instead of
 * a ten-second wait.
 */

/** Budget for every attempt but the last: past the 3s SYN rung, short of 7s. */
export const CCTV_MEDIA_ATTEMPT_TIMEOUT_MS = 5 * 1000;

/** Connections opened before giving up. Two independent SYNs carry almost
 * every case; a third would only shorten the patient final attempt. */
export const CCTV_MEDIA_FETCH_ATTEMPTS = 2;
/** Declared size ceiling for fixed media responses. */
export const CCTV_MEDIA_MAX_BODY_BYTES = 64 * 1024 * 1024;
