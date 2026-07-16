export const APP_VERSION = "0.3.5";
export const SUPPORT_EMAIL = "chihhung1988@gmail.com";
export const COPYRIGHT_NOTICE = "© 2026 課務核算台。版權所有。";
export const DRIVE_CONNECTION_REASON = "本系統不設中央個案資料庫。連接後，名冊、請假案件、核算結果與系統設定會存入此帳號專用的 Google Drive 隱藏應用程式資料空間，用於自動儲存、下次開啟自動讀取，以及換電腦後繼續使用。";

export function buildSupportMailto() {
  const subject = `【課務核算台】錯誤回報 v${APP_VERSION}`;
  const body = [
    "請勿填入身分證、金融帳號、教師請假原因或其他敏感資料。",
    "",
    "發生時間：",
    "使用裝置／瀏覽器：",
    "所在功能：",
    "操作步驟：",
    "畫面顯示的錯誤：",
    "是否可以重現：",
    "",
    "可附上不含個資的畫面截圖。",
  ].join("\n");
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
