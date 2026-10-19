// File opening and New/Restore use the same durable replacement boundary.
export async function readProjectFile(file, validate) {
  if (!file) return null;
  if (file.size > 150 * 1024 * 1024) throw new Error('Project files must be smaller than 150 MB.');
  return validate(JSON.parse(await file.text()));
}

// write must commit the two entries in one transaction. Do not install until it succeeds.
export async function replaceStoredProject({current, next, validate, write, install}) {
  const prepared = validate(structuredClone(next));
  const previous = structuredClone(current);
  await write([['previous', previous], ['current', prepared]]);
  install(prepared);
  return prepared;
}
