const STORAGE_KEY = "hsinchu-substitute-fee-desk-v01";
const LEGACY_DEMO_CASE_ID = "C-DEMO-001";
const DEMO_CASE_ID = "115-1-20260907-001";

const DEFAULT_FUND_SOURCES = [
  { id: "FS-PERSONNEL", category: "personnel", burdenType: "public", name: "校內預算項下人事費", active: true, custom: false },
  { id: "FS-PROJECT", category: "project", burdenType: "public", name: "計畫或專案經費", active: true, custom: false },
  { id: "FS-OTHER", category: "other", burdenType: "public", name: "其他經費（家長會等）", active: true, custom: false },
  { id: "FS-SELF", category: "self", burdenType: "self", name: "教師自費", active: true, custom: false },
];

const DEFAULT_SUBJECTS = ["國語", "數學", "英語", "自然", "社會", "生活", "綜合活動", "健康與體育", "藝術", "本土語文"];

export function newId(prefix = "ID") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function migrateLegacyDemoCaseId(state) {
  const legacyCase = state.cases?.find((item) => item.id === LEGACY_DEMO_CASE_ID);
  if (!legacyCase || state.cases.some((item) => item.id === DEMO_CASE_ID)) return state;

  legacyCase.id = DEMO_CASE_ID;
  const replaceFeeId = (value) => String(value || "").replace(`F-${LEGACY_DEMO_CASE_ID}-`, `F-${DEMO_CASE_ID}-`);
  for (const fee of legacyCase.calculation?.feeItems || []) fee.id = replaceFeeId(fee.id);
  for (const allocation of legacyCase.allocations || []) allocation.feeId = replaceFeeId(allocation.feeId);
  for (const allocation of legacyCase.calculation?.allocations || []) allocation.feeId = replaceFeeId(allocation.feeId);
  for (const close of state.monthlyCloses || []) {
    close.caseIds = (close.caseIds || []).map((id) => id === LEGACY_DEMO_CASE_ID ? DEMO_CASE_ID : id);
  }
  for (const event of state.auditEvents || []) {
    if (event.entityId === LEGACY_DEMO_CASE_ID) event.entityId = DEMO_CASE_ID;
  }
  return state;
}

function normalizeState(state) {
  state.meta = {
    storageMode: "local",
    lastSavedAt: "",
    lastSyncedAt: "",
    driveOwnerSub: "",
    ...(state.meta || {}),
  };
  state.subjects = [...new Set((state.subjects || DEFAULT_SUBJECTS).map((subject) => String(subject || "").trim()).filter(Boolean))];
  state.fundSources = (state.fundSources || []).map((source) => ({
    ...source,
    burdenType: source.burdenType || (source.id === "FS-SELF" ? "self" : "public"),
    custom: source.custom === true,
  }));
  if (!state.fundSources.some((source) => source.id === "FS-SELF")) {
    state.fundSources.push({ ...DEFAULT_FUND_SOURCES.find((source) => source.id === "FS-SELF") });
  }
  for (const leaveCase of state.cases || []) {
    for (const period of leaveCase.affectedPeriods || []) period.fundSourceId ||= "";
    if (leaveCase.calculation?.versions?.rules) leaveCase.calculation.versions.rules = "rules-0.2+decision-2026.07";
  }
  return state;
}

export function emptyState() {
  return {
    schemaVersion: 1,
    meta: {
      storageMode: "local",
      lastSavedAt: "",
      lastSyncedAt: "",
      driveOwnerSub: "",
    },
    config: {
      schoolName: "新竹市○○國民小學",
      schoolLevel: "elementary",
      academicYear: "115",
      term: "1",
      hourlyRate: 405,
      homeroomMonthly: 4000,
      roundingMode: "round",
    },
    people: [],
    subjects: [...DEFAULT_SUBJECTS],
    fundSources: DEFAULT_FUND_SOURCES.map((source) => ({ ...source })),
    cases: [],
    monthlyCloses: [],
    auditEvents: [],
  };
}

export const localStorageAdapter = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? normalizeState(migrateLegacyDemoCaseId({ ...emptyState(), ...JSON.parse(raw) })) : emptyState();
    } catch (error) {
      console.error("資料載入失敗", error);
      return emptyState();
    }
  },
  save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  },
  reset() {
    localStorage.removeItem(STORAGE_KEY);
  },
};

export function demoState() {
  const state = emptyState();
  state.config.schoolName = "新竹市示範國民小學";
  state.people = [
    {
      id: "P-001",
      name: "林怡君",
      personType: "staff",
      roles: ["homeroom"],
      className: "五年一班",
      subjects: "國語、數學",
      canSubstitute: false,
      active: true,
    },
    {
      id: "P-002",
      name: "陳志明",
      personType: "staff",
      roles: ["subject"],
      className: "",
      subjects: "自然、生活",
      canSubstitute: true,
      active: true,
    },
    {
      id: "P-003",
      name: "王雅婷",
      personType: "short_sub",
      roles: [],
      className: "",
      subjects: "國語、數學、社會",
      canSubstitute: true,
      active: true,
    },
  ];
  state.cases = [
    {
      id: DEMO_CASE_ID,
      teacherId: "P-001",
      leaveType: "personal",
      officialReason: "",
      startDate: "2026-09-07",
      endDate: "2026-09-07",
      startTime: "08:00",
      endTime: "16:00",
      startPart: "am",
      endPart: "pm",
      leaveHours: 8,
      accumulatedHoursBefore: 16,
      consecutiveSickDays: 0,
      businessTripDays: 0,
      hasHomeroomDuty: true,
      homeroomProxyId: "P-003",
      homeroomStartDate: "2026-09-07",
      homeroomEndDate: "2026-09-07",
      homeroomStartPart: "am",
      homeroomEndPart: "pm",
      affectedPeriods: [
        { id: "AP-001", date: "2026-09-07", periodNo: 1, className: "五年一班", subject: "國語", handling: "external_sub", substituteId: "P-003", thresholdZone: "within", isOvertime: false },
        { id: "AP-002", date: "2026-09-07", periodNo: 2, className: "五年一班", subject: "數學", handling: "external_sub", substituteId: "P-003", thresholdZone: "within", isOvertime: false },
        { id: "AP-003", date: "2026-09-07", periodNo: 4, className: "五年一班", subject: "社會", handling: "external_sub", substituteId: "P-003", thresholdZone: "within", isOvertime: false },
      ],
      manualFees: [],
      allocations: [],
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  return state;
}
