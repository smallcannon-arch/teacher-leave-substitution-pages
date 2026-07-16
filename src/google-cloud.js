import { createBackup, parseBackup } from "./backup.js";

const DRIVE_FILE_NAME = "substitute-fee-desk-data-v1.json";
const DEFAULT_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

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
  constructor({ apiBaseUrl, getState, applyRemoteState, chooseDriveData, onChange, onSync }) {
    this.apiBaseUrl = String(apiBaseUrl || "").replace(/\/$/, "");
    this.getState = getState;
    this.applyRemoteState = applyRemoteState;
    this.chooseDriveData = chooseDriveData;
    this.onChange = onChange;
    this.onSync = onSync;
    this.phase = "initializing";
    this.message = "正在準備 Google 登入…";
    this.profile = null;
    this.clientId = "";
    this.driveScope = DEFAULT_DRIVE_SCOPE;
    this.idToken = "";
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.driveFileId = "";
    this.tokenClient = null;
    this.saveTimer = null;
    this.saveInFlight = null;
    this.pendingState = null;
  }

  snapshot() {
    return {
      phase: this.phase,
      message: this.message,
      configured: Boolean(this.clientId),
      profile: this.profile ? { ...this.profile } : null,
      connected: this.phase === "connected" || this.phase === "saving",
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
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      this.tokenClient = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: this.driveScope,
        callback: (responseValue) => this.handleDriveToken(responseValue),
        error_callback: () => this.update("signed-in", "Google Drive 授權未完成，資料仍保存在本機"),
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

  async apiRequest(path) {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.idToken}`, Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `登入服務回應 ${response.status}`);
    return payload;
  }

  async handleCredential(response) {
    try {
      this.idToken = response?.credential || "";
      if (!this.idToken) throw new Error("Google 未回傳登入憑證");
      this.update("verifying", "正在由伺服端確認帳號資格…");
      this.profile = await this.apiRequest("/auth/me");
      this.update("signed-in", "帳號已確認，請連接個人 Google Drive");
    } catch (error) {
      this.idToken = "";
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
    this.tokenClient.requestAccessToken();
  }

  async handleDriveToken(response) {
    if (!response?.access_token || response.error) {
      this.update("signed-in", "Google Drive 授權未完成，資料仍保存在本機");
      return;
    }
    this.accessToken = response.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, Number(response.expires_in || 3600) - 60) * 1000;
    try {
      await this.connectDrive();
    } catch (error) {
      this.update("error", error.message || "Google Drive 連接失敗");
    }
  }

  async driveFetch(url, options = {}) {
    if (!this.accessToken || Date.now() >= this.accessTokenExpiresAt) {
      this.accessToken = "";
      throw new Error("Google Drive 授權已過期，請重新連接");
    }
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      this.accessToken = "";
      throw new Error("Google Drive 授權已過期，請重新連接");
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
    if (!this.driveFileId || !this.accessToken || !["connected", "saving"].includes(this.phase)) return;
    this.pendingState = structuredClone(state);
    clearTimeout(this.saveTimer);
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
      this.onSync?.({ ownerSub: this.profile.subject, syncedAt, fileId: this.driveFileId });
      this.update("connected", "Google Drive 已同步");
    } catch (error) {
      this.update("error", `${error.message}；本次修改仍保存在本機`);
    } finally {
      this.saveInFlight = null;
      if (this.pendingState && this.phase === "connected") this.flushSave();
    }
  }

  signOut() {
    clearTimeout(this.saveTimer);
    this.pendingState = null;
    this.idToken = "";
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.driveFileId = "";
    this.profile = null;
    globalThis.google?.accounts?.id?.disableAutoSelect();
    this.update("ready", "已登出；本機仍保留最近一次資料");
  }
}
