/*
 * Narrow, reviewed corrections for ambiguous MOHW address text. A correction
 * only selects a doorplate key; the coordinate must still come from a
 * same-county, signed official address pack.
 */
const REVIEWED_ADDRESS_CORRECTIONS = Object.freeze([
  Object.freeze({
    id: 'medical-address-correction-3501015544',
    institutionCode: '3501015544',
    sourceAddress: '臺北市松山區南京東路5段166、168號11樓',
    correctedAddress: '臺北市松山區南京東路5段168號11樓',
    evidence: 'User-provided Google Maps screenshots and explicit confirmation, 2026-10-06',
  }),
]);

export function findReviewedMedicalAddressCorrection(unresolved) {
  const institutionCode = String(unresolved?.source_record?.機構代碼 ?? '').trim();
  if (!institutionCode || typeof unresolved?.address !== 'string') return null;
  return REVIEWED_ADDRESS_CORRECTIONS.find((correction) =>
    correction.institutionCode === institutionCode
    && correction.sourceAddress === unresolved.address) ?? null;
}

/** Include a reviewed replacement doorplate in exact address-pack lookups. */
export function medicalCoordinateAddressTexts(unresolvedRecords = []) {
  if (!Array.isArray(unresolvedRecords)) {
    throw new TypeError('medical address lookup records must be an array');
  }
  return [...new Set(unresolvedRecords.flatMap((record) => [
    record?.address,
    findReviewedMedicalAddressCorrection(record)?.correctedAddress,
  ]).filter((address) => typeof address === 'string' && address.trim().length > 0))];
}
