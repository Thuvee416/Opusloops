const ACCOUNT_EXISTS_CODES = new Set([
  "email_exists",
  "user_already_exists",
]);

const USER_VALIDATION_CODES = new Set([
  "email_address_invalid",
  "validation_failed",
  "weak_password",
]);

export function extractAuthErrorCode(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const modernCode = typeof body.code === "string" ? body.code.trim() : "";
  if (modernCode && !/^\d+$/.test(modernCode)) return modernCode;
  const legacyCode = typeof body.error_code === "string" ? body.error_code.trim() : "";
  return legacyCode || modernCode;
}

export function isAccountExistsAuthCode(code) {
  const normalizedCode = typeof code === "string" ? code.trim().toLowerCase() : "";
  return ACCOUNT_EXISTS_CODES.has(normalizedCode);
}

export function classifyAuthCreateFailure(status, code) {
  const normalizedCode = typeof code === "string" ? code.trim().toLowerCase() : "";

  if (!Number.isInteger(status) || status >= 500) {
    return {
      status: 503,
      body: {
        code: "signup_unavailable",
        message: "Account creation is temporarily unavailable",
      },
    };
  }

  if (isAccountExistsAuthCode(normalizedCode)) {
    return {
      status: 409,
      body: {
        code: "account_exists",
        message: "An account already uses this email",
      },
    };
  }

  if ((status === 400 || status === 422) && USER_VALIDATION_CODES.has(normalizedCode)) {
    const weakPassword = normalizedCode === "weak_password";
    return {
      status: 400,
      body: {
        code: weakPassword ? "weak_password" : "invalid_account_details",
        message: weakPassword
          ? "Choose a stronger password"
          : "Check the email and password, then try again",
      },
    };
  }

  return {
    status: 503,
    body: {
      code: "signup_unavailable",
      message: "Account creation is temporarily unavailable",
    },
  };
}

export async function verifyBooleanOperation(operation, attempts) {
  const attemptCount = Math.max(1, Math.trunc(attempts));
  for (let attempt = 0; attempt < attemptCount; attempt += 1) {
    try {
      if (await operation() === true) return true;
    } catch {
      // The caller decides whether a failed verification is safe to surface.
    }
  }
  return false;
}
