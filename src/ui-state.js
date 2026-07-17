import { caseServiceMonths } from "./monthly-close.js?v=0.4.3";

function normalizedFingerprintValue(value, key = "") {
  if (key === "updatedAt") return undefined;
  if (Array.isArray(value)) return value.map((item) => normalizedFingerprintValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((itemKey) => [itemKey, normalizedFingerprintValue(value[itemKey], itemKey)])
    .filter(([, itemValue]) => itemValue !== undefined));
}

export function draftFingerprint(draft) {
  return draft ? JSON.stringify(normalizedFingerprintValue(draft)) : "";
}

export function isDraftDirty(draft, baseline = "") {
  return Boolean(draft && baseline && draftFingerprint(draft) !== baseline);
}

export function caseOverviewMonths(caseData = {}) {
  const months = new Set(caseServiceMonths(caseData));
  for (const value of [caseData.startDate, caseData.endDate]) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) months.add(String(value).slice(0, 7));
  }
  return [...months].sort();
}

export function casesForOverview(cases = [], month = "") {
  return cases.filter((item) => caseOverviewMonths(item).includes(month));
}

export function availableCaseMonths(cases = []) {
  return [...new Set(cases.flatMap((item) => caseOverviewMonths(item)))].sort().reverse();
}

export function filterCaseList(cases = [], {
  month = "all",
  status = "all",
  query = "",
  searchText = () => "",
} = {}) {
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-TW");
  return cases.filter((item) => {
    if (month !== "all" && !caseOverviewMonths(item).includes(month)) return false;
    if (status === "pending" && !["draft", "calculated"].includes(item.status)) return false;
    if (!["all", "pending"].includes(status) && item.status !== status) return false;
    if (normalizedQuery && !String(searchText(item) || "").toLocaleLowerCase("zh-TW").includes(normalizedQuery)) return false;
    return true;
  });
}

export function friendlyRuleVersion(value = "") {
  const match = String(value).match(/decision-(\d{4}\.\d{2})/);
  return match?.[1] || String(value || "未標示");
}
