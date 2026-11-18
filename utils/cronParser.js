/**
 * cronParser.js — 纯 JS 零依赖标准 5 段 Cron 解析与下次触发计算
 *
 * 格式: 分钟(0-59) 小时(0-23) 日(1-31) 月(1-12) 星期(0-7, 0和7均为周日)
 * 支持: *、*\/n、a-b、a-b/n、逗号列表、英文月份(jan..dec)与星期(sun..sat)别名
 */

const MONTH_ALIASES = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_ALIASES = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const CRON_PRESETS = [
  { id: "every_15m", label: "每 15 分钟", expr: "*/15 * * * *" },
  { id: "hourly", label: "每小时整点", expr: "0 * * * *" },
  { id: "daily_9", label: "每天 09:00", expr: "0 9 * * *" },
  { id: "daily_18", label: "每天 18:00", expr: "0 18 * * *" },
  { id: "weekday_9", label: "工作日 09:00", expr: "0 9 * * 1-5" },
  { id: "monday_9", label: "每周一 09:00", expr: "0 9 * * 1" },
];

function normalizeFieldToken(token, aliases = null) {
  const clean = String(token || "").trim().toLowerCase();
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, clean)) {
    return String(aliases[clean]);
  }
  return clean;
}

function parseCronField(rawField, min, max, { aliases = null, mapValue = null } = {}) {
  const field = String(rawField || "").trim();
  if (!field) {
    throw new Error("Cron 字段不能为空");
  }

  const values = new Set();
  const isWildcard = field === "*";
  const parts = field.split(",");

  for (const part of parts) {
    const seg = part.trim();
    if (!seg) throw new Error(`无效的 Cron 片段: "${field}"`);

    const stepSplit = seg.split("/");
    if (stepSplit.length > 2) {
      throw new Error(`无效的步长语法: "${seg}"`);
    }

    const rangePart = stepSplit[0].trim();
    const step = stepSplit.length === 2 ? Number(stepSplit[1].trim()) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`步长必须是正整数: "${seg}"`);
    }

    let start = min;
    let end = max;

    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const bounds = rangePart.split("-");
      if (bounds.length !== 2) {
        throw new Error(`无效的范围表达: "${seg}"`);
      }
      const left = Number(normalizeFieldToken(bounds[0], aliases));
      const right = Number(normalizeFieldToken(bounds[1], aliases));
      if (!Number.isInteger(left) || !Number.isInteger(right)) {
        throw new Error(`无法解析范围值: "${seg}"`);
      }
      if (left < min || right > max || left > right) {
        throw new Error(`范围超出允许区间 [${min}, ${max}]: "${seg}"`);
      }
      start = left;
      end = right;
    } else {
      const single = Number(normalizeFieldToken(rangePart, aliases));
      if (!Number.isInteger(single) || single < min || single > max) {
        throw new Error(`数值超出允许区间 [${min}, ${max}]: "${seg}"`);
      }
      start = single;
      end = stepSplit.length === 2 ? max : single;
    }

    for (let v = start; v <= end; v += step) {
      const mapped = mapValue ? mapValue(v) : v;
      values.add(mapped);
    }
  }

  if (values.size === 0) {
    throw new Error(`Cron 字段未匹配任何有效值: "${field}"`);
  }

  return {
    isWildcard,
    values,
    sorted: Array.from(values).sort((a, b) => a - b),
  };
}

function parseCronExpression(expr) {
  const trimmed = String(expr || "").trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw new Error("Cron 表达式不能为空");
  }
  const fields = trimmed.split(" ");
  if (fields.length !== 5) {
    throw new Error("Cron 表达式必须包含 5 段：分 时 日 月 星期（例如: 0 9 * * 1-5）");
  }

  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12, { aliases: MONTH_ALIASES });
  const dow = parseCronField(fields[4], 0, 7, {
    aliases: DOW_ALIASES,
    mapValue: (v) => (v === 7 ? 0 : v),
  });

  return {
    expr: trimmed,
    minute,
    hour,
    dom,
    month,
    dow,
  };
}

function validateCronExpression(expr) {
  try {
    const parsed = parseCronExpression(expr);
    return { valid: true, parsed };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function matchesDay(parsed, date) {
  const day = date.getDate();
  const weekday = date.getDay();
  const domOk = parsed.dom.values.has(day);
  const dowOk = parsed.dow.values.has(weekday);
  // 标准 Cron 语义：日和星期都非通配符时取并集 (OR)，否则取交集
  if (!parsed.dom.isWildcard && !parsed.dow.isWildcard) {
    return domOk || dowOk;
  }
  return domOk && dowOk;
}

function getNextCronRun(expr, fromMs = Date.now()) {
  const parsed = typeof expr === "string" ? parseCronExpression(expr) : expr;
  const base = Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now();
  // 从下一整分钟开始查找
  const cursor = new Date(base);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const maxYear = cursor.getFullYear() + 4;
  let guard = 0;

  while (cursor.getFullYear() <= maxYear && guard < 20000) {
    guard += 1;
    const month = cursor.getMonth() + 1;
    if (!parsed.month.values.has(month)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    if (!matchesDay(parsed, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = cursor.getHours();
    if (!parsed.hour.values.has(hour)) {
      const nextHour = parsed.hour.sorted.find((h) => h > hour);
      if (nextHour === undefined) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
      } else {
        cursor.setHours(nextHour, 0, 0, 0);
      }
      continue;
    }

    const minute = cursor.getMinutes();
    if (!parsed.minute.values.has(minute)) {
      const nextMin = parsed.minute.sorted.find((m) => m > minute);
      if (nextMin === undefined) {
        cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      } else {
        cursor.setMinutes(nextMin, 0, 0);
      }
      continue;
    }

    return cursor.getTime();
  }

  return null;
}

function describeSchedule(rule = {}) {
  const type = String(rule.schedule_type || rule.scheduleType || "interval");
  if (type === "manual") return "仅手动 / Webhook 触发";
  if (type === "cron") {
    const expr = String(rule.cron_expr || rule.cronExpr || "").trim();
    const preset = CRON_PRESETS.find((p) => p.expr === expr);
    return preset ? `${preset.label} (${expr})` : `Cron: ${expr || "-"}`;
  }
  const mins = Math.max(1, Number(rule.interval_minutes ?? rule.intervalMinutes ?? 60) || 60);
  if (mins >= 1440 && mins % 1440 === 0) {
    return `每 ${mins / 1440} 天`;
  }
  if (mins >= 60 && mins % 60 === 0) {
    return `每 ${mins / 60} 小时`;
  }
  return `每 ${mins} 分钟`;
}

function computeNextRunAt(rule = {}, fromMs = Date.now()) {
  if (rule.enabled === false || rule.enabled === 0) return null;
  const type = String(rule.schedule_type || rule.scheduleType || "interval");
  if (type === "manual") return null;
  if (type === "cron") {
    const expr = String(rule.cron_expr || rule.cronExpr || "").trim();
    if (!expr) return null;
    try {
      return getNextCronRun(expr, fromMs);
    } catch {
      return null;
    }
  }
  const mins = Math.max(1, Number(rule.interval_minutes ?? rule.intervalMinutes ?? 60) || 60);
  return (Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now()) + mins * 60 * 1000;
}

module.exports = {
  CRON_PRESETS,
  parseCronExpression,
  validateCronExpression,
  getNextCronRun,
  computeNextRunAt,
  describeSchedule,
};
