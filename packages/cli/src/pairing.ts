/**
 * CLI pairing client — the device-code flow (§7.2/§13.4). `pairStart` opens a session via
 * `POST /v1/pair/start`; the CLI shows `qr_payload` + `user_code`, then polls
 * `POST /v1/pair/token` (`pairTokenPoll`) until it returns 201 `{ machine_token, machine_id }`
 * or the `expires_at` deadline. A `validation_failed`/4xx during polling means "not approved
 * yet — keep polling". Per SPEC §11 the QR / user code carries only short-lived pairing info,
 * NEVER a durable token. Request/response shapes are mirrored from the product (agent-core).
 */
import {
  type ErrorCode,
  errorEnvelopeSchema,
  type PairStartResponse,
  pairStartResponseSchema,
  pairTokenResponseSchema,
} from "@birdybeep/agent-core";

function base(apiUrl: string): string {
  return apiUrl.replace(/\/$/, "");
}

export interface PairStartInput {
  /** Required — the human machine label (derived from hostname/OS). */
  machineLabel: string;
  os?: string;
  cliVersion?: string;
  /**
   * PKCE S256 challenge = base64url(sha256(codeVerifier)) (dgxd). When present, the session is
   * BOUND to this CLI: the product's `/pair/token` then requires the matching `codeVerifier`.
   * Omit to keep the legacy device_code-only path (backward compatible with older servers).
   */
  codeChallenge?: string;
}

/** Begin a pairing session (`POST /v1/pair/start`, unauthenticated). */
export async function pairStart(
  apiUrl: string,
  input: PairStartInput,
  fetchImpl: typeof fetch,
): Promise<PairStartResponse> {
  const body = {
    machine_label: input.machineLabel,
    ...(input.os !== undefined ? { os: input.os } : {}),
    ...(input.cliVersion !== undefined ? { cli_version: input.cliVersion } : {}),
    ...(input.codeChallenge !== undefined ? { code_challenge: input.codeChallenge } : {}),
  };
  const res = await fetchImpl(`${base(apiUrl)}/v1/pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pairing could not be started (HTTP ${res.status})`);
  const parsed = pairStartResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("pairing start returned an unexpected response shape");
  return parsed.data;
}

export type PairTokenResult =
  | { status: "pending" }
  | { status: "paired"; machineToken: string; machineId: string; approvedByEmail?: string }
  /**
   * The backend returned an outcome that will NOT resolve by waiting (`retryable: false`,
   * e.g. `quota_exceeded` — the install cap is hit) or a transient server-side failure
   * (`retryable: true`, e.g. `internal_error`/5xx). Surfacing these is what stops `pair`
   * from masking a real error as "not approved yet" and hanging silently until timeout.
   */
  | { status: "error"; code: ErrorCode | "unknown"; message: string; retryable: boolean };

/**
 * Terminal error codes on `/v1/pair/token`: waiting can never turn them into a 201, so the
 * CLI must STOP polling and show the user the reason. `quota_exceeded` (the agent-install cap)
 * is the one a real user actually hits; the auth-shaped codes should never occur on this
 * unauthenticated endpoint but are treated as terminal defensively (never loop forever).
 */
const TERMINAL_TOKEN_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "quota_exceeded",
  "unauthorized",
  "forbidden",
  "token_revoked",
  "not_found",
  "payload_too_large",
]);

/**
 * Poll once for the device token (`POST /v1/pair/token`, unauthenticated). Outcomes:
 *   - 201 with a valid token body → `paired`.
 *   - `validation_failed`/4xx (the documented "not approved yet" signal) → `pending`, so the
 *     caller keeps polling until the `expires_at` deadline.
 *   - a TERMINAL error (e.g. `quota_exceeded`) → `error` with `retryable: false` — the caller
 *     surfaces it and stops, instead of hanging silently on a failure waiting can't fix.
 *   - `rate_limited`/`internal_error`/5xx/unparseable → `error` with `retryable: true` — the
 *     caller keeps polling (transient) but can warn if it persists.
 */
export async function pairTokenPoll(
  apiUrl: string,
  deviceCode: string,
  fetchImpl: typeof fetch,
  machineFingerprint?: string,
  /**
   * PKCE verifier (dgxd) — the secret whose sha256 was committed as `code_challenge` on
   * `/pair/start`. Sent on EVERY poll: when the session was started with a challenge the server
   * requires it and checks `sha256Base64Url(verifier) === stored challenge`. Held in memory only;
   * never written to disk. Omit for a legacy (no-challenge) session.
   */
  codeVerifier?: string,
): Promise<PairTokenResult> {
  const body = {
    device_code: deviceCode,
    ...(machineFingerprint !== undefined ? { machine_fingerprint: machineFingerprint } : {}),
    ...(codeVerifier !== undefined ? { code_verifier: codeVerifier } : {}),
  };
  const res = await fetchImpl(`${base(apiUrl)}/v1/pair/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    const parsed = pairTokenResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { status: "pending" };
    return {
      status: "paired",
      machineToken: parsed.data.machine_token,
      machineId: parsed.data.machine_id,
      // Only surface the key when the server reported it (exactOptionalPropertyTypes: no explicit
      // undefined). Older servers omit approved_by_email; newer ones (dgxd) include it.
      ...(parsed.data.approved_by_email !== undefined
        ? { approvedByEmail: parsed.data.approved_by_email }
        : {}),
    };
  }

  // Non-2xx: read the typed §13.4 error envelope to tell "not approved yet" (keep polling)
  // apart from a real failure the user must see. A body that isn't a parseable envelope falls
  // back to the status code.
  let errBody: unknown = null;
  try {
    errBody = await res.json();
  } catch {
    /* empty / non-JSON error body → classify by status below */
  }
  const env = errorEnvelopeSchema.safeParse(errBody);
  const code = env.success ? env.data.error.code : undefined;

  // "not approved yet" is the documented benign signal → keep polling. Also treat any
  // unclassifiable 4xx (except 429) as pending, preserving the endpoint's historical
  // accept-and-keep-waiting behavior.
  if (
    code === "validation_failed" ||
    (code === undefined && res.status >= 400 && res.status < 500 && res.status !== 429)
  ) {
    return { status: "pending" };
  }

  const message = env.success ? env.data.error.message : `pairing failed (HTTP ${res.status})`;
  if (code !== undefined && TERMINAL_TOKEN_ERRORS.has(code)) {
    return { status: "error", code, message, retryable: false };
  }
  // rate_limited / internal_error / any 5xx / unrecognized → transient; safe to keep polling.
  return { status: "error", code: code ?? "unknown", message, retryable: true };
}
