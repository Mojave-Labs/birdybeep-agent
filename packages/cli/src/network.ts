import tls from "node:tls";

interface SystemCaApi {
  getCACertificates?: (type: "default" | "system") => string[];
  setDefaultCACertificates?: (certificates: string[]) => void;
}

/** Executable startup only: embedding the library must not change its host's TLS defaults. */
export function configureSystemTrust(api: SystemCaApi = tls): boolean {
  if (!api.getCACertificates || !api.setDefaultCACertificates) return false;
  try {
    const certificates = new Set([
      ...api.getCACertificates("default"),
      ...api.getCACertificates("system"),
    ]);
    api.setDefaultCACertificates([...certificates]);
    return true;
  } catch {
    // Keep Node's existing verification when the OS store is unavailable (3pl).
    return false;
  }
}

export interface CertificateFailure {
  detail: string;
  remedy: string;
}

const TRUST_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
]);

/** Read only known TLS codes; nested error messages can contain private proxy credentials. */
export function certificateFailure(error: unknown): CertificateFailure | undefined {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0 && visited.size < 32) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const { code, cause, errors } = current as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof code === "string") {
      let remedy: string | undefined;
      if (TRUST_ERRORS.has(code)) {
        const upgrade =
          typeof tls.setDefaultCACertificates !== "function"
            ? "Update to Node 22.19+ or 24.6+ for system certificate support. "
            : "";
        remedy =
          upgrade +
          "If your network inspects HTTPS, ask your IT team to install its root certificate " +
          "in the system trust store or provide a PEM file for NODE_EXTRA_CA_CERTS.";
      } else if (code === "CERT_HAS_EXPIRED" || code === "CERT_NOT_YET_VALID") {
        remedy = "Check your computer's date and time and contact support about the certificate.";
      } else if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
        remedy =
          "The certificate does not match the API hostname. Contact your IT team or support.";
      }
      if (remedy) return { detail: `Certificate verification failed (${code}).`, remedy };
    }
    pending.push(cause);
    if (Array.isArray(errors)) pending.push(...(errors as unknown[]).slice(0, 32));
  }
  return undefined;
}

export function commandErrorMessage(error: unknown): string {
  const certificate = certificateFailure(error);
  return certificate
    ? `${certificate.detail} ${certificate.remedy}`
    : error instanceof Error
      ? error.message
      : String(error);
}
