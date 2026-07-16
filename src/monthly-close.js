function monthFromDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value).slice(0, 7) : "";
}

export function caseServiceMonths(caseData = {}) {
  const months = new Set();
  for (const period of caseData.affectedPeriods || []) {
    const month = monthFromDate(period.date);
    if (month) months.add(month);
  }
  for (const value of [caseData.homeroomStartDate, caseData.homeroomEndDate]) {
    const month = monthFromDate(value);
    if (month) months.add(month);
  }
  for (const fee of caseData.calculation?.feeItems || []) {
    if (/^\d{4}-\d{2}$/.test(String(fee.serviceMonth || ""))) months.add(fee.serviceMonth);
  }
  return [...months].sort();
}

export function activeMonthlyClose(monthlyCloses = [], month = "") {
  return [...monthlyCloses].reverse().find((close) => close.month === month && !close.unlockedAt) || null;
}

export function lockedMonthsForCase(caseData, monthlyCloses = []) {
  const activeMonths = new Set(monthlyCloses.filter((close) => !close.unlockedAt).map((close) => close.month));
  return caseServiceMonths(caseData).filter((month) => activeMonths.has(month));
}

export function applyMonthClose(state, {
  month,
  closeId,
  closedAt = new Date().toISOString(),
  totals = { public: 0, self: 0, total: 0 },
  ruleVersion = "",
} = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) throw new Error("月結月份格式不正確。");
  if (activeMonthlyClose(state.monthlyCloses, month)) throw new Error(`${month} 已完成月結並鎖定。`);

  const relevantCases = (state.cases || []).filter((caseData) => caseServiceMonths(caseData).includes(month));
  if (!relevantCases.length) throw new Error(`${month} 沒有可月結案件。`);
  const pending = relevantCases.filter((caseData) => !["ready", "closed"].includes(caseData.status));
  if (pending.length) throw new Error(`${month} 仍有 ${pending.length} 案尚未完成覆核。`);

  const close = {
    id: closeId,
    month,
    closedAt,
    unlockedAt: "",
    caseIds: relevantCases.map((caseData) => caseData.id),
    totals: {
      public: Number(totals.public || 0),
      self: Number(totals.self || 0),
      total: Number(totals.total || 0),
    },
    ruleVersion,
  };
  state.monthlyCloses ||= [];
  state.monthlyCloses.push(close);
  for (const caseData of relevantCases) caseData.status = "closed";
  return close;
}

export function applyMonthUnlock(state, month, unlockedAt = new Date().toISOString()) {
  const close = activeMonthlyClose(state.monthlyCloses, month);
  if (!close) throw new Error(`${month} 尚未鎖定。`);
  close.unlockedAt = unlockedAt;

  const otherActiveCloses = (state.monthlyCloses || []).filter((item) => item !== close && !item.unlockedAt);
  for (const caseId of close.caseIds || []) {
    const caseData = (state.cases || []).find((item) => item.id === caseId);
    if (!caseData) continue;
    const stillLocked = otherActiveCloses.some((item) => (item.caseIds || []).includes(caseId));
    if (!stillLocked && caseData.status === "closed") {
      caseData.status = caseData.calculation
        ? (caseData.calculation.errors?.length ? "calculated" : "ready")
        : "draft";
    }
  }
  return close;
}
