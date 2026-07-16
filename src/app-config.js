const runtime = globalThis.FEE_AUTH_CONFIG || {};
const localHost = globalThis.location && ["127.0.0.1", "localhost"].includes(globalThis.location.hostname);

export const APP_CONFIG = Object.freeze({
  apiBaseUrl: String(runtime.apiBaseUrl || (localHost ? "http://127.0.0.1:8767" : "")).replace(/\/$/, ""),
});
