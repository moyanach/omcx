/**
 * 系统字体枚举服务
 *
 * 扫描 macOS 标准字体目录，直接解析 TTF / OTF / TTC 字体的 name 表，
 * 拿到真实可用的字体家族名，供设置页「字体设置」下拉选择。
 * 采用按需读取（文件描述符 + 偏移）方式，大体积字体（如 78MB 的 PingFang.ttc）
 * 也不会被整体载入内存。不依赖任何原生模块或外部命令，结果带内存缓存。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const FONT_DIRS = [
  { dir: "/System/Library/Fonts", depth: 3 },
  { dir: "/System/Library/Fonts/Supplemental", depth: 3 },
  { dir: "/Library/Fonts", depth: 3 },
  { dir: path.join(os.homedir(), "Library/Fonts"), depth: 3 },
  { dir: "/Network/Library/Fonts", depth: 3 },
  // 新版 macOS 将部分系统字体（如 PingFang、语言补充字体）存放在按需下载资源目录
  { dir: "/System/Library/AssetsV2", depth: 6 },
];

const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".otc"]);
const MAX_FILES_PER_DIR = 4000;
const CACHE_TTL_MS = 10 * 60 * 1000;

let cache = null;
let cacheAt = 0;

function parseFamilies(readAt, size) {
  const families = new Set();

  const collectAt = (offset) => {
    if (offset < 0 || offset + 12 > size) return;
    const dir = readAt(offset, 12);
    const numTables = dir.readUInt16BE(4);
    if (numTables <= 0 || numTables > 512) return;

    const tableRecs = readAt(offset + 12, numTables * 16);
    let nameTableOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = i * 16;
      if (tableRecs.toString("latin1", rec, rec + 4) !== "name") continue;
      nameTableOffset = tableRecs.readUInt32BE(rec + 8);
      break;
    }
    if (nameTableOffset < 0 || nameTableOffset + 6 > size) return;

    const nameHead = readAt(nameTableOffset, 6);
    const count = nameHead.readUInt16BE(2);
    const stringOffset = nameHead.readUInt16BE(4);
    if (count <= 0 || count > 2048) return;

    const nameRecs = readAt(nameTableOffset + 6, count * 12);
    // 同一字体优先取排版家族名 (nameID 16)，其次取家族名 (nameID 1)
    const candidates = { 16: [], 1: [] };
    for (let i = 0; i < count; i++) {
      const rec = i * 12;
      const platformID = nameRecs.readUInt16BE(rec);
      const encodingID = nameRecs.readUInt16BE(rec + 2);
      const languageID = nameRecs.readUInt16BE(rec + 4);
      const nameID = nameRecs.readUInt16BE(rec + 6);
      if (nameID !== 1 && nameID !== 16) continue;

      const length = nameRecs.readUInt16BE(rec + 8);
      const offsetInTable = nameRecs.readUInt16BE(rec + 10);
      const start = nameTableOffset + stringOffset + offsetInTable;
      if (length <= 0 || length > 512 || start + length > size) continue;

      let raw;
      try {
        raw = readAt(start, length);
      } catch {
        continue;
      }

      let value = "";
      if (platformID === 3 || platformID === 0) {
        // Windows / Unicode：UTF-16BE
        for (let p = 0; p + 1 < raw.length; p += 2) {
          const code = raw.readUInt16BE(p);
          if (code === 0) continue;
          value += String.fromCharCode(code);
        }
      } else if (platformID === 1) {
        // Macintosh：Latin-1
        value = raw.toString("latin1");
      }
      value = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
      if (!value) continue;

      const priority =
        platformID === 3 && (encodingID === 1 || encodingID === 10)
          ? languageID === 0x0409
            ? 0
            : 1
          : platformID === 0
          ? 2
          : 3;
      candidates[nameID].push({ value, priority });
    }

    for (const nameID of [16, 1]) {
      const list = candidates[nameID];
      if (!list.length) continue;
      list.sort((a, b) => a.priority - b.priority);
      const family = list[0].value;
      if (
        family.length <= 80 &&
        !family.startsWith(".") &&
        !family.includes("$") &&
        !families.has(family)
      ) {
        families.add(family);
      }
      if (nameID === 16) break;
    }
  };

  try {
    if (size < 12) return [];
    const head = readAt(0, 12);
    if (head.toString("latin1", 0, 4) === "ttcf") {
      const numFonts = head.readUInt32BE(8);
      const limit = Math.min(numFonts, 128);
      const offsets = readAt(12, limit * 4);
      for (let i = 0; i < limit; i++) {
        collectAt(offsets.readUInt32BE(i * 4));
      }
    } else {
      collectAt(0);
    }
  } catch {
    return [];
  }

  return [...families];
}

function readFamiliesFromFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const readAt = (offset, length) => {
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, offset);
      return read === length ? buf : buf.subarray(0, read);
    };
    return parseFamilies(readAt, size);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function walkFontFiles(dir, depth = 0, maxDepth = 3) {
  const results = [];
  if (depth > maxDepth) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  let seen = 0;
  for (const entry of entries) {
    if (seen >= MAX_FILES_PER_DIR) break;
    seen += 1;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFontFiles(full, depth + 1, maxDepth));
    } else if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

function getSystemFonts(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_TTL_MS) {
    return { success: true, fonts: [...cache], cached: true };
  }

  const families = new Set();
  const files = [];
  for (const entry of FONT_DIRS) {
    files.push(...walkFontFiles(entry.dir, 0, entry.depth));
  }

  for (const file of files) {
    for (const family of readFamiliesFromFile(file)) {
      families.add(family);
    }
  }

  const fonts = [...families].sort((a, b) => a.localeCompare(b, "zh-CN"));
  cache = fonts;
  cacheAt = now;
  return { success: true, fonts: [...fonts], cached: false, scannedFiles: files.length };
}

module.exports = { getSystemFonts };
