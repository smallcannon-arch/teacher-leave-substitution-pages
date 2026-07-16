export const APP_VERSION = "0.3.2";
export const SUPPORT_EMAIL = "chihhung1988@gmail.com";
export const COPYRIGHT_NOTICE = "© 2026 課務核算台。版權所有。";

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
