import { canonicalAssetUuid, canonicalV4Uuid } from "./validation.ts";

Deno.test("signed-download accepts a deterministic UUIDv5 asset ID", () => {
  const assetId = "12345678-1234-5678-9234-1234567890ab";
  if (canonicalAssetUuid(assetId.toUpperCase()) !== assetId) {
    throw new Error("canonical UUIDv5 asset ID was rejected");
  }
});

Deno.test("job and project identifiers remain UUIDv4-only", () => {
  if (canonicalV4Uuid("12345678-1234-5678-9234-1234567890ab") !== null) {
    throw new Error("UUIDv5 unexpectedly passed the UUIDv4 boundary");
  }
  if (canonicalV4Uuid("12345678-1234-4678-9234-1234567890ab") === null) {
    throw new Error("canonical UUIDv4 was rejected");
  }
});
