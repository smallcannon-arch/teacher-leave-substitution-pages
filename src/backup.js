import { prepareState } from "./storage.js?v=0.4.8";

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

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateUniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    if (!isRecord(item) || !hasText(item.id)) return `${label}含有缺少編號或格式錯誤的資料。`;
    if (ids.has(item.id)) return `${label}含有重複編號 ${item.id}。`;
    ids.add(item.id);
  }
  return "";
}

function validateOptionalRecordArray(owner, field, label) {
  if (!(field in owner)) return "";
  if (!Array.isArray(owner[field])) return `${label}格式不正確。`;
  if (owner[field].some((item) => !isRecord(item))) return `${label}含有損壞資料。`;
  return "";
}

function validateStateRecords(state) {
  let error = validateUniqueIds(state.people || [], "教師名單");
  if (error) return error;
  if ((state.people || []).some((person) => !hasText(person.name))) return "教師名單含有空白姓名。";

  if ((state.subjects || []).some((subject) => !hasText(subject))) return "科目清單含有格式錯誤的資料。";

  error = validateUniqueIds(state.fundSources || [], "經費來源");
  if (error) return error;
  if ((state.fundSources || []).some((source) => !hasText(source.name))) return "經費來源含有空白名稱。";

  error = validateUniqueIds(state.cases || [], "請假案件");
  if (error) return error;
  for (const leaveCase of state.cases || []) {
    for (const [field, label] of [
      ["affectedPeriods", `案件 ${leaveCase.id} 的課節`],
      ["manualFees", `案件 ${leaveCase.id} 的人工費用`],
      ["allocations", `案件 ${leaveCase.id} 的經費分攤`],
    ]) {
      error = validateOptionalRecordArray(leaveCase, field, label);
      if (error) return error;
    }
    for (const allocation of leaveCase.allocations || []) {
      error = validateOptionalRecordArray(allocation, "rows", `案件 ${leaveCase.id} 的分攤明細`);
      if (error) return error;
    }
    if (leaveCase.calculation !== undefined && leaveCase.calculation !== null) {
      if (!isRecord(leaveCase.calculation)) return `案件 ${leaveCase.id} 的試算結果格式不正確。`;
      for (const [field, label] of [
        ["decisions", "規則判斷"],
        ["feeItems", "費用項目"],
        ["allocations", "試算分攤"],
      ]) {
        error = validateOptionalRecordArray(leaveCase.calculation, field, `案件 ${leaveCase.id} 的${label}`);
        if (error) return error;
      }
      for (const field of ["errors", "warnings"]) {
        if (field in leaveCase.calculation && !Array.isArray(leaveCase.calculation[field])) return `案件 ${leaveCase.id} 的試算訊息格式不正確。`;
      }
    }
  }

  error = validateUniqueIds(state.monthlyCloses || [], "月結紀錄");
  if (error) return error;
  for (const close of state.monthlyCloses || []) {
    if (!Array.isArray(close.caseIds) || close.caseIds.some((id) => !hasText(id))) return `月結紀錄 ${close.id} 的案件清單格式不正確。`;
  }

  if ((state.auditEvents || []).some((event) => !isRecord(event))) return "操作紀錄含有損壞資料。";
  return "";
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

  const recordError = validateStateRecords(payload.state);
  if (recordError) return { ok: false, error: `${recordError} 未進行匯入。` };

  try {
    payload = { ...payload, state: prepareState(payload.state) };
  } catch {
    return { ok: false, error: "備份內容無法正規化，未進行匯入。" };
  }

  return { ok: true, payload };
}
