import { app } from "electron";

export function isAirGapped(): boolean {
  const hasAirGapSwitch =
    typeof app?.commandLine?.hasSwitch === "function" &&
    app.commandLine.hasSwitch("air-gapped");
  return (
    hasAirGapSwitch ||
    process.env.VESSEL_AIR_GAPPED === "1"
  );
}

/** Allowlisted provider IDs that do not require external API calls. */
const LOCAL_PROVIDER_IDS = new Set(["ollama", "llama_cpp"]);

export function isLocalProvider(providerId: string): boolean {
  return LOCAL_PROVIDER_IDS.has(providerId);
}

export function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

/** Check if a base URL refers to localhost. */
export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return isLocalHostname(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function getAirGapBlockReason(url: string): string | null {
  if (!isAirGapped()) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  return isLocalHostname(parsed.hostname)
    ? null
    : `Air-gapped mode blocked network access to ${parsed.hostname}.`;
}
