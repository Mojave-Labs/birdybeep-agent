/**
 * CLI pairing client — the device-code flow (§7.2/§13.4). `pairStart` opens a session via
 * `POST /v1/pair/start`; the CLI shows `qr_payload` + `user_code`, then polls
 * `POST /v1/pair/token` (`pairTokenPoll`) until it returns 201 `{ machine_token, machine_id }`
 * or the `expires_at` deadline. A `validation_failed`/4xx during polling means "not approved
 * yet — keep polling". Per SPEC §11 the QR / user code carries only short-lived pairing info,
 * NEVER a durable token. Request/response shapes are mirrored from the product (agent-core).
 */
import {
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
  | { status: "paired"; machineToken: string; machineId: string };

/**
 * Poll once for the device token (`POST /v1/pair/token`, unauthenticated). A 201 with a valid
 * token body → paired; ANY other outcome (incl. a `validation_failed`/4xx before the user has
 * approved) → pending, so the caller keeps polling until the `expires_at` deadline.
 */
export async function pairTokenPoll(
  apiUrl: string,
  deviceCode: string,
  fetchImpl: typeof fetch,
  machineFingerprint?: string,
): Promise<PairTokenResult> {
  const body = {
    device_code: deviceCode,
    ...(machineFingerprint !== undefined ? { machine_fingerprint: machineFingerprint } : {}),
  };
  const res = await fetchImpl(`${base(apiUrl)}/v1/pair/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { status: "pending" }; // validation_failed / 4xx → not approved yet
  const parsed = pairTokenResponseSchema.safeParse(await res.json());
  if (!parsed.success) return { status: "pending" };
  return {
    status: "paired",
    machineToken: parsed.data.machine_token,
    machineId: parsed.data.machine_id,
  };
}
