const runtime = globalThis.FEE_AUTH_CONFIG || {};
const localHost = globalThis.location && ["127.0.0.1", "localhost", "::1"].includes(globalThis.location.hostname);

export function requiresCloudLogin(hostname = "") {
  return !["127.0.0.1", "localhost", "::1"].includes(String(hostname || "").toLowerCase());
}

export const APP_CONFIG = Object.freeze({
  apiBaseUrl: String(runtime.apiBaseUrl || (localHost ? "http://127.0.0.1:8767" : "")).replace(/\/$/, ""),
});
