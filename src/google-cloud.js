import { createBackup, parseBackup } from "./backup.js?v=0.4.3";

const DRIVE_FILE_NAME = "substitute-fee-desk-data-v1.json";
const DEFAULT_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_RENEWAL_LEAD_MS = 5 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 15 * 1000;

export function tokenExpiresAt(token = "") {
  try {
    const encoded = String(token).split(".")[1];
    if (!encoded || typeof globalThis.atob !== "function") return 0;
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(globalThis.atob(normalized + padding));
    const expiresAt = Number(payload.exp) * 1000;
    return Number.isFinite(expiresAt) ? expiresAt : 0;
  } catch {
    return 0;
  }
}

function timestamp(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

export function decideAutomaticDriveChoice({ localMeta = {}, remoteExportedAt = "", ownerSub = "", localHasData = false }) {
  if (!localHasData) return "remote";
  if (!ownerSub || localMeta.driveOwnerSub !== ownerSub || !localMeta.lastSyncedAt) return "ask";

  const lastSync = timestamp(localMeta.lastSyncedAt);
  const localChanged = timestamp(localMeta.lastSavedAt) > lastSync;
  const remoteChanged = timestamp(remoteExportedAt) > lastSync;
  if (localChanged && remoteChanged) return "ask";
  if (localChanged) return "local";
  return "remote";
}

export function driveTokenRequestOptions(email = "") {
  const options = { prompt: "" };
  if (String(email || "").trim()) options.login_hint = String(email).trim();
  return options;
}

function hasMeaningfulData(state) {
  return Boolean(state?.people?.length || state?.cases?.length || state?.monthlyCloses?.length);
}

function loadGoogleScript() {
  if (globalThis.google?.accounts?.id && globalThis.google?.accounts?.oauth2) return Promise.resolve();
  const existing = document.querySelector("script[data-google-identity]");
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("Google 登入元件載入失敗")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error("Google 登入元件載入失敗")), { once: true });
    document.head.appendChild(script);
  });
}

export class GoogleCloudService {
  constructor({ apiBaseUrl, getState, applyRemoteState, chooseDriveData, onChange, onSync, autoConnectDrive = false, authHeartbeatMs = 5 * 60 * 1000 } = {}) {
    this.apiBaseUrl = String(apiBaseUrl || "").replace(/\/$/, "");
    this.getState = getState;
    this.applyRemoteState = applyRemoteState;
    this.chooseDriveData = chooseDriveData;
    this.onChange = onChange;
    this.onSync = onSync;
    this.autoConnectDrive = autoConnectDrive;
    this.authHeartbeatMs = authHeartbeatMs;
    this.phase = "initializing";
    this.message = "正在準備 Google 登入…";
    this.profile = null;
    this.clientId = "";
    this.driveScope = DEFAULT_DRIVE_SCOPE;
    this.idToken = "";
    this.idTokenExpiresAt = 0;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.driveFileId = "";
    this.tokenClient = null;
    this.saveTimer = null;
    this.saveInFlight = null;
    this.pendingState = null;
    this.saveRetryTimer = null;
    this.saveRetryCount = 0;
    this.authHeartbeatTimer = null;
    this.identityRefresh = null;
    this.driveTokenExpiryTimer = null;
  }

  snapshot() {
    return {
      phase: this.phase,
      message: this.message,
      configured: Boolean(this.clientId),
      profile: this.profile ? { ...this.profile } : null,
      connected: ["connected", "saving", "error", "reauthorization-needed", "authorizing-drive"].includes(this.phase) && Boolean(this.driveFileId),
      syncHealthy: ["connected", "saving"].includes(this.phase) && Boolean(this.driveFileId),
    };
  }

  update(phase, message) {
    this.phase = phase;
    this.message = message;
    this.onChange?.(this.snapshot());
  }

  async initialize() {
    if (!this.apiBaseUrl) {
      this.update("unavailable", "正式登入服務尚未設定網址");
      return;
    }
    try {
      const response = await fetch(`${this.apiBaseUrl}/auth/config`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("目前無法取得 Google 登入設定");
      const config = await response.json();
      if (!config.enabled || !config.client_id) throw new Error("Google OAuth Client ID 尚未設定");
      this.clientId = config.client_id;
      this.driveScope = config.drive_scope || DEFAULT_DRIVE_SCOPE;
      await loadGoogleScript();
      globalThis.google.accounts.id.initialize({
        client_id: this.clientId,
        callback: (responseValue) => this.handleCredential(responseValue),
        auto_select: true,
        cancel_on_tap_outside: true,
      });
      this.tokenClient = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: this.driveScope,
        callback: (responseValue) => this.handleDriveToken(responseValue),
        error_callback: () => this.update("signed-in", "瀏覽器需要再次確認資料儲存授權，請按下方按鈕繼續"),
      });
      this.update("ready", "請使用教育網域 Google 帳號登入");
    } catch (error) {
      this.update("unavailable", error.message || "Google 登入服務無法使用");
    }
  }

  mountSignInButton(target) {
    if (!target || !this.clientId || !globalThis.google?.accounts?.id || this.profile) return;
    target.replaceChildren();
    const width = Math.max(240, Math.min(360, Math.floor(target.getBoundingClientRect().width || 340)));
    globalThis.google.accounts.id.renderButton(target, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "pill",
      logo_alignment: "left",
      width: String(width),
      locale: "zh_TW",
    });
  }

  async apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${this.idToken}`);
    headers.set("Accept", "application/json");
    let body = options.body;
    if (body && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...options,
      headers,
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.detail || `登入服務回應 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  listLoginAccounts() {
    return this.apiRequest("/admin/accounts");
  }

  updateLoginAccount(subject, enabled) {
    return this.apiRequest(`/admin/accounts/${encodeURIComponent(subject)}`, {
      method: "PATCH",
      body: { enabled: Boolean(enabled) },
    });
  }

  finishIdentityRefresh(error, profile = null) {
    const pending = this.identityRefresh;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.identityRefresh = null;
    if (error) pending.reject(error);
    else pending.resolve(profile);
  }

  refreshIdentityToken() {
    if (this.identityRefresh) return this.identityRefresh.promise;
    const identityApi = globalThis.google?.accounts?.id;
    if (!this.profile || typeof identityApi?.prompt !== "function") {
      return Promise.reject(new Error("Google 登入需要重新確認"));
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      this.finishIdentityRefresh(new Error("Google 登入續期逾時"));
    }, TOKEN_REQUEST_TIMEOUT_MS);
    timer?.unref?.();
    this.identityRefresh = { promise, resolve: resolvePromise, reject: rejectPromise, timer };

    try {
      identityApi.prompt((notification) => {
        if (!this.identityRefresh) return;
        const unavailable = notification?.isNotDisplayed?.()
          || notification?.isSkippedMoment?.()
          || notification?.isDismissedMoment?.();
        if (unavailable) this.finishIdentityRefresh(new Error("Google 登入需要重新確認"));
      });
    } catch (error) {
      this.finishIdentityRefresh(error);
    }
    return promise;
  }

  nextAuthorizationCheckDelay() {
    if (!this.idTokenExpiresAt) return this.authHeartbeatMs;
    const untilRenewal = this.idTokenExpiresAt - Date.now() - TOKEN_RENEWAL_LEAD_MS;
    return Math.max(1000, Math.min(this.authHeartbeatMs, untilRenewal));
  }

  requireReauthentication(message = "Google 登入已到期，請重新登入；尚未同步的修改仍保存在本機") {
    this.signOut();
    this.update("denied", message);
  }

  startAuthorizationHeartbeat(delay = this.nextAuthorizationCheckDelay()) {
    this.stopAuthorizationHeartbeat();
    if (!this.idToken || !this.authHeartbeatMs) return;
    this.authHeartbeatTimer = setTimeout(async () => {
      this.authHeartbeatTimer = null;
      try {
        if (this.idTokenExpiresAt && Date.now() >= this.idTokenExpiresAt - TOKEN_RENEWAL_LEAD_MS) {
          await this.refreshIdentityToken();
        } else {
          this.profile = await this.apiRequest("/auth/me");
        }
        this.startAuthorizationHeartbeat();
      } catch (error) {
        if (error.status === 403) {
          this.requireReauthentication(error.message || "此帳號目前無法使用系統");
          return;
        }
        if (error.status === 401) {
          try {
            await this.refreshIdentityToken();
            this.startAuthorizationHeartbeat();
            return;
          } catch {
            this.requireReauthentication();
            return;
          }
        }
        if (this.idTokenExpiresAt && Date.now() >= this.idTokenExpiresAt) {
          this.requireReauthentication();
          return;
        }
        this.startAuthorizationHeartbeat(Math.min(this.authHeartbeatMs, 60 * 1000));
      }
    }, Math.max(0, Number(delay) || this.authHeartbeatMs));
    this.authHeartbeatTimer?.unref?.();
  }

  stopAuthorizationHeartbeat() {
    clearTimeout(this.authHeartbeatTimer);
    this.authHeartbeatTimer = null;
  }

  async handleCredential(response) {
    const renewing = Boolean(this.profile);
    const previousToken = this.idToken;
    const previousExpiresAt = this.idTokenExpiresAt;
    try {
      this.idToken = response?.credential || "";
      if (!this.idToken) throw new Error("Google 未回傳登入憑證");
      this.idTokenExpiresAt = tokenExpiresAt(this.idToken);
      if (!renewing) this.update("verifying", "正在由伺服端確認帳號資格…");
      this.profile = await this.apiRequest("/auth/me");
      this.startAuthorizationHeartbeat();
      if (renewing) {
        this.finishIdentityRefresh(null, this.profile);
        return;
      }
      if (this.autoConnectDrive && this.tokenClient) {
        this.update("authorizing-drive", "帳號已確認，正在接續 Google Drive 資料儲存授權…");
        try {
          this.tokenClient.requestAccessToken(driveTokenRequestOptions(this.profile.email));
          return;
        } catch {
          this.update("signed-in", "瀏覽器需要再次確認資料儲存授權，請按下方按鈕繼續");
          return;
        }
      }
      this.update("signed-in", "帳號已確認，請繼續授權資料儲存");
    } catch (error) {
      if (renewing) {
        this.idToken = previousToken;
        this.idTokenExpiresAt = previousExpiresAt;
        this.finishIdentityRefresh(error);
        return;
      }
      this.stopAuthorizationHeartbeat();
      this.idToken = "";
      this.idTokenExpiresAt = 0;
      this.profile = null;
      this.update("denied", error.message || "此帳號無法使用系統");
    }
  }

  requestDriveAccess() {
    if (!this.profile || !this.tokenClient) {
      this.update("ready", "請先使用 Google 帳號登入");
      return;
    }
    this.update("authorizing-drive", "正在取得個人 Google Drive 儲存權限…");
    this.tokenClient.requestAccessToken(driveTokenRequestOptions(this.profile.email));
  }

  scheduleDriveTokenExpiry() {
    clearTimeout(this.driveTokenExpiryTimer);
    const delay = Math.max(0, this.accessTokenExpiresAt - Date.now());
    this.driveTokenExpiryTimer = setTimeout(() => this.markDriveReauthorizationNeeded(), delay);
    this.driveTokenExpiryTimer?.unref?.();
  }

  markDriveReauthorizationNeeded() {
    clearTimeout(this.driveTokenExpiryTimer);
    this.driveTokenExpiryTimer = null;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    if (this.driveFileId) {
      this.update("reauthorization-needed", "Drive 連線已到期；修改仍保存在本機，請按帳號按鈕重新連接後補同步");
    }
  }

  async handleDriveToken(response) {
    if (!response?.access_token || response.error) {
      this.update(this.driveFileId ? "reauthorization-needed" : "signed-in", "Google Drive 授權未完成，資料仍保存在本機");
      return;
    }
    const requestedScopes = String(this.driveScope || "").split(/\s+/).filter(Boolean);
    const scopeChecker = globalThis.google?.accounts?.oauth2?.hasGrantedAllScopes;
    if (requestedScopes.length && typeof scopeChecker === "function" && !scopeChecker(response, ...requestedScopes)) {
      this.update(this.driveFileId ? "reauthorization-needed" : "signed-in", "尚未同意資料儲存權限，請按下方按鈕重新授權");
      return;
    }
    this.accessToken = response.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in || 3600) - 60) * 1000;
    this.scheduleDriveTokenExpiry();
    if (this.driveFileId) {
      this.update("connected", this.pendingState ? "Google Drive 已重新連接，正在補同步本機修改" : "Google Drive 已重新連接");
      if (this.pendingState) queueMicrotask(() => this.flushSave());
      return;
    }
    try {
      await this.connectDrive();
    } catch (error) {
      this.update("error", error.message || "Google Drive 連接失敗");
    }
  }

  async driveFetch(url, options = {}) {
    if (!this.accessToken || Date.now() >= this.accessTokenExpiresAt) {
      this.markDriveReauthorizationNeeded();
      throw new Error("Google Drive 連線已到期，請按帳號按鈕重新連接");
    }
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      this.markDriveReauthorizationNeeded();
      throw new Error("Google Drive 連線已到期，請按帳號按鈕重新連接");
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error?.message || `Google Drive 回應 ${response.status}`);
    }
    return response;
  }

  async findDriveFile() {
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name='${DRIVE_FILE_NAME}' and trashed=false`,
      fields: "files(id,name,modifiedTime,size)",
      orderBy: "modifiedTime desc",
      pageSize: "1",
    });
    const response = await this.driveFetch(`${DRIVE_API}/files?${params}`);
    const payload = await response.json();
    return payload.files?.[0] || null;
  }

  async readDriveBackup(fileId) {
    const response = await this.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
    const result = parseBackup(await response.text());
    if (!result.ok) throw new Error(`Drive 主檔無法讀取：${result.error}`);
    return result.payload;
  }

  async createDriveFile(state) {
    const boundary = `fee-desk-${crypto.randomUUID()}`;
    const metadata = {
      name: DRIVE_FILE_NAME,
      parents: ["appDataFolder"],
      appProperties: { app: "substitute-fee-desk", schema: "1" },
    };
    const backup = createBackup(state);
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(backup),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const response = await this.driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,modifiedTime`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return { ...(await response.json()), syncedAt: backup.exportedAt };
  }

  async updateDriveFile(state) {
    const backup = createBackup(state);
    const response = await this.driveFetch(
      `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(this.driveFileId)}?uploadType=media&fields=id,modifiedTime`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(backup),
      },
    );
    await response.json();
    return backup.exportedAt;
  }

  async connectDrive() {
    this.update("loading-drive", "正在讀取個人 Google Drive 資料…");
    const file = await this.findDriveFile();
    let syncedAt = "";
    if (!file) {
      const created = await this.createDriveFile(this.getState());
      this.driveFileId = created.id;
      syncedAt = created.syncedAt;
    } else {
      this.driveFileId = file.id;
      const remote = await this.readDriveBackup(file.id);
      const localState = this.getState();
      let choice = decideAutomaticDriveChoice({
        localMeta: localState.meta,
        remoteExportedAt: remote.exportedAt,
        ownerSub: this.profile.subject,
        localHasData: hasMeaningfulData(localState),
      });
      if (choice === "ask") choice = await this.chooseDriveData?.({ remote, file, profile: this.profile }) || "remote";
      if (choice === "cancel") {
        this.driveFileId = "";
        this.update("signed-in", "已取消連接；資料仍保存在本機");
        return;
      }
      if (choice === "local") syncedAt = await this.updateDriveFile(localState);
      else {
        this.applyRemoteState(remote.state);
        syncedAt = remote.exportedAt || file.modifiedTime;
      }
    }
    this.onSync?.({ ownerSub: this.profile.subject, syncedAt, fileId: this.driveFileId });
    this.update("connected", "Google Drive 已連接，之後的修改會自動同步");
  }

  queueSave(state) {
    if (!this.driveFileId || !["connected", "saving", "error", "reauthorization-needed"].includes(this.phase)) return;
    this.pendingState = structuredClone(state);
    clearTimeout(this.saveTimer);
    clearTimeout(this.saveRetryTimer);
    this.saveRetryTimer = null;
    this.saveRetryCount = 0;
    if (!this.accessToken || Date.now() >= this.accessTokenExpiresAt || this.phase === "reauthorization-needed") {
      this.markDriveReauthorizationNeeded();
      return;
    }
    if (this.phase === "error") this.update("connected", "偵測到新修改，將重新同步 Google Drive");
    this.saveTimer = setTimeout(() => this.flushSave(), 850);
  }

  async flushSave() {
    if (this.saveInFlight || !this.pendingState) return;
    const nextState = this.pendingState;
    this.pendingState = null;
    this.update("saving", "正在同步 Google Drive…");
    this.saveInFlight = this.updateDriveFile(nextState);
    try {
      const syncedAt = await this.saveInFlight;
      clearTimeout(this.saveRetryTimer);
      this.saveRetryTimer = null;
      this.saveRetryCount = 0;
      this.onSync?.({ ownerSub: this.profile.subject, syncedAt, fileId: this.driveFileId });
      this.update("connected", "Google Drive 已同步");
    } catch (error) {
      if (!this.pendingState) this.pendingState = nextState;
      if (this.phase === "reauthorization-needed") {
        this.update("reauthorization-needed", `${error.message}；修改仍保存在本機，重新連接後會自動補同步`);
        return;
      }
      this.saveRetryCount += 1;
      const willRetry = this.saveRetryCount <= 3;
      const retryDelay = Math.min(1500 * (2 ** (this.saveRetryCount - 1)), 6000);
      this.update("error", `${error.message}；修改仍保存在本機${willRetry ? "，系統將自動重試" : "，請稍後再修改一次以重新同步"}`);
      if (willRetry) {
        clearTimeout(this.saveRetryTimer);
        this.saveRetryTimer = setTimeout(() => {
          this.saveRetryTimer = null;
          this.flushSave();
        }, retryDelay);
      }
    } finally {
      this.saveInFlight = null;
      if (this.pendingState && this.phase === "connected") this.flushSave();
    }
  }

  signOut() {
    clearTimeout(this.saveTimer);
    clearTimeout(this.saveRetryTimer);
    this.pendingState = null;
    this.saveRetryTimer = null;
    this.saveRetryCount = 0;
    this.stopAuthorizationHeartbeat();
    this.finishIdentityRefresh(new Error("已登出"));
    clearTimeout(this.driveTokenExpiryTimer);
    this.driveTokenExpiryTimer = null;
    this.idToken = "";
    this.idTokenExpiresAt = 0;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.driveFileId = "";
    this.profile = null;
    globalThis.google?.accounts?.id?.disableAutoSelect();
    this.update("ready", "已登出；本機仍保留最近一次資料");
  }
}
