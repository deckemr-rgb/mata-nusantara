/**
 * Convert Indonesian direction text to a compass heading.
 *
 * Indonesian ATCS operators label a camera by the approach it watches, in
 * phrases like "VID GEDEBAGE (Dari Arah Barat)" or "Simpang Tugu - Arah
 * Selatan". That phrasing is the ONLY reliable heading signal these portals
 * publish; none of them expose a bearing field.
 *
 * WHY BARE CARDINALS ARE NEVER MATCHED
 * ------------------------------------
 * This is the Austin/Calgary trap in Indonesian, and it is worse here. Bare
 * cardinal words are load-bearing parts of Indonesian PLACE names, not
 * facings:
 *
 *   - "Jakarta Selatan", "Jakarta Utara"  — the city's administrative units
 *   - "Bandung Barat", "Aceh Barat Daya"  — regency names
 *   - "Cibaduyut Barat", "Kebon Jeruk Timur" — street and kelurahan names
 *
 * A camera at "Simpang Jakarta Selatan" is not facing south. Reading the bare
 * "Selatan" as a facing would hand back a confident 180° for a large share of
 * the catalog and every one of them would be wrong. So only the explicit
 * "arah" ("direction") constructions count, exactly as directionText.js only
 * accepts "WESTBOUND"/"WB" in free-form text.
 *
 * WHY THE RESULT IS STILL LOW CONFIDENCE
 * --------------------------------------
 * "Dari Arah Barat" means "from the West": the camera frames vehicles
 * ARRIVING from the west, so it looks west, toward them — 270°. That is the
 * common install, but it is a convention, not a guarantee; an operator who
 * mounted the camera to watch that traffic recede would need the opposite
 * bearing. Callers therefore tag these cameras `headingConfidence: 'low'` and
 * the operator corrects them with the calibration gizmo.
 *
 * @param {string} value - Camera label or description text.
 * @returns {number} Heading in degrees [0..360), or NaN if unrecognized.
 */
export function indonesianDirectionToHeading(value) {
  const text = String(value || '')
    .trim()
    .toUpperCase();
  if (!text) return NaN;

  // Only an explicit "arah" construction is a facing. Accepts "DARI ARAH X",
  // "KE ARAH X", "ARAH X", and the "DR ARAH" abbreviation portals use in
  // truncated labels.
  const match = text.match(
    /\b(?:DARI\s+|DR\.?\s+|KE\s+|MENUJU\s+)?ARAH\s+([A-Z]+(?:\s+(?:LAUT|DAYA))?)/,
  );
  if (!match) return NaN;

  // Compound points first: "BARAT DAYA" contains "BARAT", and "TIMUR LAUT"
  // contains "TIMUR", so a bare-cardinal test would shadow both.
  const word = match[1].replace(/\s+/g, ' ').trim();
  if (word === 'TIMUR LAUT') return 45;
  if (word === 'TENGGARA') return 135;
  if (word === 'BARAT DAYA') return 225;
  if (word === 'BARAT LAUT') return 315;
  if (word === 'UTARA') return 0;
  if (word === 'TIMUR') return 90;
  if (word === 'SELATAN') return 180;
  if (word === 'BARAT') return 270;
  return NaN;
}
