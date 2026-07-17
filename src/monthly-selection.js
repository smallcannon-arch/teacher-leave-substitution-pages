import { caseServiceMonths } from "./monthly-close.js?v=0.4.6";

export function selectMonthlyCases(cases = [], month = "") {
  const relevantCases = cases.filter((item) => caseServiceMonths(item).includes(month));
  const finalizedCases = relevantCases.filter((item) => item.status === "ready" || item.status === "closed");
  const pending = relevantCases.filter((item) => item.status !== "ready" && item.status !== "closed");
  return { relevantCases, finalizedCases, pending };
}
