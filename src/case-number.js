function compactDate(value = "") {
  const digits = String(value).replace(/\D/g, "");
  return digits.length === 8 ? digits : "00000000";
}

export function caseNumberPrefix(config = {}, startDate = "") {
  const academicYear = String(config.academicYear || "000").replace(/\D/g, "") || "000";
  const term = String(config.term || "0").replace(/\D/g, "") || "0";
  return `${academicYear}-${term}-${compactDate(startDate)}`;
}

export function isReadableCaseNumber(value = "") {
  return /^\d{2,3}-\d-\d{8}-\d{3}$/.test(String(value));
}

export function nextCaseNumber(cases = [], config = {}, startDate = "") {
  const prefix = caseNumberPrefix(config, startDate);
  const sequence = cases.reduce((max, item) => {
    const match = String(item?.id || "").match(new RegExp(`^${prefix}-(\\d{3})$`));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  return `${prefix}-${String(sequence).padStart(3, "0")}`;
}
