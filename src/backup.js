import { prepareState } from "./storage.js?v=0.4.2";

export const BACKUP_FORMAT = "substitute-fee-desk-backup";
export const BACKUP_VERSION = 1;

function safeFilePart(value) {
  return String(value || "鐘點費系統")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 50) || "鐘點費系統";
}

function compactTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function backupFilename(state, date = new Date()) {
  return `鐘點費完整備份_${safeFilePart(state?.config?.schoolName)}_${compactTimestamp(date)}.json`;
}

export function createBackup(state, date = new Date()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: date.toISOString(),
    schoolName: state?.config?.schoolName || "",
    academicYear: state?.config?.academicYear || "",
    term: state?.config?.term || "",
    summary: {
      people: state?.people?.length || 0,
      cases: state?.cases?.length || 0,
      monthlyCloses: state?.monthlyCloses?.length || 0,
    },
    state: structuredClone(state),
  };
}

export function parseBackup(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, error: "檔案不是有效的 JSON 備份。" };
  }

  if (payload?.format !== BACKUP_FORMAT) return { ok: false, error: "這不是本系統匯出的完整備份。" };
  if (payload?.version !== BACKUP_VERSION) return { ok: false, error: "備份版本不相容，請使用相同或較新的系統匯入。" };
  if (!payload.state || typeof payload.state !== "object") return { ok: false, error: "備份中找不到系統資料。" };
  if (!payload.state.config || typeof payload.state.config !== "object" || Array.isArray(payload.state.config)) {
    return { ok: false, error: "備份內容不完整，未進行匯入。" };
  }

  const arrayFields = ["people", "cases", "subjects", "fundSources", "monthlyCloses", "auditEvents"];
  const invalidArrayField = arrayFields.find((field) => field in payload.state && !Array.isArray(payload.state[field]));
  if (invalidArrayField) return { ok: false, error: `備份欄位 ${invalidArrayField} 格式不正確，未進行匯入。` };
  if (payload.state.meta !== undefined && (!payload.state.meta || typeof payload.state.meta !== "object" || Array.isArray(payload.state.meta))) {
    return { ok: false, error: "備份中的儲存資訊格式不正確，未進行匯入。" };
  }

  try {
    payload = { ...payload, state: prepareState(payload.state) };
  } catch {
    return { ok: false, error: "備份內容無法正規化，未進行匯入。" };
  }

  return { ok: true, payload };
}
