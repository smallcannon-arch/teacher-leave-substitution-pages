function pad(value) {
  return String(value).padStart(2, "0");
}

export function localIsoDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localIsoMonth(date = new Date()) {
  return localIsoDate(date).slice(0, 7);
}
