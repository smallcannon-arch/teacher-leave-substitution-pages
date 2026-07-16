export const BURDEN = Object.freeze({
  PUBLIC: "public",
  SELF: "self",
  NONE: "none",
  PENDING: "pending",
});

export const WELLBEING_EFFECTIVE_FROM = "2025-10-10";

export const LEAVE_TYPES = [
  { value: "personal", label: "事假" },
  { value: "family_care", label: "家庭照顧假" },
  { value: "wellbeing", label: "身心調適假" },
  { value: "sick", label: "病假" },
  { value: "menstrual", label: "生理假" },
  { value: "marriage", label: "婚假" },
  { value: "prenatal", label: "產前假" },
  { value: "maternity", label: "娩假" },
  { value: "miscarriage", label: "流產假" },
  { value: "paternity", label: "陪產檢及陪產假" },
  { value: "bereavement", label: "喪假" },
  { value: "donation", label: "骨髓／器官捐贈假" },
  { value: "official", label: "公假" },
  { value: "business_trip", label: "公差" },
  { value: "work_injury", label: "因公傷病公假" },
  { value: "indigenous", label: "原住民族歲時祭儀放假" },
  { value: "vacation", label: "休假" },
  { value: "comp_leave", label: "補休" },
  { value: "extended_sick", label: "延長病假" },
  { value: "unpaid", label: "留職停薪" },
];

export const OFFICIAL_REASONS = [
  { value: "assigned", label: "本府／學校指派或依法執行業務" },
  { value: "self_activity", label: "教師自行參加校外活動或研習" },
  { value: "part_time_study", label: "部分辦公時間進修" },
  { value: "school_activity", label: "校內活動或帶隊參賽／表演" },
  { value: "legal_testimony", label: "依法定義務出席作證" },
];

export const HANDLING_TYPES = [
  { value: "internal_sub", label: "校內代課" },
  { value: "external_sub", label: "外聘代課" },
  { value: "adjustment", label: "調課" },
  { value: "makeup", label: "補課" },
  { value: "long_term", label: "長期代理涵蓋" },
  { value: "none", label: "無課務／不發生" },
];

export const REASON_CODES = [
  { code: "AR01", label: "依本市函釋認定", required: "發文字號及日期" },
  { code: "AR02", label: "依教育處指示認定", required: "指示日期及形式" },
  { code: "AR03", label: "校內人事室認定", required: "簽核日期" },
  { code: "AR04", label: "個案事實補充", required: "結構化說明" },
  { code: "AR05", label: "規則版本過渡期採認", required: "新舊版本號" },
  { code: "AR06", label: "其他", required: "認定說明" },
];

const RULES = {
  R01: { title: "事假額度內課務自理", source: "新竹市教師請假調課補課代課補充規定第 3 點" },
  R02: { title: "事假類合計超過七日由學校支付", source: "教師請假規則第 3 條；教師待遇條例第 19 條" },
  R03: { title: "家庭照顧假併入事假", source: "教師請假規則第 3 條；新竹市補充規定第 3 點" },
  R04: { title: "身心調適假課務公費處理", source: "教師請假規則第 3、14 條；中央實施要點" },
  R05: { title: "病假連續未達三日課務自理", source: "新竹市補充規定第 3 點" },
  R06: { title: "病假連續三日以上公費代課", source: "新竹市補充規定第 3 點但書" },
  R07: { title: "生理假比照短期病假推定", source: "教師請假規則第 3 條；待校內認定" },
  R09: { title: "法定給假公費代課", source: "教師請假規則第 3 條；新竹市補充規定第 4 點" },
  R18: { title: "指派或依法執行之公假", source: "新竹市補充規定第 5 點第 1 款" },
  R19: { title: "自行參加活動之公假課務自理", source: "新竹市補充規定第 5 點第 2 款" },
  R20: { title: "部分辦公時間進修以無課務為原則", source: "新竹市補充規定第 5 點第 3 款" },
  R21: { title: "校內活動或帶隊公費代課", source: "新竹市補充規定第 5 點第 4 款" },
  R22: { title: "公差三日以上得公費代課", source: "新竹市補充規定第 5 點第 5 款" },
  R23: { title: "公差未達三日採調補課", source: "新竹市補充規定第 5 點第 5 款" },
  R24: { title: "兼行政教師休假課務自理", source: "新竹市補充規定第 3 點" },
  R25: { title: "補休以無課務時間為原則", source: "新竹市補充規定第 3 點" },
  R33: { title: "因公傷病公假公費處理", source: "教師請假規則第 4 條" },
  R16: { title: "原住民族歲時祭儀由學校派代", source: "教師請假規則第 3、14 條" },
  LONG: { title: "長期代理個案", source: "代理教師聘任相關規定；不納逐節結算" },
  MANUAL: { title: "待人工認定", source: "請引用 AR 認定理由代碼" },
};

export function ruleMeta(ruleId) {
  return RULES[ruleId] || RULES.MANUAL;
}

export function leaveLabel(value) {
  return LEAVE_TYPES.find((item) => item.value === value)?.label || value;
}

export function burdenLabel(value) {
  return {
    [BURDEN.PUBLIC]: "公費",
    [BURDEN.SELF]: "自費",
    [BURDEN.NONE]: "不發生",
    [BURDEN.PENDING]: "待人工確認",
  }[value] || value;
}

export function determineBurden(leaveCase, affectedPeriod = {}) {
  if (["adjustment", "makeup", "long_term", "none"].includes(affectedPeriod.handling)) {
    return {
      burden: BURDEN.NONE,
      ruleId: affectedPeriod.handling === "long_term" ? "LONG" : "R25",
      note: affectedPeriod.handling === "long_term" ? "長期代理按月計薪，不列逐節鐘點費。" : "本節採調補課或無課務，不產生代課費。",
    };
  }

  const type = leaveCase.leaveType;
  const before = Number(leaveCase.accumulatedHoursBefore || 0);
  const current = Number(leaveCase.leaveHours || 0);
  const after = before + current;

  if (["personal", "family_care"].includes(type)) {
    if (after <= 56) {
      return { burden: BURDEN.SELF, ruleId: type === "personal" ? "R01" : "R03", note: "事假類合計尚未超過 56 小時。" };
    }
    if (before >= 56) {
      return { burden: BURDEN.PUBLIC, ruleId: "R02", note: "本次請假時間已全數位於超過七日區段。" };
    }
    if (affectedPeriod.thresholdZone === "within") {
      return { burden: BURDEN.SELF, ruleId: type === "personal" ? "R01" : "R03", note: "本節位於 56 小時門檻內。" };
    }
    if (affectedPeriod.thresholdZone === "over") {
      return { burden: BURDEN.PUBLIC, ruleId: "R02", note: "本節位於超過 56 小時區段。" };
    }
    return { burden: BURDEN.PENDING, ruleId: "R02", note: "本次假單跨越 56 小時門檻，請逐節標示門檻內或超過門檻。" };
  }

  if (type === "wellbeing") {
    if (!affectedPeriod.date || affectedPeriod.date < WELLBEING_EFFECTIVE_FROM) {
      return {
        burden: BURDEN.PENDING,
        ruleId: "R04",
        note: `身心調適假規則自 ${WELLBEING_EFFECTIVE_FROM} 起適用；較早日期須依當時規定人工確認。`,
      };
    }
    return { burden: BURDEN.PUBLIC, ruleId: "R04", note: "身心調適假併入事假額度，但課務費用判為公費。" };
  }
  if (type === "sick") {
    return Number(leaveCase.consecutiveSickDays || 0) >= 3
      ? { burden: BURDEN.PUBLIC, ruleId: "R06", note: "連續病假達三日以上。" }
      : { burden: BURDEN.SELF, ruleId: "R05", note: "連續病假未達三日。" };
  }
  if (type === "menstrual") return { burden: BURDEN.SELF, ruleId: "R07", note: "依短期病假處理之推定；報表標示待校內認定。" };

  if (type === "official") {
    const reason = leaveCase.officialReason;
    if (reason === "self_activity") return { burden: BURDEN.SELF, ruleId: "R19", note: "教師自行參加校外活動或研習，課務自理。" };
    if (reason === "part_time_study") return { burden: BURDEN.NONE, ruleId: "R20", note: "原則上應安排於無課務時間。" };
    if (reason === "school_activity") return { burden: BURDEN.PUBLIC, ruleId: "R21", note: "校內活動或帶隊之公假。" };
    if (["assigned", "legal_testimony"].includes(reason)) return { burden: BURDEN.PUBLIC, ruleId: "R18", note: "指派或依法執行之公假。" };
    return { burden: BURDEN.PENDING, ruleId: "MANUAL", note: "公假必須先選擇事由分類。" };
  }

  if (type === "business_trip") {
    return Number(leaveCase.businessTripDays || 0) >= 3
      ? { burden: BURDEN.PUBLIC, ruleId: "R22", note: "公差達三日以上。" }
      : { burden: BURDEN.NONE, ruleId: "R23", note: "公差未達三日，依地方規定採調補課。" };
  }

  if (["marriage", "prenatal", "maternity", "miscarriage", "paternity", "bereavement", "donation"].includes(type)) {
    return { burden: BURDEN.PUBLIC, ruleId: "R09", note: "法定給假由學校處理所遺課務。" };
  }
  if (type === "work_injury") return { burden: BURDEN.PUBLIC, ruleId: "R33", note: "因公傷病公假。" };
  if (type === "indigenous") return { burden: BURDEN.PUBLIC, ruleId: "R16", note: "原住民族歲時祭儀放假。" };
  if (type === "vacation") return { burden: BURDEN.SELF, ruleId: "R24", note: "兼行政職務教師休假之課務自理。" };
  if (type === "comp_leave") return { burden: BURDEN.NONE, ruleId: "R25", note: "補休以無課務時間為原則。" };
  if (["extended_sick", "unpaid"].includes(type)) return { burden: BURDEN.PUBLIC, ruleId: "LONG", note: "原則採長期代理；若逐節登錄須由承辦人確認未重複支給。" };

  return { burden: BURDEN.PENDING, ruleId: "MANUAL", note: "目前沒有可直接套用的自動規則。" };
}
