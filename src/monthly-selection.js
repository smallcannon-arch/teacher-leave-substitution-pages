export function selectMonthlyCases(cases = [], month = "") {
  const relevantCases = cases.filter((item) =>
    (item.affectedPeriods || []).some((period) => period.date?.startsWith(month))
    || item.homeroomStartDate?.startsWith(month));
  const finalizedCases = relevantCases.filter((item) => item.status === "ready" || item.status === "closed");
  const pending = relevantCases.filter((item) => item.status !== "ready" && item.status !== "closed");
  return { relevantCases, finalizedCases, pending };
}
