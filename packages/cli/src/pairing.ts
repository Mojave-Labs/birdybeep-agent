/**
 * CLI pairing client (device-authorization style). `login` starts a pairing session, shows
 * the user a short URL + code, and polls until the backend confirms — at which point a
 * durable machine token is issued and stored in the secure token store (never in config /
 * the QR). Per SPEC §11: the QR/pair URL carries only short-lived pairing info, never a token.
 *
 * ⚠ PROVISIONAL CROSS-REPO CONTRACT — the exact endpoint paths + field names below
 * (`/v1/cli/pair`, `/v1/cli/pair/poll`) are not yet pinned in the product repo; confirm
 * them with the backend before the live `birdybeep login` lands. The reader is tolerant
 * (best-effort field reads) so a shape tweak won't crash. No §10.1 event schema is involved.
 */
function base(apiUrl: string): string {
  return apiUrl.replace(/\/$/, "");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export interface PairingStart {
  /** Short URL the user opens (may be encoded into a QR); short-lived, no token. */
  pairUrl: string;
  /** Human-typeable code shown on the device (manual entry path). */
  userCode: string;
  /** Opaque token the CLI polls with (not the machine token). */
  pollToken: string;
  intervalMs: number;
  expiresInMs: number;
}

export interface PairingPoll {
  status: "pending" | "paired";
  /** Issued only once, on `paired`. Stored in the secure store — never logged/persisted in config. */
  machineToken?: string;
  machineLabel?: string;
}

/** Begin a pairing session. Returns the short-lived pair URL + code + poll token. */
export async function startPairing(apiUrl: string, fetchImpl: typeof fetch): Promise<PairingStart> {
  const res = await fetchImpl(`${base(apiUrl)}/v1/cli/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`pairing could not be started (HTTP ${res.status})`);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    pairUrl: str(body["pair_url"]) ?? "",
    userCode: str(body["user_code"]) ?? "",
    pollToken: str(body["poll_token"]) ?? "",
    intervalMs: num(body["interval_ms"], 2000),
    expiresInMs: num(body["expires_in_ms"], 300_000),
  };
}

/** Poll once for pairing completion. `paired` carries the durable machine token. */
export async function pollPairing(
  apiUrl: string,
  pollToken: string,
  fetchImpl: typeof fetch,
): Promise<PairingPoll> {
  const res = await fetchImpl(`${base(apiUrl)}/v1/cli/pair/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ poll_token: pollToken }),
  });
  if (!res.ok) throw new Error(`pairing poll failed (HTTP ${res.status})`);
  const body = (await res.json()) as Record<string, unknown>;
  const result: PairingPoll = { status: body["status"] === "paired" ? "paired" : "pending" };
  const token = str(body["machine_token"]);
  if (token !== undefined) result.machineToken = token;
  const label = str(body["machine_label"]);
  if (label !== undefined) result.machineLabel = label;
  return result;
}
