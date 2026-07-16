import { BURDEN, determineBurden, ruleMeta } from "./rules.js";

export const RULE_VERSION = "rules-0.2+decision-2026.07";
export const RATE_VERSION = "114.09.01-current";
export const REASON_VERSION = "AR-0.2";

export function roundMoney(value, mode = "round") {
  const amount = Number(value || 0);
  if (mode === "floor") return Math.floor(amount);
  if (mode === "keep2") return Math.round(amount * 100) / 100;
  return Math.round(amount);
}

export function calculateCase(leaveCase, config) {
  const decisions = [];
  const feeMap = new Map();
  const errors = [];

  for (const period of leaveCase.affectedPeriods || []) {
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

    const serviceMonth = period.date?.slice(0, 7) || leaveCase.startDate?.slice(0, 7) || "undated";
    const preferredFundSourceId = period.fundSourceId || "";
    const key = [serviceMonth, period.substituteId, decision.burden, decision.ruleId, preferredFundSourceId].join("|");
    const existing = feeMap.get(key) || {
      id: `F-${leaveCase.id}-${feeMap.size + 1}`,
      type: "course_hourly",
      payeeId: period.substituteId,
      burden: decision.burden,
      ruleId: decision.ruleId,
      ruleTitle: meta.title,
      source: meta.source,
      serviceMonth,
      preferredFundSourceId,
      quantity: 0,
      unitRate: Number(config.hourlyRate || 0),
      periodIds: [],
      manual: false,
    };
    existing.quantity += 1;
    existing.periodIds.push(period.id);
    existing.amount = existing.quantity * existing.unitRate;
    feeMap.set(key, existing);
  }

  const feeItems = [...feeMap.values()];
  const homeroom = calculateHomeroomAllowance(leaveCase, config);
  if (homeroom.warning) errors.push(homeroom.warning);
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
    decisions,
    feeItems,
    allocations,
    errors,
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
  const start = leaveCase.homeroomStartDate || leaveCase.startDate;
  const end = leaveCase.homeroomEndDate || leaveCase.endDate;
  if (!start || !end) return { amount: 0, validDays: 0, warning: "代理導師職務加給缺少起訖日期。" };
  if (start.slice(0, 7) !== end.slice(0, 7)) {
    return { amount: 0, validDays: 0, warning: "代理導師期間跨月，第一版請拆成兩個案件或手動新增費用，避免月日數分母誤用。" };
  }
  const validDays = calculateValidHomeroomDays(
    start,
    leaveCase.homeroomStartPart || "am",
    end,
    leaveCase.homeroomEndPart || "pm",
  );
  const [year, month] = start.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const dailyRateRaw = Number(config.homeroomMonthly || 0) / daysInMonth;
  return {
    validDays,
    daysInMonth,
    dailyRate: roundMoney(dailyRateRaw, config.roundingMode),
    amount: roundMoney(dailyRateRaw * validDays, config.roundingMode),
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
