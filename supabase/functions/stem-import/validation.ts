const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canonicalV4Uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_V4.test(value) ? value.toLowerCase() : null;
}

export function canonicalAssetUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_CANONICAL.test(value) ? value.toLowerCase() : null;
}
