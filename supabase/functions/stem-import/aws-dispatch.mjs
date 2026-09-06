export class DispatchError extends Error {
  constructor(ambiguous) {
    super("AWS Batch dispatch failed");
    this.name = "DispatchError";
    this.ambiguous = ambiguous === true;
  }
}

export function isAmbiguousAwsBatchStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function dispatchFailureRpcName(error) {
  return error instanceof DispatchError && error.ambiguous
    ? "record_stem_dispatch_unknown"
    : "record_stem_dispatch_error";
}

export async function fetchAwsBatch(fetchImpl, input, init) {
  try {
    return await fetchImpl(input, init);
  } catch {
    throw new DispatchError(true);
  }
}

export async function requireAwsBatchJson(response) {
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The HTTP status remains authoritative even if response cleanup fails.
    }
    throw new DispatchError(isAmbiguousAwsBatchStatus(response.status));
  }

  let text;
  try {
    text = await response.text();
  } catch {
    throw new DispatchError(true);
  }

  let result;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    throw new DispatchError(true);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new DispatchError(true);
  }
  return result;
}
