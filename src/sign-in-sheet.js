const SHEET_HANDLINGS = new Set(["internal_sub", "external_sub"]);

export function isSignInSheetPeriod(period) {
  return Boolean(period?.substituteId) && SHEET_HANDLINGS.has(period?.handling);
}

export function collectSignInSheetRows(cases = []) {
  return cases
    .flatMap((leaveCase) => (leaveCase.affectedPeriods || [])
      .filter(isSignInSheetPeriod)
      .map((period) => ({
        caseId: leaveCase.id,
        periodId: period.id,
        date: period.date || "",
        periodNo: Number(period.periodNo || 0),
        className: period.className || "",
        subject: period.subject || "",
        teacherId: leaveCase.teacherId || "",
        substituteId: period.substituteId || "",
        handling: period.handling,
      })))
    .sort((a, b) => a.date.localeCompare(b.date)
      || a.periodNo - b.periodNo
      || a.className.localeCompare(b.className, "zh-TW"));
}
