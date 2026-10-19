// This is a confirmation threshold, not a portable-format size limit. Saved
// projects may grow past it through recording, imports and duplicated media.
export const LARGE_PROJECT_BYTES = 150 * 1024 * 1024;
export function largeProjectMessage({size}) {
  return `Open This Large Project (${Math.ceil(size / 1024 / 1024)} MB)?\n\nLoading Embedded Audio May Take Time And Use Substantial Memory. Your Current Set Will Be Kept As The Previous Set After A Successful Open. Continue?`;
}

// Confirmation precedes allocation/parsing. Callers retain their normal lock,
// stale-state checks and durable replacement transaction.
export async function readProjectFile(file, validate, {confirmLarge, signal} = {}) {
  signal?.throwIfAborted();
  if (!file) return null;
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Invalid Project File Size.');
  if (file.size > LARGE_PROJECT_BYTES) {
    if (!confirmLarge) throw new Error('Projects Larger Than 150 MB Require Confirmation Before Opening.');
    const approved = await confirmLarge({size:file.size});
    signal?.throwIfAborted();
    if (approved !== true) throw new DOMException('Project Opening Cancelled', 'AbortError');
  }
  const text = await file.text();
  signal?.throwIfAborted();
  return validate(JSON.parse(text));
}

// write must commit the two entries in one transaction. Do not install until it succeeds.
export async function replaceStoredProject({current, next, validate, write, install}) {
  const prepared = validate(structuredClone(next));
  const previous = structuredClone(current);
  await write([['previous', previous], ['current', prepared]]);
  install(prepared);
  return prepared;
}
