import {
  BURDEN,
  HANDLING_TYPES,
  LEAVE_TYPES,
  OFFICIAL_REASONS,
  REASON_CODES,
  burdenLabel,
  leaveLabel,
} from "./rules.js";
import {
  allocationBalance,
  calculateCase,
  caseTotals,
  roundMoney,
} from "./calculator.js";
import { demoState, emptyState, localStorageAdapter, newId } from "./storage.js";
import { parseRosterText, rosterTemplate } from "./importer.js";
import { collectSignInSheetRows, isSignInSheetPeriod } from "./sign-in-sheet.js";
import { buildMonthlyExportRows, monthlyRowsToCsv } from "./monthly-export.js";
import { isReadableCaseNumber, nextCaseNumber } from "./case-number.js";
import { backupFilename, createBackup, parseBackup } from "./backup.js";
import { APP_CONFIG, requiresCloudLogin } from "./app-config.js?v=0.3.7";
import { APP_NAME, APP_VERSION, COPYRIGHT_NOTICE, DRIVE_CONNECTION_REASON, SUPPORT_EMAIL, buildErrorReportText, buildSupportMailto } from "./support.js?v=0.3.7";
import { GoogleCloudService } from "./google-cloud.js";

const app = document.querySelector("#app");
let state = localStorageAdapter.load();
let activePage = "dashboard";
let draftCase = null;
let modal = null;
let personModalType = "staff";
let toastTimer = null;
let cloudUi = { phase: "initializing", message: "正在準備 Google 登入…", profile: null, connected: false };
let pendingDriveChoice = null;
const cloudAccessRequired = requiresCloudLogin(globalThis.location?.hostname);

const googleCloud = new GoogleCloudService({
  apiBaseUrl: APP_CONFIG.apiBaseUrl,
  getState: () => state,
  applyRemoteState: (remoteState) => {
    localStorageAdapter.save(remoteState);
    state = localStorageAdapter.load();
    draftCase = null;
    activePage = "dashboard";
  },
  chooseDriveData: (details) => chooseDriveData(details),
  onChange: (snapshot) => {
    cloudUi = snapshot;
    render();
  },
  onSync: ({ ownerSub, syncedAt }) => {
    state.meta ||= {};
    state.meta.storageMode = "drive";
    state.meta.driveOwnerSub = ownerSub;
    state.meta.lastSyncedAt = syncedAt;
    localStorageAdapter.save(state);
  },
  autoConnectDrive: true,
});

const navItems = [
  ["dashboard", "01", "本月總覽"],
  ["roster", "02", "教師與代課教師名單"],
  ["case", "03", "新增請假案件"],
  ["cases", "04", "代課費核算"],
  ["attendance", "05", "紙本簽到表"],
  ["monthly", "06", "月結與報表"],
];

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${String(value) === String(selected) ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function formatMoney(value) {
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function formatDateTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "時間未知" : date.toLocaleString("zh-TW", { hour12: false });
}

function todayMonth() {
  return new Date().toISOString().slice(0, 7);
}

function localDateValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function firstCaseMonth() {
  return state.cases.find((item) => item.startDate)?.startDate?.slice(0, 7) || todayMonth();
}

function personById(id) {
  return state.people.find((person) => person.id === id);
}

function personName(id) {
  return personById(id)?.name || "未指定";
}

function roleText(person) {
  const map = { homeroom: "導師", subject: "科任", admin: "兼行政" };
  return (person?.roles || []).map((role) => map[role]).filter(Boolean).join("、") || (isShortSub(person) ? "短代老師" : "未設定");
}

function substituteOptions(selectedId = "") {
  const candidates = state.people.filter((person) => person.canSubstitute || person.id === selectedId);
  const renderGroup = (label, people) => people.length ? `<optgroup label="${label}">${people.map((person) => {
    const status = person.canSubstitute ? "" : "｜已暫不排代";
    const subjects = person.subjects ? `｜${person.subjects}` : "";
    return option(person.id, `${person.name}｜${roleText(person)}${subjects}${status}`, selectedId);
  }).join("")}</optgroup>` : "";
  return renderGroup("校內教師", candidates.filter((person) => person.personType === "staff"))
    + renderGroup("短代老師", candidates.filter(isShortSub));
}

function subjectOptions(selectedSubject = "") {
  const subjects = [...state.subjects];
  if (selectedSubject && !subjects.includes(selectedSubject)) subjects.push(selectedSubject);
  return subjects.map((subject) => option(subject, subject, selectedSubject)).join("");
}

function isShortSub(person) {
  return person?.personType === "short_sub" || person?.personType === "external";
}

function statusMeta(status) {
  return {
    draft: ["草稿", "pending"],
    calculated: ["待覆核", "pending"],
    ready: ["可月結", "ready"],
    closed: ["已月結", "ready"],
  }[status] || [status || "草稿", "pending"];
}

function burdenBadge(burden) {
  const cls = { public: "public", self: "self", none: "none", pending: "pending" }[burden] || "pending";
  return `<span class="badge ${cls}">${escapeHtml(burdenLabel(burden))}</span>`;
}

function fundSourceKindLabel(type) {
  return { public: "公費來源", self: "教師自費", other: "其他" }[type] || "其他";
}

function fundSourceOptions(selectedId = "", publicOnly = false) {
  return state.fundSources
    .filter((source) => (source.active || source.id === selectedId) && (!publicOnly || source.burdenType !== "self"))
    .map((source) => option(source.id, `[${fundSourceKindLabel(source.burdenType)}] ${source.name}${source.active ? "" : "（已停用）"}`, selectedId))
    .join("");
}

function defaultPublicFundSource(preferredId = "") {
  const preferred = state.fundSources.find((source) => source.id === preferredId && source.active && source.burdenType !== "self");
  return preferred || state.fundSources.find((source) => source.active && source.burdenType === "public");
}

function savedTimeText() {
  const value = state.meta?.lastSavedAt;
  const driveMode = state.meta?.storageMode === "drive" && cloudUi.connected;
  if (!value) return driveMode ? "Google Drive 資料已載入" : "本機資料已載入";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return driveMode ? "Google Drive 已同步" : "本機已儲存";
  const time = date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  return driveMode ? `Google Drive 已同步 ${time}` : `本機已自動儲存 ${time}`;
}

function saveState(action = "update", entityId = "system") {
  state.meta ||= {};
  state.meta.storageMode ||= "local";
  state.meta.lastSavedAt = new Date().toISOString();
  state.auditEvents.push({
    id: newId("AUD"),
    action,
    entityId,
    at: new Date().toISOString(),
    actor: "local-browser",
  });
  localStorageAdapter.save(state);
  googleCloud.queueSave(state);
}

function accountButtonText() {
  if (!cloudUi.profile) return "Google 登入";
  const name = cloudUi.profile.name || cloudUi.profile.email || "Google 帳號";
  return cloudUi.connected ? `${name}・已連接` : `${name}・連接 Drive`;
}

function renderAppFooter(extraClass = "") {
  return `<footer class="app-footer ${escapeHtml(extraClass)}">
    <div class="footer-copyright"><strong>${escapeHtml(COPYRIGHT_NOTICE)}</strong><span>江志宏 · 系統版本 ${escapeHtml(APP_VERSION)}</span></div>
    <div class="footer-support"><button class="error-report-link" type="button" data-open-error-report>錯誤回報</button><span>可輸入說明並加入不含個資的截圖。</span><a href="mailto:${escapeHtml(SUPPORT_EMAIL)}">${escapeHtml(SUPPORT_EMAIL)}</a></div>
  </footer>`;
}

function currentReportPage() {
  if (cloudAccessRequired && !cloudUi.connected) return "登入頁";
  return navItems.find(([key]) => key === activePage)?.[2] || (activePage === "settings" ? "系統設定" : activePage);
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2600);
}

function isEditingExistingCase() {
  return activePage === "case" && Boolean(draftCase?.id) && state.cases.some((item) => item.id === draftCase.id);
}

function render() {
  if (cloudAccessRequired && !cloudUi.connected) {
    renderAccessGate();
    return;
  }
  const activeNavPage = isEditingExistingCase() ? "cases" : activePage;
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">鐘</div>
          <div><strong>${escapeHtml(APP_NAME)}</strong><small>Substitute Fee Desk</small></div>
        </div>
        <button class="setup-shortcut ${activePage === "settings" ? "active" : ""}" data-nav="settings">
          <span>學期初先設定</span>
          <strong>系統設定</strong>
          <small>學校、單價、科目與經費來源</small>
        </button>
        <div class="nav-group-label">工作區</div>
        <nav>
          ${navItems.map(([key, icon, label]) => `
            <button class="nav-button ${activeNavPage === key ? "active" : ""}" data-nav="${key}">
              <span class="nav-icon">${icon}</span><span>${label}</span>
            </button>`).join("")}
        </nav>
        <button class="sidebar-support-link" type="button" data-open-error-report aria-label="回報系統錯誤"><span>!</span>錯誤回報</button>
        <div class="sidebar-foot">
          規則版本：rules-0.2<br />
          現行國小鐘點：${formatMoney(state.config.hourlyRate)} 元<br />
          個案資料：${state.meta?.storageMode === "drive" && cloudUi.connected ? "個人 Google Drive" : "瀏覽器本機快取"}
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div><div class="topbar-title">${escapeHtml(state.config.schoolName)}</div><div class="topbar-sub">${state.config.academicYear} 學年度第 ${state.config.term} 學期</div></div>
          <div class="topbar-actions">
            <div class="account-chip save-chip"><span class="account-dot ${cloudUi.connected ? "connected" : ""}"></span>${savedTimeText()}</div>
            <button class="account-chip topbar-report-button" type="button" data-open-error-report aria-label="回報系統錯誤"><span class="report-mark">!</span>錯誤回報</button>
            <button class="account-chip account-button" type="button" id="open-access"><span class="google-mark">G</span>${escapeHtml(accountButtonText())}</button>
          </div>
        </header>
        <section class="content page-${activePage} ${activePage === "dashboard" ? "dashboard-content" : ""}">${renderPage()}</section>
        ${renderAppFooter("main-footer")}
      </main>
    </div>
    ${renderModal()}`;
  bindCommonEvents();
  bindPageEvents();
  googleCloud.mountSignInButton(document.querySelector("#google-signin-slot"));
}

function renderAccessGate() {
  const busy = ["initializing", "verifying", "authorizing-drive", "loading-drive", "saving"].includes(cloudUi.phase);
  const failed = ["denied", "error", "unavailable"].includes(cloudUi.phase);
  let accountAction = "";

  if (cloudUi.profile) {
    accountAction = `
      <div class="cloud-profile">
        <div><strong>${escapeHtml(cloudUi.profile.name || cloudUi.profile.email)}</strong><span>${escapeHtml(cloudUi.profile.email)}${cloudUi.profile.is_central_admin ? "・中央管理者" : "・教育帳號"}</span></div>
        <span class="badge pending">身分已確認</span>
      </div>
      ${cloudUi.message ? `<div class="notice ${failed ? "danger" : ""}">${escapeHtml(cloudUi.message)}</div>` : ""}
      <button class="btn btn-primary full-button" type="button" id="gate-authorize-drive" ${busy ? "disabled" : ""}>${busy ? "正在完成登入與資料授權…" : "繼續授權資料儲存並進入系統"}</button>
      <button class="btn btn-secondary full-button login-gate-secondary" type="button" id="gate-sign-out" ${busy ? "disabled" : ""}>改用其他帳號</button>`;
  } else {
    accountAction = `
      ${cloudUi.message ? `<div class="notice ${failed ? "danger" : ""}">${escapeHtml(cloudUi.message)}</div>` : ""}
      <div id="google-signin-slot" class="google-signin-slot" aria-label="Google 登入按鈕"></div>
      ${cloudUi.phase === "unavailable" ? '<button class="btn btn-secondary full-button" type="button" id="gate-retry-google">重新連接登入服務</button>' : ""}`;
  }

  app.innerHTML = `
    <main class="login-gate">
      <section class="login-gate-card" aria-labelledby="login-gate-title">
        <div class="login-gate-brand"><span class="brand-mark">鐘</span><div><strong>${escapeHtml(APP_NAME)}</strong><small>Substitute Fee Desk</small></div></div>
        <div class="login-gate-heading"><span>正式使用入口</span><h1 id="login-gate-title">使用 Google 教育帳號登入</h1><p>只要按一次 Google 登入，系統會在確認帳號後接續 Drive 資料授權，完成後直接進入系統。</p></div>
        <div class="notice warning account-rule"><strong>登入規定</strong><br />一般使用者請使用縣市或學校核發、網域以 <b>.edu.tw</b> 結尾的 Google Workspace 教育帳號。個人 Gmail 不開放；中央管理帳號除外。</div>
        <div class="drive-connection-reason">
          <div class="drive-reason-mark">Drive</div>
          <div><h2>為什麼要連接 Google Drive？</h2><p>${escapeHtml(DRIVE_CONNECTION_REASON)}</p><ul><li>只使用本系統專用的隱藏資料空間。</li><li>無法查看、搜尋或修改雲端硬碟中的其他檔案。</li><li>資料仍由登入帳號保管，可另行匯出完整備份。</li><li>第一次使用時，Google 可能連續顯示選帳號與權限確認；這是同一次登入流程。</li></ul></div>
        </div>
        <div class="application-flow login-gate-flow">
          <div><span>1</span><strong>按一次登入</strong><small>伺服端確認帳號資格</small></div>
          <div><span>2</span><strong>接續授權</strong><small>Google 首次確認儲存權限</small></div>
          <div><span>3</span><strong>進入系統</strong><small>自動讀取與同步主檔</small></div>
        </div>
        ${accountAction}
        <div class="admin-boundary login-gate-boundary"><strong>資料仍由使用者保管</strong><span>案件與名冊不會存進中央後臺。</span><small>伺服端只驗證帳號資格；系統資料存放於登入者自己的 Google Drive 隱藏資料空間。</small></div>
        ${renderAppFooter("login-gate-footer")}
      </section>
    </main>
    ${renderModal()}`;

  document.querySelector("#gate-authorize-drive")?.addEventListener("click", () => googleCloud.requestDriveAccess());
  document.querySelector("#gate-sign-out")?.addEventListener("click", () => googleCloud.signOut());
  document.querySelector("#gate-retry-google")?.addEventListener("click", () => googleCloud.initialize());
  bindCommonEvents();
  if (modal === "error-report") bindErrorReportModal();
  googleCloud.mountSignInButton(document.querySelector("#google-signin-slot"));
}

function renderPage() {
  if (activePage === "roster") return renderRoster();
  if (activePage === "case") return renderCaseEditor();
  if (activePage === "cases") return renderCases();
  if (activePage === "attendance") return renderAttendance();
  if (activePage === "monthly") return renderMonthly();
  if (activePage === "settings") return renderSettings();
  return renderDashboard();
}

function pageHeading(eyebrow, title, lead, action = "") {
  return `<div class="page-heading"><div>${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ""}<h1>${title}</h1><p class="lead">${lead}</p></div>${action}</div>`;
}

function renderDashboard() {
  const cases = state.cases;
  const periodCount = cases.reduce((sum, item) => sum + (item.affectedPeriods?.length || 0), 0);
  const calculated = cases.flatMap((item) => item.calculation?.feeItems || []);
  const totals = caseTotals(calculated);
  const pending = cases.filter((item) => item.status !== "ready" && item.status !== "closed").length;
  return `
    ${pageHeading("", "本月課務總覽", "快速查看請假案件、代課節次、待處理事項與鐘點費試算結果。", `
      <div class="button-row"><button class="btn btn-secondary" data-go="settings">學期初設定</button><button class="btn btn-secondary" id="load-demo">載入示範資料</button><button class="btn btn-primary" data-go="case">新增請假案件</button></div>`)}
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">請假案件</div><div class="stat-value">${cases.length}</div><div class="stat-note">目前資料檔</div></div>
      <div class="stat-card"><div class="stat-label">受影響節次</div><div class="stat-value">${periodCount}</div><div class="stat-note">含調補課與代課</div></div>
      <div class="stat-card"><div class="stat-label">待處理案件</div><div class="stat-value">${pending}</div><div class="stat-note">尚未達可月結</div></div>
      <div class="stat-card"><div class="stat-label">已試算金額</div><div class="stat-value">${formatMoney(totals.total)}</div><div class="stat-note">公費 ${formatMoney(totals.public)}／自費 ${formatMoney(totals.self)}</div></div>
    </div>
    <div class="card">
      <div class="card-header"><div><h2>作業流程</h2><p>依序完成名冊、建案、排代、簽到表、規則判斷、經費分攤與月結。</p></div></div>
      <div class="workflow">
        ${[["01","名冊建立"],["02","請假建檔"],["03","課務排代"],["04","紙本簽到"],["05","規則判斷"],["06","經費分攤"],["07","月結報表"]].map(([n, label]) => `<div class="workflow-step"><strong>STEP ${n}</strong><span>${label}</span></div>`).join("")}
      </div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-header"><div><h2>最近案件</h2><p>首頁只顯示日期、節次與合計；完整資料請開啟案件查看。</p></div><button class="link-button" data-go="cases">查看全部${cases.length ? `（${cases.length}）` : ""}</button></div>
        ${renderRecentCaseRows(cases.slice(-3).reverse())}
      </div>
      <div class="card">
        <h2>試算注意事項</h2>
        <div class="notice">事假、家庭照顧假及身心調適假合計每滿 8 小時算 1 日；超過 56 小時的部分另依規定計算。請假時數與代課節數分開計算。</div>
        <div class="notice warning">科任教師代理導師時，代理導師鐘點費不由本系統計算，改由承辦人另依規定人工計算。</div>
        <p class="rule-source">本系統提供試算，結果仍須由承辦單位確認。</p>
      </div>
    </div>`;
}

function renderRecentCaseRows(cases) {
  if (!cases.length) return '<div class="empty">目前沒有案件。可先載入示範資料或新增請假案件。</div>';
  return `<div class="recent-case-list">${cases.map((item) => {
    const totals = caseTotals(item.calculation?.feeItems || []);
    const [status, cls] = statusMeta(item.status);
    const hasCalculation = Boolean(item.calculation);
    return `<div class="recent-case-row">
      <div class="recent-case-main">
        <div class="recent-case-title"><strong>${escapeHtml(personName(item.teacherId))}・${escapeHtml(roleText(personById(item.teacherId)))}・${escapeHtml(leaveLabel(item.leaveType))}</strong><span class="badge ${cls}">${status}</span></div>
        <div class="recent-case-meta"><span>${escapeHtml(item.startDate || "日期未定")}</span><span>${item.affectedPeriods?.length || 0} 節</span><span>${hasCalculation ? `合計 ${formatMoney(totals.total)} 元（公費 ${formatMoney(totals.public)} 元／自費 ${formatMoney(totals.self)} 元）` : "尚未試算"}</span></div>
      </div>
      <button class="btn btn-secondary btn-small" data-edit-case="${item.id}">開啟</button>
    </div>`;
  }).join("")}</div>`;
}

function renderRoster() {
  const rosterFilter = sessionStorage.getItem("roster-substitute-filter") || "all";
  const matchesFilter = (person) => rosterFilter === "all"
    || (rosterFilter === "available" && person.canSubstitute)
    || (rosterFilter === "paused" && !person.canSubstitute);
  const allStaffPeople = state.people.filter((person) => person.personType === "staff");
  const allShortSubs = state.people.filter(isShortSub);
  const staffPeople = allStaffPeople.filter(matchesFilter);
  const shortSubs = allShortSubs.filter(matchesFilter);
  const statusSelect = (person) => `<select class="roster-status-select" data-substitute-status="${person.id}" aria-label="${escapeHtml(person.name)}的排代狀態">${option("available", "可代課", person.canSubstitute ? "available" : "paused")}${option("paused", "暫不排代", person.canSubstitute ? "available" : "paused")}</select>`;
  const personRow = (person, isStaff) => `<div class="roster-person-row" role="listitem">
    <div class="roster-person-main">
      <div class="roster-person-title"><strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(isStaff ? roleText(person) : "短代老師")}</span></div>
      <div class="roster-person-meta"><span>${escapeHtml(person.code ? `編號 ${person.code}` : "未編號")}</span>${isStaff ? `<span>${escapeHtml(person.className ? `班級 ${person.className}` : "未設導師班級")}</span>` : ""}<span>${escapeHtml(person.subjects || "未設領域科目")}</span></div>
    </div>
    <div class="roster-person-control"><label>排代狀態</label>${statusSelect(person)}</div>
    <button class="btn btn-danger btn-small" data-delete-person="${person.id}">移除</button>
  </div>`;
  return `
    ${pageHeading("", "教師與代課教師名單", "校內教師與短期代課教師分開維護；排代狀態會直接控制請假案件中的代課者名單。", `<div class="field roster-filter"><label for="roster-substitute-filter">快速篩選</label><select id="roster-substitute-filter">${option("all", "全部人員", rosterFilter)}${option("available", "只看可代課", rosterFilter)}${option("paused", "只看暫不排代", rosterFilter)}</select></div>`)}
    <div class="roster-grid">
      <div class="card">
        <div class="card-header"><div><h2>校內教師名冊</h2><p>包含導師、科任及兼行政教師；排代狀態可直接調整。</p></div></div>
        <div class="roster-action-bar"><span>共 ${allStaffPeople.length} 人・可代課 ${allStaffPeople.filter((person) => person.canSubstitute).length} 人</span><div class="button-row"><button class="btn btn-secondary btn-small" data-download-template="staff">下載範本</button><label class="btn btn-secondary btn-small file-button">匯入名冊<input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" data-import-roster="staff" /></label><button class="btn btn-primary btn-small" data-open-person="staff">新增教師</button></div></div>
        <div class="notice">匯入欄位：代碼、姓名、任務身分、導師班級、領域科目、可代課。</div>
        <div class="roster-person-list" role="list">
          ${staffPeople.length ? staffPeople.map((person) => personRow(person, true)).join("") : '<div class="empty">目前沒有符合篩選條件的校內教師。</div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div><h2>短代老師名冊</h2><p>供短期代課排代使用；不儲存付款敏感資料。</p></div></div>
        <div class="roster-action-bar"><span>共 ${allShortSubs.length} 人・可代課 ${allShortSubs.filter((person) => person.canSubstitute).length} 人</span><div class="button-row"><button class="btn btn-secondary btn-small" data-download-template="short_sub">下載範本</button><label class="btn btn-secondary btn-small file-button">匯入名冊<input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" data-import-roster="short_sub" /></label><button class="btn btn-primary btn-small" data-open-person="short_sub">新增短代</button></div></div>
        <div class="notice">匯入欄位：自編編號、姓名、領域科目；匯入後預設為可代課。</div>
        <div class="roster-person-list" role="list">
          ${shortSubs.length ? shortSubs.map((person) => personRow(person, false)).join("") : '<div class="empty">目前沒有符合篩選條件的短代老師。</div>'}
        </div>
      </div>
    </div>`;
}

function newCaseDraft() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: newId("DRAFT"),
    teacherId: "",
    leaveType: "personal",
    officialReason: "",
    startDate: today,
    endDate: today,
    startTime: "08:00",
    endTime: "16:00",
    startPart: "am",
    endPart: "pm",
    leaveHours: 8,
    accumulatedHoursBefore: 0,
    consecutiveSickDays: 0,
    businessTripDays: 0,
    hasHomeroomDuty: false,
    homeroomProxyId: "",
    homeroomStartDate: today,
    homeroomEndDate: today,
    homeroomStartPart: "am",
    homeroomEndPart: "pm",
    affectedPeriods: [],
    manualFees: [],
    allocations: [],
    status: "draft",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function renderCaseEditor() {
  if (!draftCase) draftCase = newCaseDraft();
  const c = draftCase;
  const editingExisting = state.cases.some((item) => item.id === c.id);
  const staff = state.people.filter((person) => person.personType === "staff");
  const leaveTeacher = personById(c.teacherId);
  const leaveTeacherIsHomeroom = leaveTeacher?.roles?.includes("homeroom") === true;
  const crossing = ["personal", "family_care"].includes(c.leaveType)
    && Number(c.accumulatedHoursBefore) < 56
    && Number(c.accumulatedHoursBefore) + Number(c.leaveHours) > 56;
  return `
    ${pageHeading("", editingExisting ? `編輯案件 ${escapeHtml(c.id)}` : "新增請假案件", editingExisting ? "從代課費核算開啟；可調整逐節排代、重新試算及覆核費用。" : "依序輸入事實、整理節次、安排代課，再執行規則試算。", `<div class="button-row"><button class="btn btn-secondary" id="save-draft">儲存草稿</button><button class="btn btn-primary" id="calculate-case">執行試算</button></div>`)}
    <form id="case-form" autocomplete="off">
      <div class="card">
        <div class="card-header"><div><h2>1. 請假事實</h2><p>系統不保存身心調適或病假具體原因。</p></div><span class="badge none">事實層</span></div>
        ${staff.length ? "" : '<div class="notice warning">尚無校內教師。請先到「教師與代課教師名單」建立人員。</div>'}
        <div class="form-grid">
          <div class="field ${c.leaveType === "official" ? "" : "span-6"}"><label for="teacherId">請假教師</label><select id="teacherId" name="teacherId"><option value="">請選擇</option>${staff.map((person) => option(person.id, `${person.name}｜${roleText(person)}`, c.teacherId)).join("")}</select></div>
          <div class="field ${c.leaveType === "official" ? "" : "span-6"}"><label for="leaveType">假別</label><select id="leaveType" name="leaveType">${LEAVE_TYPES.map((item) => option(item.value, item.label, c.leaveType)).join("")}</select></div>
          ${c.leaveType === "official" ? `<div class="field"><label for="officialReason">公假課務情境</label><select id="officialReason" name="officialReason" required><option value="">請選擇實際情境</option>${OFFICIAL_REASONS.map((item) => option(item.value, item.label, c.officialReason)).join("")}</select><div class="help">此欄決定課務為公費、自費或不發生，不是讓使用者直接選費用負擔。</div></div>` : ""}
          <div class="field span-2"><label for="startDate">開始日期</label><input id="startDate" name="startDate" type="date" value="${escapeHtml(c.startDate)}" /></div>
          <div class="field span-2"><label for="startPart">開始時段</label><select id="startPart" name="startPart">${option("am", "上午", c.startPart)}${option("pm", "下午", c.startPart)}</select></div>
          <div class="field span-2"><label for="startTime">開始時間</label><input id="startTime" name="startTime" type="time" value="${escapeHtml(c.startTime || "08:00")}" /></div>
          <div class="field span-2"><label for="endDate">結束日期</label><input id="endDate" name="endDate" type="date" value="${escapeHtml(c.endDate)}" /></div>
          <div class="field span-2"><label for="endPart">結束時段</label><select id="endPart" name="endPart">${option("am", "上午", c.endPart)}${option("pm", "下午", c.endPart)}</select></div>
          <div class="field span-2"><label for="endTime">結束時間</label><input id="endTime" name="endTime" type="time" value="${escapeHtml(c.endTime || "16:00")}" /></div>
          <div class="field span-12"><div class="help">精確時間供課表與受影響節次對應；請假時數仍以差勤核准資料為準，不直接由起訖時間相減。</div></div>
          <div class="field span-3"><label for="leaveHours">本次請假時數</label><input id="leaveHours" name="leaveHours" type="number" min="0" step="0.5" value="${c.leaveHours}" /><div class="help">時計額度用；不是代課節數。</div></div>
          <div class="field span-3"><label for="accumulatedHoursBefore">事假類請假前累計</label><input id="accumulatedHoursBefore" name="accumulatedHoursBefore" type="number" min="0" step="0.5" value="${c.accumulatedHoursBefore}" /><div class="help">事假＋家庭照顧假＋身心調適假，56 小時為七日。</div></div>
          <div class="field span-3"><label for="consecutiveSickDays">連續病假日數</label><input id="consecutiveSickDays" name="consecutiveSickDays" type="number" min="0" step="1" value="${c.consecutiveSickDays}" /></div>
          <div class="field span-3"><label for="businessTripDays">公差日數</label><input id="businessTripDays" name="businessTripDays" type="number" min="0" step="1" value="${c.businessTripDays}" /></div>
        </div>
        ${crossing ? '<div class="notice warning">本案跨越 56 小時門檻。請在每個受影響節次標示「門檻內」或「超過門檻」，系統會分開判定自費與公費。</div>' : ""}
      </div>

      <div class="card">
        <div class="card-header"><div><h2>2. 受影響節次與排代</h2><p>有課才派；調課、補課及長期代理涵蓋不產生逐節代課費。</p></div><button class="btn btn-secondary btn-small" type="button" id="add-period">新增節次</button></div>
        <div class="table-wrap">
          <table><thead><tr><th>日期</th><th>節次</th><th>班級</th><th>科目</th><th>處理方式</th><th>代課者</th><th>經費來源</th><th>56 小時區段</th><th>超鐘點</th><th></th></tr></thead>
          <tbody>${c.affectedPeriods.length ? c.affectedPeriods.map((period) => `
            <tr data-period-row="${period.id}">
              <td><input data-key="date" type="date" value="${escapeHtml(period.date || c.startDate)}" /></td>
              <td><input data-key="periodNo" type="number" min="1" max="12" value="${period.periodNo || 1}" /></td>
              <td><input data-key="className" value="${escapeHtml(period.className || "")}" /></td>
              <td><select data-key="subject" aria-label="科目"><option value="">請選擇</option>${subjectOptions(period.subject || "")}</select></td>
              <td><select data-key="handling">${HANDLING_TYPES.map((item) => option(item.value, item.label, period.handling)).join("")}</select></td>
              <td><select data-key="substituteId"><option value="">未指定</option>${substituteOptions(period.substituteId)}</select></td>
              <td><select data-key="fundSourceId" aria-label="經費來源"><option value="">依規則判斷</option>${fundSourceOptions(period.fundSourceId)}</select></td>
              <td><select data-key="thresholdZone"><option value="">不適用／未選</option>${option("within", "門檻內", period.thresholdZone)}${option("over", "超過門檻", period.thresholdZone)}</select></td>
              <td><input data-key="isOvertime" type="checkbox" ${period.isOvertime ? "checked" : ""} /></td>
              <td><button class="btn btn-danger btn-small" type="button" data-delete-period="${period.id}">移除</button></td>
            </tr>`).join("") : `<tr><td colspan="10" class="empty">尚未加入受影響節次。</td></tr>`}</tbody></table>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div><h2>3. 導師職務代理</h2><p>課務代課鐘點費、代理導師職務加給、代理導師鐘點費分開處理。</p></div></div>
        ${!c.teacherId
          ? '<div class="notice">請先選擇請假教師；只有名冊身分含「導師」時，才會出現導師職務代理檢核。</div>'
          : !leaveTeacherIsHomeroom
            ? '<div class="notice">本案請假教師不是導師，不適用導師職務代理。</div>'
            : `<div class="form-grid">
                <div class="field span-12"><div class="check-row"><input id="hasHomeroomDuty" name="hasHomeroomDuty" type="checkbox" ${c.hasHomeroomDuty ? "checked" : ""} /><label for="hasHomeroomDuty">本案需要代理導師職務</label></div></div>
                ${c.hasHomeroomDuty ? `
                  <div class="field"><label for="homeroomProxyId">導師職務代理人</label><select id="homeroomProxyId" name="homeroomProxyId"><option value="">請選擇</option>${substituteOptions(c.homeroomProxyId)}</select></div>
                  <div class="field span-3"><label for="homeroomStartDate">代理開始</label><input id="homeroomStartDate" name="homeroomStartDate" type="date" value="${escapeHtml(c.homeroomStartDate || c.startDate)}" /></div>
                  <div class="field span-3"><label for="homeroomStartPart">開始時段</label><select id="homeroomStartPart" name="homeroomStartPart">${option("am", "上午", c.homeroomStartPart)}${option("pm", "下午", c.homeroomStartPart)}</select></div>
                  <div class="field span-3"><label for="homeroomEndDate">代理結束</label><input id="homeroomEndDate" name="homeroomEndDate" type="date" value="${escapeHtml(c.homeroomEndDate || c.endDate)}" /></div>
                  <div class="field span-3"><label for="homeroomEndPart">結束時段</label><select id="homeroomEndPart" name="homeroomEndPart">${option("am", "上午", c.homeroomEndPart)}${option("pm", "下午", c.homeroomEndPart)}</select></div>`
                  : ""}
              </div>`}
      </div>
    </form>
    ${c.calculation ? renderCalculation(c) : ""}`;
}

function renderCalculation(c) {
  const calc = c.calculation;
  const totals = caseTotals(calc.feeItems);
  const proxy = personById(c.homeroomProxyId);
  const manualTrigger = c.hasHomeroomDuty && proxy?.roles?.includes("subject") && !proxy?.roles?.includes("homeroom") && !proxy?.roles?.includes("admin");
  return `
    <div class="card" id="calculation-results">
      <div class="card-header"><div><h2>4. 規則判斷與費用項目</h2><p>規則 ${calc.versions.rules}／金額 ${calc.versions.rates}／AR ${calc.versions.reasons}</p></div><button class="btn btn-primary" id="mark-ready">完成覆核，標記可月結</button></div>
      ${calc.errors.length ? `<div class="notice danger"><strong>尚有 ${calc.errors.length} 項需處理：</strong><br />${calc.errors.map(escapeHtml).join("<br />")}</div>` : '<div class="notice">規則判斷已完成；請確認公費分攤是否平衡。</div>'}
      ${manualTrigger ? `<div class="notice warning"><strong>請人工計算代理導師鐘點費</strong><br />代理人 ${escapeHtml(proxy.name)} 為科任教師，請由承辦人另依規定人工計算。如需併入本案，可在計算完成後手動新增。<div class="button-row" style="margin-top:10px"><button class="btn btn-secondary btn-small" id="open-manual-fee">手動新增計算結果</button></div></div>` : ""}
      <div class="summary-strip">
        <div class="summary-item"><span>公費</span><strong>${formatMoney(totals.public)} 元</strong></div>
        <div class="summary-item"><span>自費</span><strong>${formatMoney(totals.self)} 元</strong></div>
        <div class="summary-item"><span>合計</span><strong>${formatMoney(totals.total)} 元</strong></div>
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>費用項目</th><th>領款人</th><th>數量</th><th>單價</th><th>費用負擔</th><th>金額</th><th>規則／法源</th></tr></thead>
        <tbody>${calc.feeItems.length ? calc.feeItems.map((fee) => `
          <tr><td><strong>${fee.type === "course_hourly" ? "課務代課鐘點費" : fee.type === "homeroom_allowance" ? "代理導師職務加給" : "代理導師鐘點費"}</strong>${fee.manual ? '<br /><span class="badge manual">人工認定</span>' : ""}</td><td>${escapeHtml(personName(fee.payeeId))}</td><td>${formatMoney(fee.quantity)} ${fee.type === "homeroom_allowance" ? "日" : "節"}</td><td>${formatMoney(fee.unitRate)}</td><td>${burdenBadge(fee.burden)}</td><td class="amount">${formatMoney(fee.amount)} 元</td><td><div>${escapeHtml(fee.ruleTitle)}</div><div class="rule-source">${escapeHtml(fee.source)}</div></td></tr>
          ${fee.burden === BURDEN.PUBLIC ? `<tr><td colspan="7">${renderAllocationBox(c, fee)}</td></tr>` : ""}`
        ).join("") : `<tr><td colspan="7" class="empty">目前沒有會發生金額的費用項目。</td></tr>`}</tbody></table>
      </div>
      <div class="notice" style="margin-top:18px">經費來源之勾選，請依中央及地方主管機關規定暨該案經費核定文件辦理，本系統僅供記錄，不代為認定。</div>
    </div>`;
}

function allocationRowsFor(c, feeId) {
  return c.allocations?.find((item) => item.feeId === feeId)?.rows || [];
}

function renderAllocationBox(c, fee) {
  const rows = allocationRowsFor(c, fee.id);
  const balance = allocationBalance(fee, rows);
  return `<div class="allocation-box" data-allocation-box="${fee.id}">
    <div><strong>公費來源分攤</strong> <span class="${balance === 0 ? "balance-ok" : "balance-bad"}">${balance === 0 ? "已平衡" : `尚差 ${formatMoney(balance)} 元`}</span></div>
    ${rows.map((row) => `<div class="allocation-row" data-allocation-row="${row.id}"><select data-allocation-key="sourceId" aria-label="公費來源">${fundSourceOptions(row.sourceId, true)}</select><input data-allocation-key="note" aria-label="來源細節" maxlength="120" placeholder="選填：計畫名稱／來源細節" value="${escapeHtml(row.note || "")}" /><input data-allocation-key="amount" aria-label="分攤金額" type="number" min="0" step="0.01" value="${row.amount}" /><button type="button" class="btn btn-danger btn-small" data-delete-allocation="${fee.id}|${row.id}">移除</button></div>`).join("")}
    <button type="button" class="link-button" data-add-allocation="${fee.id}" style="margin-top:10px">＋新增分攤來源</button>
  </div>`;
}

function renderCases() {
  return `
    ${pageHeading("", "代課費核算", "查看每筆請假案件的排代、試算與費用分攤結果。", `<button class="btn btn-primary" data-go="case">新增請假案件</button>`)}
    <div class="card">
      <div class="card-header"><div><h2>全部案件</h2><p>已月結案件若修改，後續會建立更正版本。</p></div><span class="badge none">${state.cases.length} 案</span></div>
      ${renderCaseRows([...state.cases].reverse(), true)}
    </div>`;
}

function defaultAttendanceDate(rows) {
  const stored = sessionStorage.getItem("selected-attendance-date");
  if (stored) return stored;
  const dates = [...new Set(rows.map((row) => row.date).filter(Boolean))].sort();
  const today = localDateValue();
  return dates.includes(today) ? today : dates.find((date) => date >= today) || dates.at(-1) || today;
}

function renderAttendance() {
  const allRows = collectSignInSheetRows(state.cases);
  const selectedDate = defaultAttendanceDate(allRows);
  const availableSubstituteIds = [...new Set(allRows
    .filter((row) => row.date === selectedDate)
    .map((row) => row.substituteId))];
  const storedSubstitute = sessionStorage.getItem("selected-attendance-teacher") || "all";
  const selectedSubstitute = storedSubstitute === "all" || availableSubstituteIds.includes(storedSubstitute)
    ? storedSubstitute
    : "all";
  const rows = allRows.filter((row) => row.date === selectedDate
    && (selectedSubstitute === "all" || row.substituteId === selectedSubstitute));
  const missingClassRows = rows.filter((row) => !row.className.trim());
  const internalCount = rows.filter((row) => row.handling === "internal_sub").length;
  const externalCount = rows.filter((row) => row.handling === "external_sub").length;
  const classCount = new Set(rows.map((row) => row.className).filter(Boolean)).size;
  const previewOpen = sessionStorage.getItem("attendance-preview") === "open";
  const canPrint = rows.length > 0 && missingClassRows.length === 0;

  return `
    ${pageHeading("", "紙本代課簽到表", "依排代資料自動帶入班級與節次，列印後由代課教師親筆簽名，供核銷附件使用。")} 
    <div class="attendance-toolbar screen-only">
      <div class="field"><label for="attendance-date">簽到日期</label><input id="attendance-date" type="date" value="${escapeHtml(selectedDate)}" /></div>
      <div class="field"><label for="attendance-teacher">代課教師</label><select id="attendance-teacher"><option value="all">全部代課教師</option>${availableSubstituteIds.map((id) => option(id, personName(id), selectedSubstitute)).join("")}</select></div>
      <button class="btn btn-primary" id="print-attendance" ${canPrint ? "" : "disabled"}>列印 A4 簽到表</button>
      <button class="btn btn-secondary" id="toggle-attendance-preview" aria-expanded="${previewOpen}" aria-controls="attendance-print-sheet" ${rows.length ? "" : "disabled"}>${previewOpen ? "收合預覽" : "預覽列印內容"}</button>
    </div>
    <div class="notice screen-only">本表只整理實際排代資料，不影響公費／自費判斷。簽名欄不存入系統，請列印後親筆簽名。</div>
    ${missingClassRows.length ? `<div class="notice danger screen-only">尚有 ${missingClassRows.length} 節未填班級，補齊後才能列印：${missingClassRows.map((row) => `<button class="link-button" data-open-attendance-case="${row.caseId}">${escapeHtml(row.caseId)} 第 ${formatMoney(row.periodNo)} 節</button>`).join("、")}</div>` : ""}
    <div class="attendance-summary screen-only">
      <div><span class="attendance-summary-label">本次列印</span><strong>${rows.length} 節</strong><span>${selectedSubstitute === "all" ? "全部代課教師" : escapeHtml(personName(selectedSubstitute))}</span></div>
      <div class="attendance-summary-details"><span>校內 ${internalCount} 節</span><span>外聘 ${externalCount} 節</span><span>${classCount} 個班級</span></div>
    </div>
    <div class="card print-sheet attendance-print-sheet ${previewOpen ? "is-preview" : ""}" id="attendance-print-sheet">
      <div class="print-sheet-header">
        <div class="print-school">${escapeHtml(state.config.schoolName)}</div>
        <h2>代課教師簽到表</h2>
        <div class="print-meta"><span>${escapeHtml(state.config.academicYear)} 學年度第 ${escapeHtml(state.config.term)} 學期</span><span>日期：${escapeHtml(selectedDate)}</span>${selectedSubstitute !== "all" ? `<span>代課教師：${escapeHtml(personName(selectedSubstitute))}</span>` : ""}</div>
      </div>
      <div class="table-wrap"><table class="attendance-table"><thead><tr><th>節次</th><th>班級</th><th>科目</th><th>請假教師</th><th>代課教師</th><th>排代方式</th><th class="signature-column">代課教師簽名</th></tr></thead><tbody>
        ${rows.length ? rows.map((row) => `<tr>
          <td><strong>第 ${formatMoney(row.periodNo)} 節</strong></td>
          <td><strong>${escapeHtml(row.className || "待補")}</strong></td>
          <td>${escapeHtml(row.subject || "未填")}</td>
          <td>${escapeHtml(personName(row.teacherId))}</td>
          <td><strong>${escapeHtml(personName(row.substituteId))}</strong></td>
          <td>${escapeHtml(HANDLING_TYPES.find((item) => item.value === row.handling)?.label || row.handling)}</td>
          <td class="signature-cell"><span class="screen-signature-hint">列印後簽名</span></td>
        </tr>`).join("") : '<tr><td colspan="7" class="empty">此日期沒有已安排代課教師的節次。</td></tr>'}
      </tbody></table></div>
      <div class="print-summary">本日代課共 ${rows.length} 節（校內代課 ${internalCount} 節；外聘代課 ${externalCount} 節）</div>
      <div class="approval-lines"><span>承辦人：________________</span><span>教務主任：________________</span><span>校長：________________</span></div>
    </div>`;
}

function renderCaseRows(cases, showDelete = false) {
  if (!cases.length) return '<div class="empty">目前沒有案件。可先載入示範資料或新增請假案件。</div>';
  return `<div class="case-list">${cases.map((item) => {
    const totals = caseTotals(item.calculation?.feeItems || []);
    const [status, cls] = statusMeta(item.status);
    return `<div class="case-row ${showDelete ? "" : "compact"}"><div><strong>${escapeHtml(personName(item.teacherId))}・${escapeHtml(leaveLabel(item.leaveType))}</strong>${showDelete ? `<small>${escapeHtml(item.id)}｜${escapeHtml(item.startDate || "未定日期")}</small>` : `<small>${escapeHtml(item.id)}</small><small>${escapeHtml(item.startDate || "未定日期")}</small><span class="badge ${cls}">${status}</span>`}</div><div><small>節次</small><strong>${item.affectedPeriods?.length || 0}</strong></div><div><small>公費</small><strong>${formatMoney(totals.public)}</strong></div><div><small>自費</small><strong>${formatMoney(totals.self)}</strong></div>${showDelete ? `<div><span class="badge ${cls}">${status}</span></div>` : ""}<div class="button-row"><button class="btn btn-secondary btn-small" data-edit-case="${item.id}">開啟</button>${showDelete ? `<button class="btn btn-danger btn-small" data-delete-case="${item.id}">刪除</button>` : ""}</div></div>`;
  }).join("")}</div>`;
}

function collectMonth(month) {
  const relevantCases = state.cases.filter((item) => (item.affectedPeriods || []).some((period) => period.date?.startsWith(month)) || item.homeroomStartDate?.startsWith(month));
  const feeItems = relevantCases.flatMap((item) => (item.calculation?.feeItems || []).filter((fee) => fee.serviceMonth === month));
  const totals = caseTotals(feeItems);
  const pending = relevantCases.filter((item) => item.status !== "ready" && item.status !== "closed");
  const fundTotals = new Map();
  const monthlyFeeIds = new Set(feeItems.map((fee) => fee.id));
  for (const item of relevantCases) {
    for (const allocation of item.allocations || []) {
      if (!monthlyFeeIds.has(allocation.feeId)) continue;
      for (const row of allocation.rows || []) {
        fundTotals.set(row.sourceId, (fundTotals.get(row.sourceId) || 0) + Number(row.amount || 0));
      }
    }
  }
  return { relevantCases, feeItems, totals, pending, fundTotals };
}

function renderMonthly() {
  const month = sessionStorage.getItem("selected-month") || firstCaseMonth();
  const data = collectMonth(month);
  const exportRows = buildMonthlyExportRows(data.relevantCases, month, state.people, state.fundSources);
  return `
    ${pageHeading("", "月結與報表", "依實際代課發生日歸屬月份，可列印月結報表或下載本月費用明細。", `<div class="field" style="min-width:180px"><label for="month-picker">核算月份</label><input id="month-picker" type="month" value="${month}" /></div>`)}
    ${data.pending.length ? `<div class="notice danger">本月仍有 ${data.pending.length} 案尚未完成覆核：${data.pending.map((item) => escapeHtml(item.id)).join("、")}</div>` : '<div class="notice">本月案件均已完成覆核，可列印或匯出費用明細。</div>'}
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">案件</div><div class="stat-value">${data.relevantCases.length}</div><div class="stat-note">實際發生日落在本月</div></div>
      <div class="stat-card"><div class="stat-label">公費</div><div class="stat-value">${formatMoney(data.totals.public)}</div><div class="stat-note">待依經費別送核</div></div>
      <div class="stat-card"><div class="stat-label">教師自費</div><div class="stat-value">${formatMoney(data.totals.self)}</div><div class="stat-note">請假教師負擔</div></div>
      <div class="stat-card"><div class="stat-label">合計</div><div class="stat-value">${formatMoney(data.totals.total)}</div><div class="stat-note">本月代課費用</div></div>
    </div>
    <div class="grid-2">
      <div class="card monthly-print-sheet">
        <div class="print-sheet-header monthly-print-header print-only">
          <div class="print-school">${escapeHtml(state.config.schoolName)}</div>
          <h2>代課費用明細</h2>
          <div class="print-meta"><span>${escapeHtml(state.config.academicYear)} 學年度第 ${escapeHtml(state.config.term)} 學期</span><span>核算月份：${escapeHtml(month)}</span></div>
        </div>
        <div class="card-header"><div><h2>費用明細</h2><p>列印供送核的月結報表，或下載可用試算表開啟的 CSV 明細。</p></div><div class="button-row screen-only"><button class="btn btn-secondary" id="print-monthly" ${exportRows.length ? "" : "disabled"}>列印月結報表</button><button class="btn btn-primary" id="export-monthly" ${exportRows.length ? "" : "disabled"}>下載明細 CSV</button></div></div>
        <div class="backup-inline-hint screen-only"><div class="backup-hint-icon">備</div><div><strong>月結完成後，建議保留一份「完整備份」</strong><span>列印時系統會提醒下載。完整備份可匯入復原資料；CSV 只能查看明細，不能還原系統。</span></div></div>
        <div class="table-wrap"><table class="monthly-print-table"><thead><tr><th>日期</th><th>班級</th><th>費用項目</th><th>領款人</th><th>數量／單價</th><th>負擔</th><th>金額</th></tr></thead><tbody>${exportRows.map((row) => `<tr><td>${escapeHtml(row.dates || "—")}</td><td>${escapeHtml(row.classes || "—")}</td><td>${escapeHtml(row.feeType)}${row.manual ? ' <span class="badge manual">人工</span>' : ""}<small>${escapeHtml(row.caseId)}</small></td><td>${escapeHtml(row.payeeName)}</td><td>${formatMoney(row.quantity)} ${escapeHtml(row.unit)} × ${formatMoney(row.unitRate)}</td><td>${burdenBadge(row.burdenCode)}</td><td class="amount">${formatMoney(row.amount)} 元</td></tr>`).join("") || '<tr><td colspan="7" class="empty">本月尚無已試算費用。</td></tr>'}</tbody></table></div>
        <div class="monthly-print-summary">公費 ${formatMoney(data.totals.public)} 元　／　自費 ${formatMoney(data.totals.self)} 元　／　合計 ${formatMoney(data.totals.public + data.totals.self)} 元</div>
        <div class="approval-lines print-only"><span>承辦人：________________</span><span>覆核：________________</span><span>單位主管：________________</span></div>
      </div>
      <div class="card monthly-side-card">
        <h2>公費來源小計</h2>
        ${data.fundTotals.size ? [...data.fundTotals.entries()].map(([id, amount]) => `<div class="summary-item" style="margin-top:10px"><span>${escapeHtml(state.fundSources.find((source) => source.id === id)?.name || id)}</span><strong>${formatMoney(amount)} 元</strong></div>`).join("") : '<div class="empty">尚無公費分攤資料。</div>'}
        <div class="notice warning">經費來源僅供記錄與月結統計，不代表系統認定該來源得合法支用。</div>
      </div>
    </div>`;
}

function renderSettings() {
  const usingDrive = state.meta?.storageMode === "drive" && cloudUi.connected;
  return `
    ${pageHeading("", "系統設定", "每學期開始前，請先確認學校、學年度、鐘點單價、科目與經費來源。")} 
    <div class="grid-2">
      <div class="card">
        <div class="card-header"><div><h2>學校基本資料與金額</h2><p>修改後，既有案件須重新試算才會套用。</p></div></div>
        <form id="settings-form"><div class="form-grid">
          <div class="field span-12"><label for="schoolName">學校名稱</label><input id="schoolName" name="schoolName" value="${escapeHtml(state.config.schoolName)}" /></div>
          <div class="field"><label for="academicYear">學年度</label><input id="academicYear" name="academicYear" value="${escapeHtml(state.config.academicYear)}" /></div>
          <div class="field"><label for="term">學期</label><select id="term" name="term">${option("1", "第一學期", state.config.term)}${option("2", "第二學期", state.config.term)}</select></div>
          <div class="field"><label for="hourlyRate">國小每節鐘點費</label><input id="hourlyRate" name="hourlyRate" type="number" min="0" value="${state.config.hourlyRate}" /></div>
          <div class="field"><label for="homeroomMonthly">導師職務加給月額</label><input id="homeroomMonthly" name="homeroomMonthly" type="number" min="0" value="${state.config.homeroomMonthly}" /></div>
          <div class="field span-6"><label for="roundingMode">導師職務加給小數處理</label><select id="roundingMode" name="roundingMode">${option("round", "元以下四捨五入（目前預設）", state.config.roundingMode)}${option("floor", "元以下無條件捨去", state.config.roundingMode)}${option("keep2", "保留小數 2 位", state.config.roundingMode)}</select><div class="help">此為可確認參數；正式送核前依校內作業方式確認。</div></div>
        </div><div class="button-row" style="margin-top:20px"><button class="btn btn-primary" type="submit">儲存設定</button></div></form>
      </div>
      <div class="card">
        <div class="card-header"><div><h2>資料存取與備份</h2><p>平常不必找檔案；登入後自動讀取，每次修改自動儲存。</p></div></div>
        <div class="storage-status"><span class="account-dot ${usingDrive ? "connected" : ""}"></span><div><strong>${usingDrive ? "目前使用個人 Google Drive 自動同步" : "目前使用本機自動儲存"}</strong><small>${savedTimeText()}${usingDrive ? "" : "；登入並連接後改存個人 Google Drive。"}</small></div></div>
        <div class="storage-flow" aria-label="資料存取流程">
          <div><strong>開啟系統</strong><span>自動讀取</span></div>
          <div><strong>新增或修改</strong><span>自動儲存</span></div>
          <div><strong>換人或換電腦</strong><span>匯出／匯入備份</span></div>
        </div>
        <div class="button-row backup-actions"><button class="btn btn-primary" type="button" id="export-backup">匯出完整備份</button><label class="btn btn-secondary file-button">匯入完整備份<input type="file" accept=".json,application/json" id="import-backup" /></label></div>
        <div class="help"><strong>完整備份可復原系統：</strong>若資料遺失、換電腦或需要交接，可在這裡匯入。匯入前會先顯示學校、匯出時間與案件數，確認後才會取代目前資料。</div>
        <hr class="section-rule" />
        <div class="button-row"><button class="btn btn-secondary" id="load-demo-settings">改用示範資料</button><button class="btn btn-danger" id="clear-data">清空本機資料</button></div>
      </div>
    </div>
    <div class="card access-policy-card">
      <div class="card-header"><div><h2>帳號登入與中央管理</h2><p>教育網域帳號可直接登入；中央管理帳號只維護允許網域與規則版本，不讀取各校存在個人 Drive 的案件資料。</p></div><button class="btn btn-secondary" type="button" id="open-access-settings">查看登入說明</button></div>
      <div class="policy-grid">
        <div><strong>可直接登入</strong><span>縣市或學校核發、網域以 .edu.tw 結尾的 Google 教育帳號。</span></div>
        <div><strong>不接受</strong><span>@gmail.com、@googlemail.com 等個人 Google 帳號。</span></div>
        <div><strong>中央管理者</strong><span>管理帳號只在伺服端綁定，前端無法自行取得管理權。</span></div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div><h2>科目基本資料</h2><p>排代明細會使用此清單作為科目下拉選單。</p></div></div>
      <form id="subject-form" class="subject-add-row"><div class="field"><label for="newSubject">新增科目</label><input id="newSubject" name="subject" maxlength="30" placeholder="例如：資訊、國樂團" required /></div><button class="btn btn-primary" type="submit">新增科目</button></form>
      <div class="subject-list">${state.subjects.map((subject) => `<span class="subject-chip"><span>${escapeHtml(subject)}</span><button type="button" data-delete-subject="${escapeHtml(subject)}" aria-label="移除${escapeHtml(subject)}">×</button></span>`).join("")}</div>
    </div>
    <div class="card">
      <div class="card-header"><div><h2>經費來源</h2><p>可新增公費、自費或其他來源；公費項目仍可在核算結果中複選分攤。</p></div><button class="btn btn-primary btn-small" type="button" id="open-fund-source">新增經費來源</button></div>
      <div class="notice">規則負責判斷公費或自費；此處的來源名稱供排代預選、分攤與月結統計使用，不代為認定經費是否合法支用。</div>
      <div class="table-wrap"><table><thead><tr><th>負擔類別</th><th>顯示名稱</th><th>狀態</th><th></th></tr></thead><tbody>${state.fundSources.map((source) => `<tr><td>${escapeHtml(fundSourceKindLabel(source.burdenType))}</td><td>${escapeHtml(source.name)}</td><td><select data-fund-source-status="${source.id}" aria-label="${escapeHtml(source.name)}狀態">${option("active", "啟用", source.active ? "active" : "paused")}${option("paused", "停用", source.active ? "active" : "paused")}</select></td><td>${source.custom ? `<button class="btn btn-danger btn-small" type="button" data-delete-fund-source="${source.id}">移除</button>` : '<span class="muted">內建</span>'}</td></tr>`).join("")}</tbody></table></div>
    </div>`;
}

function renderModal() {
  if (modal === "error-report") {
    return `<div class="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="error-report-title"><div class="dialog error-report-dialog"><div class="card-header"><div><h2 id="error-report-title">錯誤回報</h2><p>填寫問題說明並選取截圖，再傳送給開發者。</p></div><button class="btn btn-secondary btn-small" data-close-modal>關閉</button></div>
      <div class="notice warning"><strong>傳送前請先檢查：</strong>說明與截圖不得包含身分證、金融帳號、教師請假原因或其他敏感個資。</div>
      <form id="error-report-form"><div class="form-grid">
        <div class="field span-12"><label for="reportDescription">問題說明</label><textarea id="reportDescription" name="description" rows="4" maxlength="1200" placeholder="請說明原本想完成什麼，以及畫面發生什麼問題。" required></textarea></div>
        <div class="field span-12"><label for="reportSteps">操作步驟</label><textarea id="reportSteps" name="steps" rows="3" maxlength="1200" placeholder="例如：進入代課費核算 → 開啟案件 → 按下重新試算。"></textarea></div>
        <div class="field span-12"><label for="reportScreenshot">畫面截圖（建議，最大 5 MB）</label><input id="reportScreenshot" name="screenshot" type="file" accept="image/png,image/jpeg,image/webp" /><div id="report-file-preview" class="report-file-preview"><span>尚未選取截圖</span></div></div>
        <div class="field span-12"><label class="check-row privacy-confirm"><input type="checkbox" name="privacyConfirmed" required />我已確認說明與截圖不含敏感個資。</label></div>
      </div>
      <div class="report-delivery-note">手機或支援檔案分享的裝置會開啟分享畫面並帶入截圖；其他環境會開啟預填郵件，請再附加所選截圖。</div>
      <div class="button-row report-submit-row"><button class="btn btn-primary" type="submit">傳送給開發者</button><button class="btn btn-secondary" type="button" id="copy-error-report">複製回報文字</button></div></form>
    </div></div>`;
  }
  if (modal === "person") {
    const isStaff = personModalType === "staff";
    return `<div class="dialog-backdrop" role="dialog" aria-modal="true"><div class="dialog"><div class="card-header"><div><h2>單筆新增${isStaff ? "校內教師" : "短代老師"}</h2><p>${isStaff ? "可設定導師、科任、兼行政與是否協助代課。" : "建立後會直接列入可代課名單。"}</p></div><button class="btn btn-secondary btn-small" data-close-modal>關閉</button></div>
      <form id="person-form" data-person-type="${personModalType}"><div class="form-grid">
        <div class="field span-6"><label for="personCode">${isStaff ? "校內代碼" : "自編編號"}</label><input id="personCode" name="code" /></div>
        <div class="field span-6"><label for="personName">姓名</label><input id="personName" name="name" required /></div>
        ${isStaff ? `<div class="field span-12"><span class="field-label">任務身分</span><div class="button-row"><label class="check-row"><input type="checkbox" name="roles" value="homeroom" />導師</label><label class="check-row"><input type="checkbox" name="roles" value="subject" />科任</label><label class="check-row"><input type="checkbox" name="roles" value="admin" />兼行政</label></div></div>
        <div class="field span-6"><label for="className">導師班級</label><input id="className" name="className" /></div>` : ""}
        <div class="field span-6"><label for="subjects">領域／科目</label><input id="subjects" name="subjects" /></div>
        ${isStaff ? '<div class="field span-12"><label class="check-row"><input type="checkbox" name="canSubstitute" />列入可代課名單</label></div>' : '<div class="field span-12"><div class="notice">短代老師預設為可排代；付款敏感資料請留在既有出納流程。</div></div>'}
      </div><div class="button-row" style="margin-top:20px"><button class="btn btn-primary" type="submit">建立人員</button></div></form>
    </div></div>`;
  }
  if (modal === "manual-fee") {
    return `<div class="dialog-backdrop" role="dialog" aria-modal="true"><div class="dialog"><div class="card-header"><div><h2>手動新增代理導師鐘點費</h2><p>本項不由規則引擎自動判定，必須留下 AR 代碼與文件參照。</p></div><button class="btn btn-secondary btn-small" data-close-modal>關閉</button></div>
      <form id="manual-fee-form"><div class="notice warning">此處是「每週授課差距節數」衍生的代理導師鐘點費，不是代理導師職務加給。</div><div class="form-grid">
        <div class="field"><label for="manualQty">核定節數</label><input id="manualQty" name="quantity" type="number" min="0" step="1" required /></div>
        <div class="field"><label for="manualRate">每節單價</label><input id="manualRate" name="unitRate" type="number" min="0" value="${state.config.hourlyRate}" required /></div>
        <div class="field"><label for="manualReason">認定理由代碼</label><select id="manualReason" name="reasonCode" required><option value="">請選擇</option>${REASON_CODES.map((item) => option(item.code, `${item.code} ${item.label}`, "")).join("")}</select></div>
        <div class="field span-12"><label for="manualDoc">法源或核定文件文號／日期</label><input id="manualDoc" name="documentRef" required /></div>
      </div><div class="button-row" style="margin-top:20px"><button class="btn btn-primary" type="submit">新增人工費用項目</button></div></form>
    </div></div>`;
  }
  if (modal === "fund-source") {
    return `<div class="dialog-backdrop" role="dialog" aria-modal="true"><div class="dialog"><div class="card-header"><div><h2>新增經費來源</h2><p>建立後可在排代節次預選，公費項目也可用於分攤。</p></div><button class="btn btn-secondary btn-small" data-close-modal>關閉</button></div>
      <form id="fund-source-form"><div class="form-grid">
        <div class="field span-6"><label for="fundSourceType">負擔類別</label><select id="fundSourceType" name="burdenType">${option("public", "公費來源", "public")}${option("self", "教師自費", "public")}${option("other", "其他", "public")}</select></div>
        <div class="field span-6"><label for="fundSourceName">顯示名稱</label><input id="fundSourceName" name="name" maxlength="60" placeholder="例如：國樂團團費" required /></div>
      </div><div class="button-row" style="margin-top:20px"><button class="btn btn-primary" type="submit">建立經費來源</button></div></form>
    </div></div>`;
  }
  if (modal === "access") {
    const busy = ["initializing", "verifying", "authorizing-drive", "loading-drive", "saving"].includes(cloudUi.phase);
    let accountAction = "";
    if (cloudUi.connected && cloudUi.profile) {
      accountAction = `<div class="cloud-profile connected"><div><strong>${escapeHtml(cloudUi.profile.name || cloudUi.profile.email)}</strong><span>${escapeHtml(cloudUi.profile.email)}</span></div><span class="badge ready">Drive 已連接</span></div>
        <div class="notice success">已自動讀取個人 Drive 主檔；每次新增或修改仍先存本機，再自動同步至 Drive。</div>
        <div class="button-row"><button class="btn btn-primary" type="button" data-close-modal>開始使用</button><button class="btn btn-secondary" type="button" id="google-sign-out">登出</button></div>`;
    } else if (cloudUi.profile) {
      accountAction = `<div class="cloud-profile"><div><strong>${escapeHtml(cloudUi.profile.name || cloudUi.profile.email)}</strong><span>${escapeHtml(cloudUi.profile.email)}${cloudUi.profile.is_central_admin ? "・中央管理者" : "・教育帳號"}</span></div><span class="badge pending">帳號已確認</span></div>
        <button class="btn btn-primary full-button" type="button" id="authorize-drive" ${busy ? "disabled" : ""}>繼續授權資料儲存</button>
        <div class="help">只要求隱藏應用程式資料夾權限，不會讀取雲端硬碟中的其他檔案。</div>`;
    } else {
      const kind = ["denied", "error", "unavailable"].includes(cloudUi.phase) ? "danger" : "";
      accountAction = `${cloudUi.message ? `<div class="notice ${kind}">${escapeHtml(cloudUi.message)}</div>` : ""}
        <div id="google-signin-slot" class="google-signin-slot" aria-label="Google 登入按鈕"></div>
        ${cloudUi.phase === "unavailable" ? '<button class="btn btn-secondary full-button" type="button" id="retry-google">重新連接登入服務</button>' : ""}`;
    }
    return `<div class="dialog-backdrop" role="dialog" aria-modal="true"><div class="dialog access-dialog"><div class="card-header"><div><h2>Google 帳號登入</h2><p>教育網域帳號可直接使用；登入後再連接自己的 Google Drive。</p></div><button class="btn btn-secondary btn-small" data-close-modal>關閉</button></div>
      <div class="notice warning account-rule"><strong>一般使用者登入規定</strong><br />請使用縣市教育網路或學校核發的 Google Workspace 教育帳號，網域須以 <b>.edu.tw</b> 結尾。<br /><b>不接受 @gmail.com 或 @googlemail.com 個人帳號。</b><br />中央管理帳號為唯一例外，僅用於維護允許網域與規則版本。</div>
      <div class="application-flow">
        <div><span>1</span><strong>Google 登入</strong><small>伺服端確認身分</small></div>
        <div><span>2</span><strong>連接 Drive</strong><small>授權隱藏資料夾</small></div>
        <div><span>3</span><strong>自動存取</strong><small>讀取與同步主檔</small></div>
      </div>
      ${accountAction}
      <div class="admin-boundary"><strong>權限邊界</strong><span>管理權由伺服端驗證，不能修改前端取得。</span><small>伺服端只驗證帳號資格與角色，不接收各校的請假案件、名冊或費用資料。</small></div>
    </div></div>`;
  }
  if (modal === "drive-data-choice" && pendingDriveChoice) {
    const remote = pendingDriveChoice.remote;
    return `<div class="dialog-backdrop" role="dialog" aria-modal="true"><div class="dialog drive-choice-dialog"><div class="card-header"><div><h2>本機與 Google Drive 都有資料</h2><p>為避免覆蓋錯誤版本，請確認這次要使用哪一份。</p></div></div>
      <div class="drive-choice-grid">
        <button class="drive-version-choice recommended" type="button" id="use-drive-data"><span>Google Drive</span><strong>${escapeHtml(remote.schoolName || remote.state?.config?.schoolName || "未設定學校")}</strong><small>備份時間：${escapeHtml(formatDateTime(remote.exportedAt))}<br />${remote.summary?.people || 0} 人・${remote.summary?.cases || 0} 件案件</small></button>
        <button class="drive-version-choice" type="button" id="use-local-data"><span>這台電腦</span><strong>${escapeHtml(state.config.schoolName)}</strong><small>最後修改：${escapeHtml(formatDateTime(state.meta?.lastSavedAt))}<br />${state.people.length} 人・${state.cases.length} 件案件</small></button>
      </div>
      <div class="notice warning">選擇本機資料時，系統會先自動下載一份完整備份，再以本機資料更新 Drive 主檔。</div>
      <button class="btn btn-secondary full-button" type="button" id="cancel-drive-connect">稍後再連接</button>
    </div></div>`;
  }
  if (modal === "monthly-backup-reminder") {
    const month = sessionStorage.getItem("selected-month") || firstCaseMonth();
    return `<div class="dialog-backdrop" role="dialog" aria-modal="true"><div class="dialog backup-reminder-dialog"><div class="card-header"><div><h2>列印月結報表前，建議先備份</h2><p>${escapeHtml(month)} 月結報表即將列印。</p></div><button class="btn btn-secondary btn-small" data-close-modal>取消</button></div>
      <div class="notice"><strong>完整備份可用來復原系統資料</strong><br />備份包含系統設定、教師與代課教師名單、請假案件、核算結果及月結紀錄。日後若資料遺失、換電腦或需要交接，可從「系統設定 → 匯入完整備份」復原。</div>
      <div class="backup-choice-grid">
        <button class="backup-choice recommended" type="button" id="backup-and-print"><span>建議</span><strong>先下載完整備份，再列印</strong><small>下載可供系統匯入的 JSON 備份後，接著開啟列印畫面。</small></button>
        <button class="backup-choice" type="button" id="print-without-backup"><strong>只列印月結報表</strong><small>略過本次備份，直接開啟列印畫面。</small></button>
      </div>
      <div class="help">此備份與月結 CSV 不同：CSV 供查看明細；完整 JSON 備份才可匯回系統復原資料。</div>
    </div></div>`;
  }
  return "";
}

function bindCommonEvents() {
  document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.nav)));
  document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.go)));
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => { modal = null; render(); }));
  document.querySelector("#open-access")?.addEventListener("click", () => { modal = "access"; render(); });
  bindErrorReportTriggers();
}

function bindErrorReportTriggers() {
  document.querySelectorAll("[data-open-error-report]").forEach((button) => button.addEventListener("click", () => {
    modal = "error-report";
    render();
  }));
}

function navigate(page) {
  const wasEditingExisting = isEditingExistingCase();
  if (activePage === "case") syncDraftFromForm();
  if (page === "case" && (activePage !== "case" || wasEditingExisting)) draftCase = null;
  activePage = page;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindPageEvents() {
  if (activePage === "dashboard") bindDashboardEvents();
  if (activePage === "roster") bindRosterEvents();
  if (activePage === "case") bindCaseEvents();
  if (activePage === "cases") bindCasesEvents();
  if (activePage === "attendance") bindAttendanceEvents();
  if (activePage === "monthly") bindMonthlyEvents();
  if (activePage === "settings") bindSettingsEvents();
  if (modal === "person") bindPersonModal();
  if (modal === "manual-fee") bindManualFeeModal();
  if (modal === "fund-source") bindFundSourceModal();
  if (modal === "error-report") bindErrorReportModal();
  if (modal === "access") bindAccessModal();
  if (modal === "drive-data-choice") bindDriveChoiceModal();
  if (modal === "monthly-backup-reminder") bindMonthlyBackupReminder();
}

function errorReportDetails(form) {
  const data = new FormData(form);
  return {
    occurredAt: new Date().toLocaleString("zh-TW", { hour12: false }),
    environment: `${navigator.userAgent}；畫面 ${window.innerWidth}×${window.innerHeight}`,
    page: currentReportPage(),
    description: String(data.get("description") || "").trim(),
    steps: String(data.get("steps") || "").trim(),
  };
}

function bindErrorReportModal() {
  const form = document.querySelector("#error-report-form");
  const screenshotInput = document.querySelector("#reportScreenshot");
  const preview = document.querySelector("#report-file-preview");

  screenshotInput?.addEventListener("change", () => {
    const file = screenshotInput.files?.[0];
    if (!file) {
      preview.innerHTML = "<span>尚未選取截圖</span>";
      return;
    }
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
      screenshotInput.value = "";
      preview.innerHTML = "<span>請選擇 PNG、JPG 或 WebP，檔案不得超過 5 MB。</span>";
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      preview.innerHTML = `<img src="${reader.result}" alt="錯誤回報截圖預覽" /><span>${escapeHtml(file.name)}・${(file.size / 1024 / 1024).toFixed(2)} MB</span>`;
    }, { once: true });
    reader.readAsDataURL(file);
  });

  document.querySelector("#copy-error-report")?.addEventListener("click", async () => {
    if (!form?.reportValidity()) return;
    const reportText = buildErrorReportText(errorReportDetails(form));
    try {
      await navigator.clipboard.writeText(`${reportText}\n\n開發者：${SUPPORT_EMAIL}`);
      showToast("錯誤回報文字已複製");
    } catch {
      showToast("無法自動複製，請改用傳送給開發者");
    }
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const details = errorReportDetails(form);
    const reportText = buildErrorReportText(details);
    const screenshot = screenshotInput?.files?.[0];
    const sharePayload = screenshot ? {
      title: `${APP_NAME}錯誤回報 v${APP_VERSION}`,
      text: `請傳送給開發者 ${SUPPORT_EMAIL}\n\n${reportText}`,
      files: [screenshot],
    } : null;

    if (sharePayload && typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: sharePayload.files })) {
      try {
        await navigator.share(sharePayload);
        modal = null;
        render();
        showToast("已開啟分享畫面，請確認傳送對象");
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }

    const mailLink = document.createElement("a");
    mailLink.href = buildSupportMailto(details);
    mailLink.hidden = true;
    document.body.append(mailLink);
    mailLink.click();
    mailLink.remove();
    showToast(screenshot ? "郵件已開啟，請附加剛才選取的截圖" : "錯誤回報郵件已開啟");
  });
}

function bindAccessModal() {
  document.querySelector("#authorize-drive")?.addEventListener("click", () => googleCloud.requestDriveAccess());
  document.querySelector("#google-sign-out")?.addEventListener("click", () => {
    googleCloud.signOut();
    state.meta.storageMode = "local";
    localStorageAdapter.save(state);
    modal = null;
    render();
  });
  document.querySelector("#retry-google")?.addEventListener("click", () => googleCloud.initialize());
}

function chooseDriveData(details) {
  return new Promise((resolve) => {
    pendingDriveChoice = { ...details, resolve };
    modal = "drive-data-choice";
    render();
  });
}

function bindDriveChoiceModal() {
  const finish = (choice) => {
    const resolve = pendingDriveChoice?.resolve;
    pendingDriveChoice = null;
    modal = "access";
    render();
    resolve?.(choice);
  };
  document.querySelector("#use-drive-data")?.addEventListener("click", () => finish("remote"));
  document.querySelector("#use-local-data")?.addEventListener("click", () => {
    exportFullBackup();
    finish("local");
  });
  document.querySelector("#cancel-drive-connect")?.addEventListener("click", () => finish("cancel"));
}

function bindDashboardEvents() {
  document.querySelector("#load-demo")?.addEventListener("click", loadDemo);
  document.querySelectorAll("[data-edit-case]").forEach((button) => button.addEventListener("click", () => openCase(button.dataset.editCase)));
}

function loadDemo() {
  if (state.cases.length && !confirm("載入示範資料會取代目前本機資料，是否繼續？")) return;
  state = demoState();
  saveState("load-demo", "system");
  draftCase = null;
  showToast("已載入示範資料");
  render();
}

function bindRosterEvents() {
  document.querySelector("#roster-substitute-filter")?.addEventListener("change", (event) => {
    sessionStorage.setItem("roster-substitute-filter", event.target.value);
    render();
  });
  document.querySelectorAll("[data-substitute-status]").forEach((select) => select.addEventListener("change", () => {
    const person = personById(select.dataset.substituteStatus);
    if (!person) return;
    person.canSubstitute = select.value === "available";
    saveState("update-substitute-status", person.id);
    render();
    showToast(`${person.name}已設為${person.canSubstitute ? "可代課" : "暫不排代"}`);
  }));
  document.querySelectorAll("[data-open-person]").forEach((button) => button.addEventListener("click", () => {
    personModalType = button.dataset.openPerson;
    modal = "person";
    render();
  }));
  document.querySelectorAll("[data-import-roster]").forEach((input) => input.addEventListener("change", () => handleRosterImport(input)));
  document.querySelectorAll("[data-download-template]").forEach((button) => button.addEventListener("click", () => downloadRosterTemplate(button.dataset.downloadTemplate)));
  document.querySelectorAll("[data-delete-person]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.deletePerson;
    const inUse = state.cases.some((item) => item.teacherId === id || item.homeroomProxyId === id || item.affectedPeriods?.some((period) => period.substituteId === id));
    if (inUse) return showToast("此人員已有案件引用，不能直接刪除");
    if (!confirm(`確定刪除 ${personName(id)}？`)) return;
    state.people = state.people.filter((person) => person.id !== id);
    saveState("delete-person", id);
    render();
  }));
}

async function handleRosterImport(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const result = parseRosterText(await file.text(), input.dataset.importRoster, state.people);
    const imported = result.people.map((person) => ({ ...person, id: newId("P") }));
    state.people.push(...imported);
    if (imported.length) saveState("import-roster", input.dataset.importRoster);
    const details = [
      `成功匯入 ${imported.length} 人`,
      result.skipped.length ? `略過重複 ${result.skipped.length} 人` : "",
      result.errors.length ? `格式錯誤 ${result.errors.length} 列` : "",
    ].filter(Boolean).join("；");
    render();
    showToast(details);
  } catch (error) {
    console.error(error);
    showToast("名冊匯入失敗，請確認檔案為 UTF-8 CSV 或 TSV");
  } finally {
    input.value = "";
  }
}

function downloadRosterTemplate(personType) {
  const blob = new Blob([rosterTemplate(personType)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = personType === "staff" ? "校內教師名冊_匯入範本.csv" : "短代老師名冊_匯入範本.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function bindPersonModal() {
  document.querySelector("#person-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const personType = event.currentTarget.dataset.personType;
    const code = form.get("code").trim();
    const name = form.get("name").trim();
    const duplicate = state.people.some((person) => {
      const sameType = personType === "staff" ? person.personType === "staff" : isShortSub(person);
      if (!sameType) return false;
      if (code && person.code) return person.code.trim().toLowerCase() === code.toLowerCase();
      return person.name.trim().toLowerCase() === name.toLowerCase();
    });
    if (duplicate) return showToast("同一名冊已有相同編號或姓名，未重複新增");
    state.people.push({
      id: newId("P"),
      code,
      name,
      personType,
      roles: personType === "staff" ? form.getAll("roles") : [],
      className: personType === "staff" ? (form.get("className") || "").trim() : "",
      subjects: form.get("subjects").trim(),
      canSubstitute: personType === "staff" ? form.get("canSubstitute") === "on" : true,
      active: true,
    });
    saveState("create-person", state.people.at(-1).id);
    modal = null;
    render();
    showToast("人員已建立");
  });
}

function syncDraftFromForm() {
  const form = document.querySelector("#case-form");
  if (!form || !draftCase) return;
  const data = new FormData(form);
  const fields = ["teacherId", "leaveType", "officialReason", "startDate", "endDate", "startTime", "endTime", "startPart", "endPart", "homeroomProxyId", "homeroomStartDate", "homeroomEndDate", "homeroomStartPart", "homeroomEndPart"];
  fields.forEach((field) => { draftCase[field] = data.get(field) || ""; });
  ["leaveHours", "accumulatedHoursBefore", "consecutiveSickDays", "businessTripDays"].forEach((field) => { draftCase[field] = Number(data.get(field) || 0); });
  const leaveTeacherIsHomeroom = personById(draftCase.teacherId)?.roles?.includes("homeroom") === true;
  draftCase.hasHomeroomDuty = leaveTeacherIsHomeroom && data.get("hasHomeroomDuty") === "on";
  if (!draftCase.hasHomeroomDuty) {
    draftCase.homeroomProxyId = "";
    draftCase.homeroomStartDate = "";
    draftCase.homeroomEndDate = "";
    draftCase.homeroomStartPart = "";
    draftCase.homeroomEndPart = "";
  }
  draftCase.affectedPeriods = [...document.querySelectorAll("[data-period-row]")].map((row) => {
    const get = (key) => row.querySelector(`[data-key="${key}"]`);
    return {
      id: row.dataset.periodRow,
      date: get("date").value,
      periodNo: Number(get("periodNo").value || 0),
      className: get("className").value.trim(),
      subject: get("subject").value.trim(),
      handling: get("handling").value,
      substituteId: get("substituteId").value,
      fundSourceId: get("fundSourceId").value,
      thresholdZone: get("thresholdZone").value,
      isOvertime: get("isOvertime").checked,
    };
  });
  syncAllocationsFromDom();
}

function syncAllocationsFromDom() {
  if (!draftCase?.calculation) return;
  for (const box of document.querySelectorAll("[data-allocation-box]")) {
    const feeId = box.dataset.allocationBox;
    const rows = [...box.querySelectorAll("[data-allocation-row]")].map((row) => ({
      id: row.dataset.allocationRow,
      sourceId: row.querySelector('[data-allocation-key="sourceId"]').value,
      note: row.querySelector('[data-allocation-key="note"]')?.value.trim() || "",
      amount: Number(row.querySelector('[data-allocation-key="amount"]').value || 0),
      method: "amount",
    }));
    const target = draftCase.allocations.find((item) => item.feeId === feeId);
    if (target) target.rows = rows;
    else draftCase.allocations.push({ feeId, rows });
  }
}

function bindCaseEvents() {
  ["leaveType", "hasHomeroomDuty", "teacherId"].forEach((id) => document.querySelector(`#${id}`)?.addEventListener("change", () => { syncDraftFromForm(); render(); }));
  document.querySelector("#add-period")?.addEventListener("click", () => {
    syncDraftFromForm();
    draftCase.affectedPeriods.push({ id: newId("AP"), date: draftCase.startDate, periodNo: draftCase.affectedPeriods.length + 1, className: personById(draftCase.teacherId)?.className || "", subject: "", handling: "internal_sub", substituteId: "", fundSourceId: "", thresholdZone: "", isOvertime: false });
    draftCase.calculation = null;
    render();
  });
  document.querySelectorAll("[data-delete-period]").forEach((button) => button.addEventListener("click", () => {
    syncDraftFromForm();
    draftCase.affectedPeriods = draftCase.affectedPeriods.filter((period) => period.id !== button.dataset.deletePeriod);
    draftCase.calculation = null;
    render();
  }));
  document.querySelector("#save-draft")?.addEventListener("click", () => saveDraft(false));
  document.querySelector("#calculate-case")?.addEventListener("click", calculateDraft);
  document.querySelector("#open-manual-fee")?.addEventListener("click", () => { syncDraftFromForm(); modal = "manual-fee"; render(); });
  document.querySelectorAll("[data-add-allocation]").forEach((button) => button.addEventListener("click", () => {
    syncDraftFromForm();
    const feeId = button.dataset.addAllocation;
    let target = draftCase.allocations.find((item) => item.feeId === feeId);
    if (!target) { target = { feeId, rows: [] }; draftCase.allocations.push(target); }
    target.rows.push({ id: newId("AL"), sourceId: defaultPublicFundSource()?.id || "", note: "", amount: 0, method: "amount" });
    render();
  }));
  document.querySelectorAll("[data-delete-allocation]").forEach((button) => button.addEventListener("click", () => {
    syncDraftFromForm();
    const [feeId, rowId] = button.dataset.deleteAllocation.split("|");
    const target = draftCase.allocations.find((item) => item.feeId === feeId);
    if (target) target.rows = target.rows.filter((row) => row.id !== rowId);
    render();
  }));
  document.querySelectorAll("[data-allocation-key]").forEach((input) => input.addEventListener("change", () => { syncDraftFromForm(); persistDraftInState(); render(); }));
  document.querySelector("#mark-ready")?.addEventListener("click", markReady);
}

function validateDraft() {
  const errors = [];
  if (!draftCase.teacherId) errors.push("請選擇請假教師。 ");
  if (!draftCase.startDate || !draftCase.endDate) errors.push("請填寫請假起訖日期。 ");
  if (!draftCase.startTime || !draftCase.endTime) errors.push("請填寫請假起訖時間。 ");
  if (draftCase.startDate && draftCase.endDate && draftCase.startTime && draftCase.endTime) {
    const startAt = new Date(`${draftCase.startDate}T${draftCase.startTime}`);
    const endAt = new Date(`${draftCase.endDate}T${draftCase.endTime}`);
    if (endAt <= startAt) errors.push("請假結束時間必須晚於開始時間。 ");
  }
  if (!draftCase.affectedPeriods.length) errors.push("請至少新增一個受影響節次。 ");
  const missingClassPeriod = draftCase.affectedPeriods.find((period) => isSignInSheetPeriod(period) && !period.className.trim());
  if (missingClassPeriod) errors.push(`第 ${missingClassPeriod.periodNo} 節已安排代課教師，請填寫班級。 `);
  if (draftCase.leaveType === "official" && !draftCase.officialReason) errors.push("公假必須選擇事由分類。 ");
  if (draftCase.hasHomeroomDuty && !personById(draftCase.teacherId)?.roles?.includes("homeroom")) errors.push("只有導師請假案件可以勾選導師職務代理。 ");
  if (draftCase.hasHomeroomDuty && !draftCase.homeroomProxyId) errors.push("已勾選導師職務代理，請指定代理人。 ");
  return errors;
}

function persistDraftInState() {
  draftCase.updatedAt = new Date().toISOString();
  const index = state.cases.findIndex((item) => item.id === draftCase.id);
  if (index >= 0) state.cases[index] = structuredClone(draftCase);
  else state.cases.push(structuredClone(draftCase));
  saveState("save-case", draftCase.id);
}

function ensureDraftCaseNumber() {
  if (!draftCase || state.cases.some((item) => item.id === draftCase.id) || isReadableCaseNumber(draftCase.id)) return;
  draftCase.id = nextCaseNumber(state.cases, state.config, draftCase.startDate);
}

function saveDraft(navigateAfter = true) {
  syncDraftFromForm();
  const errors = validateDraft();
  if (errors.length) return showToast(errors[0]);
  ensureDraftCaseNumber();
  persistDraftInState();
  showToast("案件草稿已儲存");
  if (navigateAfter) { activePage = "cases"; draftCase = null; render(); }
}

function calculateDraft() {
  syncDraftFromForm();
  const errors = validateDraft();
  if (errors.length) return showToast(errors[0]);
  ensureDraftCaseNumber();
  const result = calculateCase(draftCase, state.config);
  draftCase.calculation = result;
  draftCase.allocations = result.allocations;
  for (const fee of result.feeItems.filter((item) => item.burden === BURDEN.PUBLIC)) {
    let target = draftCase.allocations.find((item) => item.feeId === fee.id);
    if (!target) { target = { feeId: fee.id, rows: [] }; draftCase.allocations.push(target); }
    const source = defaultPublicFundSource(fee.preferredFundSourceId);
    if (!target.rows.length && source) target.rows.push({ id: newId("AL"), sourceId: source.id, note: "", amount: fee.amount, method: "amount" });
  }
  draftCase.status = "calculated";
  persistDraftInState();
  render();
  document.querySelector("#calculation-results")?.scrollIntoView({ behavior: "smooth" });
  showToast(result.errors.length ? "試算完成，但仍有待處理項目" : "試算完成");
}

function markReady() {
  syncDraftFromForm();
  if (draftCase.calculation.errors.length) return showToast("仍有規則或排代錯誤，尚不能標記可月結");
  for (const fee of draftCase.calculation.feeItems.filter((item) => item.burden === BURDEN.PUBLIC)) {
    if (allocationBalance(fee, allocationRowsFor(draftCase, fee.id)) !== 0) return showToast(`「${fee.ruleTitle}」的公費分攤尚未平衡`);
  }
  draftCase.status = "ready";
  persistDraftInState();
  render();
  showToast("案件已標記為可月結");
}

function bindManualFeeModal() {
  document.querySelector("#manual-fee-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const quantity = Number(data.get("quantity") || 0);
    const unitRate = Number(data.get("unitRate") || 0);
    const reasonCode = data.get("reasonCode");
    const documentRef = data.get("documentRef").trim();
    if (!quantity || !unitRate || !reasonCode || !documentRef) return showToast("請完整填寫人工認定欄位");
    draftCase.manualFees.push({
      id: newId("F-MANUAL"),
      type: "homeroom_hourly_manual",
      payeeId: draftCase.homeroomProxyId,
      quantity,
      unitRate,
      amount: roundMoney(quantity * unitRate, "keep2"),
      burden: BURDEN.PUBLIC,
      ruleId: "R26-MANUAL",
      ruleTitle: `代理導師鐘點費（${reasonCode}）`,
      source: documentRef,
      reasonCode,
      documentRef,
      manual: true,
    });
    modal = null;
    calculateDraft();
  });
}

function bindCasesEvents() {
  document.querySelectorAll("[data-edit-case]").forEach((button) => button.addEventListener("click", () => openCase(button.dataset.editCase)));
  document.querySelectorAll("[data-delete-case]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.deleteCase;
    const target = state.cases.find((item) => item.id === id);
    if (target?.status === "closed") return showToast("已月結案件不能直接刪除，應建立更正紀錄");
    if (!confirm(`確定刪除案件 ${id}？`)) return;
    state.cases = state.cases.filter((item) => item.id !== id);
    saveState("delete-case", id);
    render();
  }));
}

function openCase(id) {
  draftCase = structuredClone(state.cases.find((item) => item.id === id));
  activePage = "case";
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindAttendanceEvents() {
  document.querySelector("#attendance-date")?.addEventListener("change", (event) => {
    sessionStorage.setItem("selected-attendance-date", event.target.value);
    sessionStorage.setItem("selected-attendance-teacher", "all");
    sessionStorage.setItem("attendance-preview", "closed");
    render();
  });
  document.querySelector("#attendance-teacher")?.addEventListener("change", (event) => {
    sessionStorage.setItem("selected-attendance-teacher", event.target.value);
    sessionStorage.setItem("attendance-preview", "closed");
    render();
  });
  document.querySelector("#toggle-attendance-preview")?.addEventListener("click", () => {
    const previewOpen = sessionStorage.getItem("attendance-preview") === "open";
    sessionStorage.setItem("attendance-preview", previewOpen ? "closed" : "open");
    render();
  });
  document.querySelectorAll("[data-open-attendance-case]").forEach((button) => button.addEventListener("click", () => openCase(button.dataset.openAttendanceCase)));
  document.querySelector("#print-attendance")?.addEventListener("click", () => window.print());
}

function bindMonthlyEvents() {
  document.querySelector("#month-picker")?.addEventListener("change", (event) => {
    sessionStorage.setItem("selected-month", event.target.value);
    render();
  });
  document.querySelector("#print-monthly")?.addEventListener("click", printMonthly);
  document.querySelector("#export-monthly")?.addEventListener("click", exportMonthlyCsv);
}

function printMonthly() {
  modal = "monthly-backup-reminder";
  render();
}

function bindMonthlyBackupReminder() {
  const continueToPrint = (downloadBackup) => {
    if (downloadBackup) exportFullBackup();
    modal = null;
    render();
    window.setTimeout(() => window.print(), 180);
  };
  document.querySelector("#backup-and-print")?.addEventListener("click", () => continueToPrint(true));
  document.querySelector("#print-without-backup")?.addEventListener("click", () => continueToPrint(false));
}

function exportMonthlyCsv() {
  const month = document.querySelector("#month-picker")?.value || firstCaseMonth();
  const data = collectMonth(month);
  const rows = buildMonthlyExportRows(data.relevantCases, month, state.people, state.fundSources);
  if (!rows.length) return showToast("本月尚無可匯出的費用明細");

  const blob = new Blob([monthlyRowsToCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `代課費明細_${month}.csv`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`已匯出 ${month} 費用明細`);
}

function exportFullBackup() {
  const backup = createBackup(state);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupFilename(state);
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("完整備份已下載；需要時可在系統設定匯入復原");
}

async function importFullBackup(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const result = parseBackup(await file.text());
    if (!result.ok) return showToast(result.error);
    const { payload } = result;
    const exportedAt = new Date(payload.exportedAt);
    const exportedText = Number.isNaN(exportedAt.getTime()) ? "未知" : exportedAt.toLocaleString("zh-TW", { hour12: false });
    const summary = payload.summary || {};
    const message = [
      `學校：${payload.schoolName || payload.state.config.schoolName || "未設定"}`,
      `匯出時間：${exportedText}`,
      `名冊：${summary.people ?? payload.state.people.length} 人`,
      `案件：${summary.cases ?? payload.state.cases.length} 件`,
      "",
      "匯入後將取代目前資料，是否繼續？",
    ].join("\n");
    if (!confirm(message)) return;
    localStorageAdapter.save(payload.state);
    state = localStorageAdapter.load();
    saveState("import-backup", "system");
    draftCase = null;
    activePage = "dashboard";
    render();
    showToast("完整備份已匯入並自動儲存");
  } catch (error) {
    console.error("備份匯入失敗", error);
    showToast("備份匯入失敗，原有資料未變更");
  } finally {
    input.value = "";
  }
}

function bindSettingsEvents() {
  document.querySelector("#settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.config = {
      ...state.config,
      schoolName: data.get("schoolName").trim(),
      academicYear: data.get("academicYear").trim(),
      term: data.get("term"),
      hourlyRate: Number(data.get("hourlyRate") || 0),
      homeroomMonthly: Number(data.get("homeroomMonthly") || 0),
      roundingMode: data.get("roundingMode"),
    };
    saveState("update-settings", "config");
    render();
    showToast("設定已儲存；既有案件請重新試算");
  });
  document.querySelector("#load-demo-settings")?.addEventListener("click", loadDemo);
  document.querySelector("#export-backup")?.addEventListener("click", exportFullBackup);
  document.querySelector("#import-backup")?.addEventListener("change", (event) => importFullBackup(event.currentTarget));
  document.querySelector("#open-access-settings")?.addEventListener("click", () => { modal = "access"; render(); });
  document.querySelector("#subject-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const subject = new FormData(event.currentTarget).get("subject").trim();
    if (!subject) return showToast("請填寫科目名稱");
    if (state.subjects.some((item) => item.toLowerCase() === subject.toLowerCase())) return showToast("科目清單已有相同名稱");
    state.subjects.push(subject);
    saveState("create-subject", subject);
    render();
    showToast("科目已新增");
  });
  document.querySelectorAll("[data-delete-subject]").forEach((button) => button.addEventListener("click", () => {
    const subject = button.dataset.deleteSubject;
    const inUse = state.cases.some((item) => item.affectedPeriods?.some((period) => period.subject === subject));
    if (inUse) return showToast("此科目已有案件使用，不能直接移除");
    state.subjects = state.subjects.filter((item) => item !== subject);
    saveState("delete-subject", subject);
    render();
  }));
  document.querySelector("#open-fund-source")?.addEventListener("click", () => {
    modal = "fund-source";
    render();
  });
  document.querySelectorAll("[data-fund-source-status]").forEach((select) => select.addEventListener("change", () => {
    const source = state.fundSources.find((item) => item.id === select.dataset.fundSourceStatus);
    if (!source) return;
    source.active = select.value === "active";
    saveState("update-fund-source-status", source.id);
    render();
    showToast(`${source.name}已${source.active ? "啟用" : "停用"}`);
  }));
  document.querySelectorAll("[data-delete-fund-source]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.deleteFundSource;
    const source = state.fundSources.find((item) => item.id === id);
    if (!source) return;
    const inUse = state.cases.some((item) => item.affectedPeriods?.some((period) => period.fundSourceId === id)
      || item.allocations?.some((allocation) => allocation.rows?.some((row) => row.sourceId === id)));
    if (inUse) return showToast("此經費來源已有案件引用，請改為停用");
    if (!confirm(`確定移除經費來源「${source.name}」？`)) return;
    state.fundSources = state.fundSources.filter((item) => item.id !== id);
    saveState("delete-fund-source", id);
    render();
  }));
  document.querySelector("#clear-data")?.addEventListener("click", () => {
    const confirmation = prompt("這會清空目前瀏覽器內的全部資料。建議先匯出完整備份。\n\n若確定繼續，請輸入「清空」。");
    if (confirmation !== "清空") return showToast("已取消清空資料");
    state = emptyState();
    localStorageAdapter.reset();
    localStorageAdapter.save(state);
    draftCase = null;
    render();
    showToast("全部本機資料已清空");
  });
}

function bindFundSourceModal() {
  document.querySelector("#fund-source-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const burdenType = data.get("burdenType");
    const name = data.get("name").trim();
    if (!name) return showToast("請填寫經費來源名稱");
    if (state.fundSources.some((source) => source.name.trim().toLowerCase() === name.toLowerCase())) return showToast("已有相同名稱的經費來源");
    const source = {
      id: newId("FS"),
      category: "custom",
      burdenType: ["public", "self", "other"].includes(burdenType) ? burdenType : "other",
      name,
      active: true,
      custom: true,
    };
    state.fundSources.push(source);
    saveState("create-fund-source", source.id);
    modal = null;
    render();
    showToast("經費來源已建立");
  });
}

render();
googleCloud.initialize();
