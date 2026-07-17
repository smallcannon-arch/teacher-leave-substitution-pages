import { BURDEN, determineBurden, ruleMeta } from "./rules.js?v=0.4.6";
import { calculationInputSignature } from "./case-integrity.js?v=0.4.6";

export const RULE_VERSION = "rules-0.2+decision-2026.07";
export const RATE_VERSION = "114.09.01-current";
export const REASON_VERSION = "AR-0.2";
export const CURRENT_RATE_EFFECTIVE_FROM = "2025-09-01";

export function roundMoney(value, mode = "round") {
  const amount = Number(value || 0);
  if (mode === "floor") return Math.floor(amount);
  if (mode === "keep2") return Math.round(amount * 100) / 100;
  return Math.round(amount);
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function selectHourlyRate(date, config = {}) {
  if (!isIsoDate(date)) return { ok: false, error: "課節日期格式不正確，無法選取鐘點費率。" };
  const versions = Array.isArray(config.rateVersions) && config.rateVersions.length
    ? config.rateVersions
    : [{ id: RATE_VERSION, effectiveFrom: CURRENT_RATE_EFFECTIVE_FROM, amount: Number(config.hourlyRate) }];
  const candidates = versions.filter((version) => {
    if (version.enabled === false) return false;
    if (!version.effectiveFrom || version.effectiveFrom > date) return false;
    return !version.effectiveTo || version.effectiveTo >= date;
  });
  if (candidates.length !== 1) {
    return {
      ok: false,
      error: candidates.length
        ? `${date} 有 ${candidates.length} 個有效鐘點費率版本，請先修正設定。`
        : `${date} 找不到有效鐘點費率；本版費率自 ${CURRENT_RATE_EFFECTIVE_FROM} 起適用。`,
    };
  }
  const selected = candidates[0];
  const amount = Number(selected.amount);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
    return { ok: false, error: `${date} 的鐘點費率必須是非負有限整數。` };
  }
  return { ok: true, id: selected.id || selected.effectiveFrom, amount };
}

function feeId(caseId, parts) {
  return `F-${caseId}-${parts.map((part) => encodeURIComponent(String(part || "_"))).join("-")}`;
}

export function validateAffectedPeriods(leaveCase) {
  const errors = [];
  const validPeriods = [];
  const periodKeys = new Set();
  const periodIds = new Set();
  for (const period of leaveCase.affectedPeriods || []) {
    if (!isIsoDate(period.date)) {
      errors.push(`節次 ${period.periodNo || "未填"} 的日期格式不正確。`);
      continue;
    }
    if (leaveCase.startDate && period.date < leaveCase.startDate) {
      errors.push(`${period.date} 第 ${period.periodNo} 節早於請假開始日期。`);
      continue;
    }
    if (leaveCase.endDate && period.date > leaveCase.endDate) {
      errors.push(`${period.date} 第 ${period.periodNo} 節晚於請假結束日期。`);
      continue;
    }
    if (!Number.isInteger(Number(period.periodNo)) || Number(period.periodNo) < 1) {
      errors.push(`${period.date} 的節次必須是正整數。`);
      continue;
    }
    if (!period.id || periodIds.has(period.id)) {
      errors.push(`${period.date} 第 ${period.periodNo} 節使用重複或空白的課節 ID。`);
      continue;
    }
    const key = `${period.date}|${Number(period.periodNo)}`;
    if (periodKeys.has(key)) {
      errors.push(`${period.date} 第 ${period.periodNo} 節重複登錄。`);
      continue;
    }
    periodIds.add(period.id);
    periodKeys.add(key);
    validPeriods.push(period);
  }
  return { errors, validPeriods };
}

export function calculateCase(leaveCase, config) {
  const decisions = [];
  const feeMap = new Map();
  const validation = validateAffectedPeriods(leaveCase);
  const errors = [...validation.errors];
  const warnings = [];

  for (const period of validation.validPeriods) {
    const decision = determineBurden(leaveCase, period);
    const meta = ruleMeta(decision.ruleId);
    decisions.push({
      id: `D-${period.id}`,
      periodId: period.id,
      ...decision,
      ruleTitle: meta.title,
      source: meta.source,
    });

    if (decision.burden === BURDEN.PENDING) {
      errors.push(`${period.date} 第 ${period.periodNo} 節：${decision.note}`);
      continue;
    }
    if (decision.burden === BURDEN.NONE) continue;
    if (!period.substituteId) {
      errors.push(`${period.date} 第 ${period.periodNo} 節尚未指定代課者。`);
      continue;
    }
    if (period.substituteId === leaveCase.teacherId) {
      errors.push(`${period.date} 第 ${period.periodNo} 節的代課者不可為請假教師本人。`);
      continue;
    }

    const rate = selectHourlyRate(period.date, config);
    if (!rate.ok) {
      errors.push(`${period.date} 第 ${period.periodNo} 節：${rate.error}`);
      continue;
    }

    const serviceMonth = period.date?.slice(0, 7) || leaveCase.startDate?.slice(0, 7) || "undated";
    const preferredFundSourceId = period.fundSourceId || "";
    const keyParts = [serviceMonth, period.substituteId, decision.burden, decision.ruleId, preferredFundSourceId, rate.id, rate.amount];
    const key = keyParts.join("|");
    const existing = feeMap.get(key) || {
      id: feeId(leaveCase.id, keyParts),
      type: "course_hourly",
      payeeId: period.substituteId,
      burden: decision.burden,
      ruleId: decision.ruleId,
      ruleTitle: meta.title,
      source: meta.source,
      serviceMonth,
      preferredFundSourceId,
      quantity: 0,
      rateVersion: rate.id,
      unitRate: rate.amount,
      periodIds: [],
      overtimePeriodIds: [],
      stopPaymentNote: "",
      manual: false,
    };
    existing.quantity += 1;
    existing.periodIds.push(period.id);
    if (period.isOvertime) {
      existing.overtimePeriodIds.push(period.id);
      existing.stopPaymentNote = `含 ${existing.overtimePeriodIds.length} 節超時授課；原教師該節超時鐘點費應另行停發（非本筆計價）。`;
    }
    existing.amount = existing.quantity * existing.unitRate;
    feeMap.set(key, existing);
  }

  const feeItems = [...feeMap.values()];
  const homeroom = calculateHomeroomAllowance(leaveCase, config);
  if (homeroom.error) errors.push(homeroom.error);
  if (homeroom.warning) warnings.push(homeroom.warning);
  if (homeroom.amount > 0 && leaveCase.homeroomProxyId) {
    feeItems.push({
      id: `F-${leaveCase.id}-H`,
      type: "homeroom_allowance",
      payeeId: leaveCase.homeroomProxyId,
      burden: BURDEN.PUBLIC,
      ruleId: "H-ALLOWANCE",
      ruleTitle: "代理導師職務加給",
      source: "公立中小學教師給假期間或停聘之職務加給支給基準及補充說明",
      serviceMonth: (leaveCase.homeroomStartDate || leaveCase.startDate || "").slice(0, 7),
      quantity: homeroom.validDays,
      unitRate: homeroom.dailyRate,
      amount: homeroom.amount,
      manual: false,
    });
  }

  for (const manual of leaveCase.manualFees || []) {
    feeItems.push({
      ...manual,
      serviceMonth: manual.serviceMonth || (leaveCase.homeroomStartDate || leaveCase.startDate || "").slice(0, 7),
      manual: true,
      burden: BURDEN.PUBLIC,
    });
  }

  const previousAllocations = new Map((leaveCase.allocations || []).map((item) => [item.feeId, item.rows]));
  const allocations = feeItems
    .filter((fee) => fee.burden === BURDEN.PUBLIC)
    .map((fee) => ({ feeId: fee.id, rows: previousAllocations.get(fee.id) || [] }));

  return {
    inputSignature: calculationInputSignature(leaveCase),
    decisions,
    feeItems,
    allocations,
    errors,
    warnings,
    versions: { rules: RULE_VERSION, rates: RATE_VERSION, reasons: REASON_VERSION },
  };
}

export function calculateValidHomeroomDays(startDate, startPart, endDate, endPart) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const diff = Math.round((end - start) / 86400000);
  if (diff < 0) throw new Error("代理導師結束日期不得早於開始日期。");
  if (diff === 0) return startPart === "am" && endPart === "pm" ? 1 : 0;

  const middleFullDays = Math.max(diff - 1, 0);
  const firstFull = startPart === "am" ? 1 : 0;
  const lastFull = endPart === "pm" ? 1 : 0;
  const pairedHalves = startPart === "pm" && endPart === "am" ? 1 : 0;
  return middleFullDays + firstFull + lastFull + pairedHalves;
}

export function calculateHomeroomAllowance(leaveCase, config) {
  if (!leaveCase.hasHomeroomDuty || !leaveCase.homeroomProxyId) return { amount: 0, validDays: 0 };
  if (leaveCase.homeroomProxyId === leaveCase.teacherId) {
    return { amount: 0, validDays: 0, error: "導師職務代理人不可為請假教師本人。" };
  }
  const start = leaveCase.homeroomStartDate || leaveCase.startDate;
  const end = leaveCase.homeroomEndDate || leaveCase.endDate;
  if (!start || !end) return { amount: 0, validDays: 0, error: "代理導師職務加給缺少起訖日期。" };
  if (start.slice(0, 7) !== end.slice(0, 7)) {
    return { amount: 0, validDays: 0, error: "代理導師期間跨月，請拆成兩個案件或手動新增費用，避免月日數分母誤用。" };
  }
  const startPart = leaveCase.homeroomStartPart || "am";
  const endPart = leaveCase.homeroomEndPart || "pm";
  if (start === end && startPart === "pm" && endPart === "am") {
    return { amount: 0, validDays: 0, error: "代理導師同日結束時段不得早於開始時段。" };
  }
  const validDays = calculateValidHomeroomDays(
    start,
    startPart,
    end,
    endPart,
  );
  const includesUnpaidHalfDay = start === end
    ? !(startPart === "am" && endPart === "pm")
    : startPart === endPart;
  const [year, month] = start.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const dailyRateRaw = Number(config.homeroomMonthly || 0) / daysInMonth;
  return {
    validDays,
    daysInMonth,
    dailyRate: roundMoney(dailyRateRaw, config.roundingMode),
    amount: roundMoney(dailyRateRaw * validDays, config.roundingMode),
    warning: includesUnpaidHalfDay
      ? "代理導師期間含未滿一日的半日時段；依目前規則該半日不計職務加給。"
      : "",
  };
}

export function allocationBalance(fee, rows = []) {
  const allocated = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return roundMoney(Number(fee.amount || 0) - allocated, "keep2");
}

export function caseTotals(feeItems = []) {
  return feeItems.reduce(
    (totals, fee) => {
      if (fee.burden === BURDEN.PUBLIC) totals.public += Number(fee.amount || 0);
      if (fee.burden === BURDEN.SELF) totals.self += Number(fee.amount || 0);
      totals.total += Number(fee.amount || 0);
      return totals;
    },
    { public: 0, self: 0, total: 0 },
  );
}
