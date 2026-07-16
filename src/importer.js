const HEADER_ALIASES = {
  code: ["校內代碼", "自編編號", "人員編號", "編號", "code", "id"],
  name: ["姓名", "教師姓名", "name"],
  roles: ["任務身分", "身分", "職務", "roles", "role"],
  className: ["導師班級", "班級", "class", "classname"],
  subjects: ["領域科目", "領域／科目", "領域/科目", "科目", "subjects", "subject"],
  canSubstitute: ["可代課", "列入可代課", "cansubstitute", "substitute"],
};

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/[\s_\-]/g, "")
    .toLowerCase();
}

function findHeaderIndex(headers, key) {
  const aliases = HEADER_ALIASES[key].map(normalizeHeader);
  return headers.findIndex((header) => aliases.includes(normalizeHeader(header)));
}

function detectDelimiter(text) {
  const firstLine = String(text || "").split(/\r?\n/).find((line) => line.trim()) || "";
  return (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
}

export function parseDelimited(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      row.push(field.trim());
      field = "";
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  row.push(field.trim());
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

function parseRoles(value) {
  const parts = String(value || "").split(/[、,;；/|]+/).map((part) => part.trim().toLowerCase());
  const roles = [];
  if (parts.some((part) => part === "導師" || part === "homeroom")) roles.push("homeroom");
  if (parts.some((part) => part === "科任" || part === "subject")) roles.push("subject");
  if (parts.some((part) => part.includes("行政") || part === "admin")) roles.push("admin");
  return roles;
}

function parseBoolean(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["是", "可", "有", "true", "yes", "y", "1", "v", "✓"].includes(normalized);
}

export function parseRosterText(text, personType, existingPeople = []) {
  const rows = parseDelimited(text);
  if (!rows.length) return { people: [], skipped: [], errors: ["檔案沒有資料。"] };
  const headers = rows[0];
  const indexes = Object.fromEntries(Object.keys(HEADER_ALIASES).map((key) => [key, findHeaderIndex(headers, key)]));
  if (indexes.name < 0) return { people: [], skipped: [], errors: ["找不到必要欄位「姓名」。請先下載匯入範本。"] };

  const people = [];
  const skipped = [];
  const errors = [];
  const normalizedType = personType === "staff" ? "staff" : "short_sub";
  const candidates = [...existingPeople];

  rows.slice(1).forEach((row, offset) => {
    const rowNo = offset + 2;
    const get = (key) => indexes[key] >= 0 ? String(row[indexes[key]] || "").trim() : "";
    const name = get("name");
    const code = get("code");
    if (!name) {
      errors.push(`第 ${rowNo} 列缺少姓名。`);
      return;
    }
    const duplicate = candidates.find((person) => {
      const sameType = person.personType === normalizedType || (normalizedType === "short_sub" && person.personType === "external");
      if (!sameType) return false;
      if (code && person.code) return person.code.trim().toLowerCase() === code.toLowerCase();
      return person.name.trim().toLowerCase() === name.toLowerCase();
    });
    if (duplicate) {
      skipped.push(`第 ${rowNo} 列「${name}」與既有名冊重複。`);
      return;
    }

    const person = {
      code,
      name,
      personType: normalizedType,
      roles: normalizedType === "staff" ? parseRoles(get("roles")) : [],
      className: normalizedType === "staff" ? get("className") : "",
      subjects: get("subjects"),
      canSubstitute: normalizedType === "staff" ? parseBoolean(get("canSubstitute"), false) : true,
      active: true,
    };
    people.push(person);
    candidates.push(person);
  });

  return { people, skipped, errors };
}

export function rosterTemplate(personType) {
  if (personType === "staff") {
    return "\uFEFF校內代碼,姓名,任務身分,導師班級,領域科目,可代課\r\nT001,王老師,導師,五年一班,國語／數學,否\r\nT002,陳老師,科任,,自然,是\r\n";
  }
  return "\uFEFF自編編號,姓名,領域科目\r\nS001,林老師,國語／數學\r\n";
}
