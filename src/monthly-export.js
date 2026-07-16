import { burdenLabel, leaveLabel } from "./rules.js";

export const MONTHLY_EXPORT_HEADERS = [
  "核算月份",
  "案件編號",
  "請假教師",
  "假別",
  "代課日期",
  "班級",
  "科目",
  "費用項目",
  "領款人",
  "數量",
  "單位",
  "單價",
  "費用負擔",
  "金額",
  "經費來源與分攤",
  "規則依據",
];

export function feeTypeLabel(fee) {
  if (fee?.type === "course_hourly") return "課務代課鐘點費";
  if (fee?.type === "homeroom_allowance") return "代理導師職務加給";
  return "代理導師鐘點費";
}

function uniqueJoined(values) {
  return [...new Set(values.filter(Boolean))].join("、");
}

export function buildMonthlyExportRows(cases = [], month, people = [], fundSources = []) {
  const peopleMap = new Map(people.map((person) => [person.id, person]));
  const personName = (id) => peopleMap.get(id)?.name || "未指定";
  const sourceMap = new Map(fundSources.map((source) => [source.id, source.name]));

  return cases.flatMap((leaveCase) => {
    const periods = (leaveCase.affectedPeriods || []).filter((period) => period.date?.startsWith(month));
    const dates = uniqueJoined(periods.map((period) => period.date));
    const classes = uniqueJoined(periods.map((period) => period.className));
    const subjects = uniqueJoined(periods.map((period) => period.subject));
    return (leaveCase.calculation?.feeItems || [])
      .filter((fee) => fee.serviceMonth === month)
      .map((fee) => {
        const allocations = leaveCase.allocations?.find((item) => item.feeId === fee.id)?.rows || [];
        const allocationText = allocations.map((row) => {
          const sourceName = sourceMap.get(row.sourceId) || row.sourceId || "未指定";
          const note = row.note ? `－${row.note}` : "";
          return `${sourceName}${note}：${Number(row.amount || 0)} 元`;
        }).join("；");
        return {
          month,
          caseId: leaveCase.id,
          teacherName: personName(leaveCase.teacherId),
          leaveType: leaveLabel(leaveCase.leaveType),
          dates: fee.type === "homeroom_allowance" ? (leaveCase.homeroomStartDate || dates) : dates,
          classes: classes || peopleMap.get(leaveCase.teacherId)?.className || "",
          subjects,
          feeType: feeTypeLabel(fee),
          payeeName: personName(fee.payeeId),
          quantity: Number(fee.quantity || 0),
          unit: fee.type === "homeroom_allowance" ? "日" : "節",
          unitRate: Number(fee.unitRate || 0),
          burdenCode: fee.burden,
          burden: burdenLabel(fee.burden),
          amount: Number(fee.amount || 0),
          allocationText,
          ruleSource: [fee.ruleTitle, fee.source].filter(Boolean).join("｜"),
          manual: Boolean(fee.manual),
        };
      });
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function monthlyRowsToCsv(rows = []) {
  const data = rows.map((row) => [
    row.month,
    row.caseId,
    row.teacherName,
    row.leaveType,
    row.dates,
    row.classes,
    row.subjects,
    row.feeType,
    row.payeeName,
    row.quantity,
    row.unit,
    row.unitRate,
    row.burden,
    row.amount,
    row.allocationText,
    row.ruleSource,
  ]);
  return `\uFEFF${[MONTHLY_EXPORT_HEADERS, ...data].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}
