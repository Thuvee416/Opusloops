const LEGACY_JWT_PATTERN = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;

function decodeClaims(segment) {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const claims = JSON.parse(atob(padded));
  return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
}

export function isLegacyStorageAnonKey(value, expectedProjectRef) {
  if (typeof value !== "string"
      || value.length < 32
      || value.length > 4096
      || !PROJECT_REF_PATTERN.test(expectedProjectRef || "")
      || Array.from(value).some((character) => character.charCodeAt(0) < 32)) {
    return false;
  }
  const match = LEGACY_JWT_PATTERN.exec(value);
  if (!match) return false;
  try {
    const claims = decodeClaims(match[2]);
    return claims?.role === "anon" && claims?.ref === expectedProjectRef;
  } catch {
    return false;
  }
}
