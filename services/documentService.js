/**
 * documentService.js
 *
 * 统一办公文档解析、结构化生成与工作台富预览服务。
 * 全部基于纯 JS 开源库（pdf-parse / mammoth / word-extractor / exceljs / docx / pptxgenjs / jszip / @xmldom/xmldom），
 * 按需惰性加载，无原生 C++ 编译依赖，完全兼容 Electron 桌面端与 Headless CLI 容器包。
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const SUPPORTED_READ_EXTS = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xlsm",
  "csv",
  "tsv",
  "pptx",
]);

const SUPPORTED_GENERATE_EXTS = new Set(["docx", "xlsx", "pptx"]);

function getDocExtension(filePath) {
  return path.extname(String(filePath || "")).replace(/^\./, "").toLowerCase();
}

function isSupportedReadDocument(filePath) {
  return SUPPORTED_READ_EXTS.has(getDocExtension(filePath));
}

function isSupportedGenerateDocument(filePath) {
  return SUPPORTED_GENERATE_EXTS.has(getDocExtension(filePath));
}

function formatCellValue(val) {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return "";
    return val.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  }
  if (typeof val === "object") {
    if (Array.isArray(val.richText)) {
      return val.richText.map((item) => item?.text || "").join("");
    }
    if ("result" in val) {
      return formatCellValue(val.result);
    }
    if (typeof val.text === "string") {
      return val.text;
    }
    if (typeof val.hyperlink === "string") {
      return val.text || val.hyperlink;
    }
    if (val.error) {
      return String(val.error);
    }
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

function parseDelimitedText(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const src = String(text || "").replace(/^\uFEFF/, "");

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") {
      if (src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

async function extractPdfPages(filePath) {
  const pdfParse = require("pdf-parse/lib/pdf-parse.js");
  const buffer = await fsp.readFile(filePath);
  const pages = [];

  const data = await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      let lastY;
      let pageText = "";
      for (const item of textContent.items || []) {
        const y = Array.isArray(item.transform) ? item.transform[5] : undefined;
        if (lastY === y || lastY === undefined) {
          pageText += item.str || "";
        } else {
          pageText += `\n${item.str || ""}`;
        }
        lastY = y;
      }
      pages.push(pageText.trim());
      return pageText;
    },
  });

  return {
    pageCount: Number(data?.numpages) || pages.length,
    pages,
    info: data?.info || {},
    fullText: pages.join("\n\n"),
  };
}

async function extractDocxContent(filePath) {
  const mammoth = require("mammoth");
  const [mdRes, textRes] = await Promise.all([
    mammoth.convertToMarkdown({ path: filePath }),
    mammoth.extractRawText({ path: filePath }),
  ]);
  const markdown = String(mdRes?.value || "").trim();
  const rawText = String(textRes?.value || "").trim();
  const warnings = Array.isArray(mdRes?.messages)
    ? mdRes.messages.filter((m) => m.type === "warning").map((m) => m.message)
    : [];
  return {
    markdown,
    rawText,
    warnings,
  };
}

async function extractLegacyDocContent(filePath) {
  const WordExtractor = require("word-extractor");
  const extractor = new WordExtractor();
  const doc = await extractor.extract(filePath);
  const body = String(doc.getBody() || "").trim();
  const headers = String(doc.getHeaders?.({ includeFooters: false }) || "").trim();
  const footers = String(doc.getFooters?.() || "").trim();
  return {
    body,
    headers,
    footers,
  };
}

async function extractSpreadsheetSheets(filePath, ext) {
  if (ext === "csv" || ext === "tsv") {
    const raw = await fsp.readFile(filePath, "utf-8");
    const delimiter = ext === "tsv" ? "\t" : ",";
    const rows = parseDelimitedText(raw, delimiter);
    const headers = rows[0] || [];
    const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
    return [
      {
        name: path.basename(filePath),
        totalRows: rows.length,
        totalCols: colCount,
        headers,
        rows,
      },
    ];
  }

  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheets = [];

  for (const ws of workbook.worksheets) {
    const rows = [];
    let maxCols = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      const normalized = vals.map(formatCellValue);
      maxCols = Math.max(maxCols, normalized.length);
      rows.push(normalized);
    });
    const headers = rows[0] || [];
    sheets.push({
      name: ws.name,
      totalRows: rows.length,
      totalCols: Math.max(maxCols, headers.length),
      headers,
      rows,
    });
  }

  return sheets;
}

function collectXmlTextNodes(node, out) {
  if (!node) return;
  if (node.nodeType === 1 && (node.localName === "t" || node.nodeName === "a:t")) {
    const txt = node.textContent;
    if (txt) out.push(txt);
    return;
  }
  const children = node.childNodes;
  if (!children) return;
  for (let i = 0; i < children.length; i += 1) {
    collectXmlTextNodes(children[i], out);
  }
}

async function extractPptxSlides(filePath) {
  const JSZip = require("jszip");
  const { DOMParser } = require("@xmldom/xmldom");
  const buf = await fsp.readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const parser = new DOMParser();

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0);
      const nb = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0);
      return na - nb;
    });

  const slides = [];
  for (const slidePath of slideFiles) {
    const slideIndex = Number(slidePath.match(/slide(\d+)\.xml/i)?.[1] || slides.length + 1);
    const xmlStr = await zip.files[slidePath].async("string");
    const dom = parser.parseFromString(xmlStr, "text/xml");
    const paragraphs = dom.getElementsByTagName("a:p");
    const lines = [];
    for (let i = 0; i < paragraphs.length; i += 1) {
      const chunks = [];
      collectXmlTextNodes(paragraphs[i], chunks);
      const line = chunks.join("").trim();
      if (line) lines.push(line);
    }

    let notes = "";
    const notesPath = `ppt/notesSlides/notesSlide${slideIndex}.xml`;
    if (zip.files[notesPath]) {
      try {
        const notesXml = await zip.files[notesPath].async("string");
        const notesDom = parser.parseFromString(notesXml, "text/xml");
        const noteParagraphs = notesDom.getElementsByTagName("a:p");
        const noteLines = [];
        for (let i = 0; i < noteParagraphs.length; i += 1) {
          const chunks = [];
          collectXmlTextNodes(noteParagraphs[i], chunks);
          const line = chunks.join("").trim();
          if (line && line !== String(slideIndex)) noteLines.push(line);
        }
        notes = noteLines.join("\n").trim();
      } catch {}
    }

    slides.push({
      index: slideIndex,
      title: lines[0] || `第 ${slideIndex} 页`,
      texts: lines,
      notes,
    });
  }

  return slides;
}

const DEFAULT_MAX_CHARS = 24000;

function sliceWithBudget(text, maxChars) {
  const cap = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.min(120000, Math.floor(Number(maxChars)))
    : DEFAULT_MAX_CHARS;
  const src = String(text || "");
  if (src.length <= cap) {
    return { text: src, truncated: false, totalChars: src.length };
  }
  return {
    text: `${src.slice(0, cap)}\n\n... [内容已按 ${cap} 字符上限截断，总计 ${src.length} 字符，请缩小页码或行范围继续读取]`,
    truncated: true,
    totalChars: src.length,
  };
}

/**
 * 统一读取办公文档：支持 outline（大纲/结构）、read（按页/按表分段读取）、search（关键词定位）、aggregate（表格全表聚合统计）
 */
async function readDocument(filePath, options = {}) {
  const ext = getDocExtension(filePath);
  if (!SUPPORTED_READ_EXTS.has(ext)) {
    throw new Error(`不支持的文档格式: .${ext || "unknown"}（支持 pdf/docx/doc/xlsx/xlsm/csv/tsv/pptx）`);
  }
  const mode = ["outline", "read", "search", "aggregate"].includes(options.mode)
    ? options.mode
    : "read";
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;

  if (mode === "aggregate" && !["xlsx", "xlsm", "csv", "tsv"].includes(ext)) {
    throw new Error(`aggregate 模式仅支持 .xlsx / .xlsm / .csv / .tsv 表格文件，当前为 .${ext}`);
  }

  if (ext === "pdf") {
    const pdf = await extractPdfPages(filePath);
    if (mode === "outline") {
      const pagePreviews = pdf.pages.slice(0, 30).map((p, idx) => ({
        page: idx + 1,
        chars: p.length,
        preview: p.replace(/\s+/g, " ").slice(0, 140),
      }));
      return {
        format: "pdf",
        pageCount: pdf.pageCount,
        info: pdf.info,
        pagesPreview: pagePreviews,
        note: pdf.pageCount > 30 ? `仅预览前 30 页摘要，总计 ${pdf.pageCount} 页` : undefined,
      };
    }
    if (mode === "search") {
      const q = String(options.query || "").trim().toLowerCase();
      if (!q) throw new Error("search 模式需要提供 query 参数");
      const matches = [];
      pdf.pages.forEach((txt, idx) => {
        const lower = txt.toLowerCase();
        const hit = lower.indexOf(q);
        if (hit !== -1) {
          const start = Math.max(0, hit - 80);
          const end = Math.min(txt.length, hit + q.length + 160);
          matches.push({
            page: idx + 1,
            snippet: txt.slice(start, end).replace(/\s+/g, " "),
          });
        }
      });
      return {
        format: "pdf",
        pageCount: pdf.pageCount,
        query: options.query,
        matchCount: matches.length,
        matches: matches.slice(0, 40),
      };
    }

    const total = pdf.pages.length;
    const startPage = Math.max(1, Math.floor(Number(options.startPage) || 1));
    const endPage = Math.min(
      total || 1,
      Math.max(startPage, Math.floor(Number(options.endPage) || Math.min(total, startPage + 9)))
    );
    const selected = [];
    for (let p = startPage; p <= endPage; p += 1) {
      selected.push(`--- 第 ${p} 页 / 共 ${total} 页 ---\n${pdf.pages[p - 1] || ""}`);
    }
    const sliced = sliceWithBudget(selected.join("\n\n"), maxChars);
    return {
      format: "pdf",
      pageCount: total,
      startPage,
      endPage,
      content: sliced.text,
      truncated: sliced.truncated || endPage < total,
      totalChars: sliced.totalChars,
    };
  }

  if (ext === "docx") {
    const doc = await extractDocxContent(filePath);
    const lines = doc.markdown.split(/\r?\n/);
    if (mode === "outline") {
      const headings = lines.filter((l) => /^#{1,6}\s+/.test(l)).slice(0, 80);
      return {
        format: "docx",
        totalLines: lines.length,
        totalChars: doc.markdown.length,
        headings,
        preview: doc.markdown.slice(0, 1200),
      };
    }
    if (mode === "search") {
      const q = String(options.query || "").trim().toLowerCase();
      if (!q) throw new Error("search 模式需要提供 query 参数");
      const matches = [];
      lines.forEach((line, idx) => {
        if (line.toLowerCase().includes(q)) {
          matches.push({ line: idx + 1, text: line.slice(0, 300) });
        }
      });
      return {
        format: "docx",
        totalLines: lines.length,
        query: options.query,
        matchCount: matches.length,
        matches: matches.slice(0, 50),
      };
    }
    const startLine = Math.max(0, Math.floor(Number(options.startRow) || 0));
    const maxLines = Math.max(1, Math.floor(Number(options.maxRows) || 400));
    const chunk = lines.slice(startLine, startLine + maxLines).join("\n");
    const sliced = sliceWithBudget(chunk, maxChars);
    return {
      format: "docx",
      totalLines: lines.length,
      startLine,
      endLine: Math.min(lines.length, startLine + maxLines),
      content: sliced.text,
      truncated: sliced.truncated || startLine + maxLines < lines.length,
      warnings: doc.warnings,
    };
  }

  if (ext === "doc") {
    const doc = await extractLegacyDocContent(filePath);
    const lines = doc.body.split(/\r?\n/);
    if (mode === "outline") {
      return {
        format: "doc",
        totalLines: lines.length,
        totalChars: doc.body.length,
        preview: doc.body.slice(0, 1200),
      };
    }
    if (mode === "search") {
      const q = String(options.query || "").trim().toLowerCase();
      if (!q) throw new Error("search 模式需要提供 query 参数");
      const matches = lines
        .map((line, idx) => ({ line: idx + 1, text: line }))
        .filter((item) => item.text.toLowerCase().includes(q))
        .slice(0, 50);
      return { format: "doc", query: options.query, matchCount: matches.length, matches };
    }
    const sliced = sliceWithBudget(doc.body, maxChars);
    return {
      format: "doc",
      totalLines: lines.length,
      content: sliced.text,
      headers: doc.headers || undefined,
      footers: doc.footers || undefined,
      truncated: sliced.truncated,
    };
  }

  if (ext === "pptx") {
    const slides = await extractPptxSlides(filePath);
    if (mode === "outline") {
      return {
        format: "pptx",
        slideCount: slides.length,
        slides: slides.map((s) => ({
          slide: s.index,
          title: s.title,
          textCount: s.texts.length,
          hasNotes: Boolean(s.notes),
        })),
      };
    }
    if (mode === "search") {
      const q = String(options.query || "").trim().toLowerCase();
      if (!q) throw new Error("search 模式需要提供 query 参数");
      const matches = slides
        .filter((s) => {
          const merged = `${s.texts.join("\n")}\n${s.notes}`.toLowerCase();
          return merged.includes(q);
        })
        .map((s) => ({
          slide: s.index,
          title: s.title,
          snippet: s.texts.join(" | ").slice(0, 260),
          notesMatch: s.notes.toLowerCase().includes(q),
        }));
      return { format: "pptx", slideCount: slides.length, query: options.query, matches };
    }

    const startPage = Math.max(1, Math.floor(Number(options.startPage) || 1));
    const endPage = Math.min(
      slides.length || 1,
      Math.max(startPage, Math.floor(Number(options.endPage) || Math.min(slides.length, startPage + 19)))
    );
    const chosen = slides.filter((s) => s.index >= startPage && s.index <= endPage);
    const formatted = chosen
      .map((s) => {
        const parts = [`--- Slide ${s.index}: ${s.title} ---`, ...s.texts];
        if (s.notes) parts.push(`[演讲者备注] ${s.notes}`);
        return parts.join("\n");
      })
      .join("\n\n");
    const sliced = sliceWithBudget(formatted, maxChars);
    return {
      format: "pptx",
      slideCount: slides.length,
      startPage,
      endPage,
      content: sliced.text,
      truncated: sliced.truncated || endPage < slides.length,
    };
  }

  // xlsx / xlsm / csv / tsv
  const sheets = await extractSpreadsheetSheets(filePath, ext);
  if (mode === "outline") {
    return {
      format: ext,
      sheetCount: sheets.length,
      sheets: sheets.map((s) => ({
        name: s.name,
        totalRows: s.totalRows,
        totalCols: s.totalCols,
        headers: s.headers.slice(0, 30),
        sampleRows: s.rows.slice(1, 6),
      })),
    };
  }

  const targetSheetName = options.sheet ? String(options.sheet).trim() : "";
  if (mode === "search") {
    const q = String(options.query || "").trim().toLowerCase();
    if (!q) throw new Error("search 模式需要提供 query 参数");
    const targetSheets = targetSheetName
      ? sheets.filter((s) => s.name === targetSheetName)
      : sheets;
    const matches = [];
    for (const s of targetSheets) {
      s.rows.forEach((row, rIdx) => {
        const matchedCols = [];
        row.forEach((cell, cIdx) => {
          if (String(cell || "").toLowerCase().includes(q)) {
            matchedCols.push({
              col: s.headers[cIdx] || `Col${cIdx + 1}`,
              value: cell,
            });
          }
        });
        if (matchedCols.length > 0 && matches.length < 80) {
          matches.push({
            sheet: s.name,
            rowNumber: rIdx + 1,
            matchedCols,
            rowPreview: row.slice(0, 12),
          });
        }
      });
    }
    return {
      format: ext,
      query: options.query,
      matchCount: matches.length,
      matches,
    };
  }

  const sheet =
    (targetSheetName ? sheets.find((s) => s.name === targetSheetName) : null) || sheets[0];
  if (!sheet) {
    return { format: ext, sheetCount: 0, content: "", message: "工作簿不包含任何工作表" };
  }

  if (mode === "aggregate") {
    return aggregateSpreadsheetSheet(sheet, sheets, ext, options, maxChars);
  }

  const startRow = Math.max(0, Math.floor(Number(options.startRow) || 0));
  const maxRows = Math.min(500, Math.max(1, Math.floor(Number(options.maxRows) || 120)));
  const sliceRows = sheet.rows.slice(startRow, startRow + maxRows);
  const tsvLines = sliceRows.map((r) => r.map((c) => String(c || "").replace(/\t|\n/g, " ")).join("\t"));
  const sliced = sliceWithBudget(tsvLines.join("\n"), maxChars);

  return {
    format: ext,
    sheet: sheet.name,
    availableSheets: sheets.map((s) => s.name),
    totalRows: sheet.totalRows,
    totalCols: sheet.totalCols,
    startRow,
    endRow: Math.min(sheet.totalRows, startRow + maxRows),
    headers: sheet.headers,
    content: sliced.text,
    truncated: sliced.truncated || startRow + maxRows < sheet.totalRows,
  };
}

function parseNumericCell(raw) {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  const text = String(raw ?? "").trim();
  if (!text) return null;
  // 去掉常见货币符号，保留数字与正负号、千分位逗号、小数点与末尾百分号
  const cleaned = text.replace(/^[¥$€£]/, "").trim();
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/.test(cleaned)) {
    return null;
  }
  const isPercent = cleaned.endsWith("%");
  const numStr = (isPercent ? cleaned.slice(0, -1) : cleaned).replace(/,/g, "");
  const num = Number(numStr);
  if (!Number.isFinite(num)) return null;
  return num;
}

function computeMedian(sortedNums) {
  if (!sortedNums || sortedNums.length === 0) return null;
  const mid = Math.floor(sortedNums.length / 2);
  if (sortedNums.length % 2 === 1) {
    return sortedNums[mid];
  }
  return (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

function roundMetricValue(val) {
  if (typeof val !== "number" || !Number.isFinite(val)) return val;
  return Math.round(val * 10000) / 10000;
}

function buildHeaderIndexMap(headersRow) {
  const indexMap = new Map();
  const normalizedHeaders = [];
  const seen = new Map();
  (headersRow || []).forEach((h, idx) => {
    let name = String(h ?? "").trim();
    if (!name) name = `Col${idx + 1}`;
    const dupCount = seen.get(name) || 0;
    seen.set(name, dupCount + 1);
    const uniqueName = dupCount > 0 ? `${name}_${dupCount + 1}` : name;
    normalizedHeaders.push(uniqueName);
    if (!indexMap.has(uniqueName)) indexMap.set(uniqueName, idx);
    const lower = uniqueName.toLowerCase();
    if (!indexMap.has(lower)) indexMap.set(lower, idx);
  });
  return { indexMap, normalizedHeaders };
}

function resolveColumnIndex(indexMap, normalizedHeaders, colName) {
  const target = String(colName ?? "").trim();
  if (!target) {
    throw new Error("aggregate 参数中包含空列名");
  }
  if (indexMap.has(target)) return indexMap.get(target);
  const lower = target.toLowerCase();
  if (indexMap.has(lower)) return indexMap.get(lower);
  const preview = normalizedHeaders.slice(0, 30).join(", ");
  throw new Error(`未找到列名 "${colName}"（可用列名: ${preview}）`);
}

function matchWhereCondition(cellRaw, cond) {
  const op = cond.op || "eq";
  const text = String(cellRaw ?? "").trim();
  if (op === "is_empty") return text.length === 0;
  if (op === "not_empty") return text.length > 0;

  const targetVal = cond.value;
  if (op === "in") {
    const arr = Array.isArray(targetVal) ? targetVal : [targetVal];
    const set = new Set(arr.map((v) => String(v ?? "").trim().toLowerCase()));
    return set.has(text.toLowerCase());
  }

  const targetStr = String(targetVal ?? "").trim();
  if (op === "eq") {
    const n1 = parseNumericCell(text);
    const n2 = parseNumericCell(targetStr);
    if (n1 !== null && n2 !== null) return n1 === n2;
    return text.toLowerCase() === targetStr.toLowerCase();
  }
  if (op === "neq") {
    const n1 = parseNumericCell(text);
    const n2 = parseNumericCell(targetStr);
    if (n1 !== null && n2 !== null) return n1 !== n2;
    return text.toLowerCase() !== targetStr.toLowerCase();
  }
  if (op === "contains") {
    return text.toLowerCase().includes(targetStr.toLowerCase());
  }
  if (op === "not_contains") {
    return !text.toLowerCase().includes(targetStr.toLowerCase());
  }

  const nCell = parseNumericCell(text);
  const nTarget = parseNumericCell(targetStr);
  if (nCell !== null && nTarget !== null) {
    if (op === "gt") return nCell > nTarget;
    if (op === "gte") return nCell >= nTarget;
    if (op === "lt") return nCell < nTarget;
    if (op === "lte") return nCell <= nTarget;
  } else if (text.length > 0 && targetStr.length > 0) {
    if (op === "gt") return text > targetStr;
    if (op === "gte") return text >= targetStr;
    if (op === "lt") return text < targetStr;
    if (op === "lte") return text <= targetStr;
  }
  return false;
}

function buildColumnProfile(dataRows, normalizedHeaders) {
  return normalizedHeaders.map((colName, colIdx) => {
    let nonEmptyCount = 0;
    const freqMap = new Map();
    const numericVals = [];

    for (const row of dataRows) {
      const val = String(row[colIdx] ?? "").trim();
      if (!val) continue;
      nonEmptyCount += 1;
      freqMap.set(val, (freqMap.get(val) || 0) + 1);
      const num = parseNumericCell(val);
      if (num !== null) numericVals.push(num);
    }

    const topValues = Array.from(freqMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value, count]) => ({
        value: value.length > 80 ? `${value.slice(0, 80)}...` : value,
        count,
        ratio: nonEmptyCount > 0 ? `${((count / nonEmptyCount) * 100).toFixed(1)}%` : "0%",
      }));

    const item = {
      column: colName,
      nonEmptyCount,
      emptyCount: dataRows.length - nonEmptyCount,
      uniqueCount: freqMap.size,
      topValues,
    };

    if (numericVals.length > 0 && numericVals.length >= Math.min(3, nonEmptyCount)) {
      numericVals.sort((a, b) => a - b);
      const sum = numericVals.reduce((acc, v) => acc + v, 0);
      item.numericStats = {
        count: numericVals.length,
        sum: roundMetricValue(sum),
        avg: roundMetricValue(sum / numericVals.length),
        min: numericVals[0],
        max: numericVals[numericVals.length - 1],
        median: roundMetricValue(computeMedian(numericVals)),
      };
    }

    return item;
  });
}

function aggregateSpreadsheetSheet(sheet, sheets, ext, options, maxChars) {
  const rawRows = Array.isArray(sheet.rows) ? sheet.rows : [];
  if (rawRows.length === 0) {
    return {
      format: ext,
      mode: "aggregate",
      sheet: sheet.name,
      totalDataRows: 0,
      matchedRows: 0,
      groups: [],
      message: "工作表为空",
    };
  }

  const headerIdx = Math.max(0, Math.min(rawRows.length - 1, (Math.floor(Number(options.headerRow) || 1)) - 1));
  const { indexMap, normalizedHeaders } = buildHeaderIndexMap(rawRows[headerIdx]);
  const dataRows = rawRows.slice(headerIdx + 1);

  const whereList = Array.isArray(options.where) ? options.where : [];
  const compiledWhere = whereList.map((cond) => ({
    colIdx: resolveColumnIndex(indexMap, normalizedHeaders, cond.column),
    cond,
  }));

  const filteredRows =
    compiledWhere.length === 0
      ? dataRows
      : dataRows.filter((row) =>
          compiledWhere.every(({ colIdx, cond }) => matchWhereCondition(row[colIdx], cond))
        );

  const groupCols = Array.isArray(options.groupBy)
    ? options.groupBy.map((c) => String(c || "").trim()).filter(Boolean)
    : [];
  const rawMetrics = Array.isArray(options.metrics) ? options.metrics : [];

  // 未传 groupBy 且未传 metrics 时，输出全表/过滤后全列分布与数值画像
  if (groupCols.length === 0 && rawMetrics.length === 0) {
    const profile = buildColumnProfile(filteredRows, normalizedHeaders);
    const budgetCap = Math.min(120000, Math.max(4000, Number(maxChars) || DEFAULT_MAX_CHARS));
    const trimmedProfile = [];
    let usedChars = 0;
    let truncated = false;
    for (const colProfile of profile) {
      const pieceLen = JSON.stringify(colProfile).length;
      if (trimmedProfile.length > 0 && usedChars + pieceLen > budgetCap - 1000) {
        truncated = true;
        break;
      }
      trimmedProfile.push(colProfile);
      usedChars += pieceLen;
    }
    return {
      format: ext,
      mode: "aggregate",
      kind: "column_profile",
      sheet: sheet.name,
      availableSheets: sheets.map((s) => s.name),
      headerRow: headerIdx + 1,
      headers: normalizedHeaders,
      totalDataRows: dataRows.length,
      matchedRows: filteredRows.length,
      columnCount: normalizedHeaders.length,
      columnsProfiled: trimmedProfile.length,
      truncated,
      columnProfiles: trimmedProfile,
    };
  }

  const groupIndices = groupCols.map((name) => ({
    name,
    idx: resolveColumnIndex(indexMap, normalizedHeaders, name),
  }));

  const effectiveMetrics =
    rawMetrics.length > 0
      ? rawMetrics.map((m, i) => {
          const op = m.op || "count";
          const colName = m.column ? String(m.column).trim() : "";
          const colIdx = op === "count" && !colName
            ? -1
            : resolveColumnIndex(indexMap, normalizedHeaders, colName);
          const as =
            (m.as && String(m.as).trim()) ||
            (op === "count" && !colName ? "count" : `${op}_${colName || i}`);
          return { op, colName, colIdx, as };
        })
      : [{ op: "count", colName: "", colIdx: -1, as: "count" }];

  const groupBuckets = new Map();
  for (const row of filteredRows) {
    const keyParts = groupIndices.map(({ idx }) => {
      const v = String(row[idx] ?? "").trim();
      return v === "" ? "(空)" : v;
    });
    const bucketKey = JSON.stringify(keyParts);
    let bucket = groupBuckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        keyValues: keyParts,
        rows: [],
      };
      groupBuckets.set(bucketKey, bucket);
    }
    bucket.rows.push(row);
  }

  const aggregated = [];
  for (const bucket of groupBuckets.values()) {
    const record = {};
    groupIndices.forEach(({ name }, idx) => {
      record[name] = bucket.keyValues[idx];
    });

    for (const metric of effectiveMetrics) {
      if (metric.op === "count") {
        if (metric.colIdx === -1) {
          record[metric.as] = bucket.rows.length;
        } else {
          let cnt = 0;
          for (const r of bucket.rows) {
            if (String(r[metric.colIdx] ?? "").trim() !== "") cnt += 1;
          }
          record[metric.as] = cnt;
        }
        continue;
      }
      if (metric.op === "count_distinct") {
        const distinct = new Set();
        for (const r of bucket.rows) {
          const v = String(r[metric.colIdx] ?? "").trim();
          if (v !== "") distinct.add(v);
        }
        record[metric.as] = distinct.size;
        continue;
      }

      const nums = [];
      for (const r of bucket.rows) {
        const n = parseNumericCell(r[metric.colIdx]);
        if (n !== null) nums.push(n);
      }
      if (nums.length === 0) {
        record[metric.as] = metric.op === "sum" ? 0 : null;
        continue;
      }
      if (metric.op === "sum") {
        record[metric.as] = roundMetricValue(nums.reduce((a, b) => a + b, 0));
      } else if (metric.op === "avg") {
        record[metric.as] = roundMetricValue(nums.reduce((a, b) => a + b, 0) / nums.length);
      } else if (metric.op === "min") {
        record[metric.as] = Math.min(...nums);
      } else if (metric.op === "max") {
        record[metric.as] = Math.max(...nums);
      } else if (metric.op === "median") {
        nums.sort((a, b) => a - b);
        record[metric.as] = roundMetricValue(computeMedian(nums));
      }
    }
    aggregated.push(record);
  }

  const defaultSortField = effectiveMetrics[0]?.as || "count";
  const sortField = (options.sortBy && String(options.sortBy).trim()) || defaultSortField;
  const sortOrder = options.sortOrder === "asc" ? 1 : -1;

  aggregated.sort((a, b) => {
    const va = a[sortField];
    const vb = b[sortField];
    if (va === vb) return 0;
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === "number" && typeof vb === "number") {
      return (va - vb) * sortOrder;
    }
    return String(va).localeCompare(String(vb), "zh-CN") * sortOrder;
  });

  const limit = Math.min(500, Math.max(1, Math.floor(Number(options.limit) || 50)));
  const limited = aggregated.slice(0, limit);

  const budgetCap = Math.min(120000, Math.max(2000, Number(maxChars) || DEFAULT_MAX_CHARS));
  const finalGroups = [];
  let usedChars = 0;
  let budgetTruncated = false;
  for (const row of limited) {
    const len = JSON.stringify(row).length;
    if (finalGroups.length > 0 && usedChars + len > budgetCap - 800) {
      budgetTruncated = true;
      break;
    }
    finalGroups.push(row);
    usedChars += len;
  }

  return {
    format: ext,
    mode: "aggregate",
    kind: "grouped_summary",
    sheet: sheet.name,
    availableSheets: sheets.map((s) => s.name),
    headerRow: headerIdx + 1,
    headers: normalizedHeaders,
    totalDataRows: dataRows.length,
    matchedRows: filteredRows.length,
    totalGroups: aggregated.length,
    returnedGroups: finalGroups.length,
    truncated: budgetTruncated || aggregated.length > finalGroups.length,
    groups: finalGroups,
  };
}

function parseMarkdownToDocBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      blocks.push({ type: "heading", level: hMatch[1].length, text: hMatch[2].trim() });
      i += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, "").trim());
        i += 1;
      }
      blocks.push({ type: "bullet_list", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, "").trim());
        i += 1;
      }
      blocks.push({ type: "numbered_list", items });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const splitRow = (r) =>
        r
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, "").trim());
        i += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join(" ") });
      continue;
    }
    blocks.push({ type: "paragraph", text: line.trim() });
    i += 1;
  }

  return blocks;
}

function parseRichTextRuns(text, TextRun, baseOptions = {}) {
  const src = String(text || "");
  const parts = src.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  if (parts.length === 0) return [new TextRun({ text: "", ...baseOptions })];
  return parts.map((part) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return new TextRun({ text: part.slice(2, -2), bold: true, ...baseOptions });
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return new TextRun({ text: part.slice(1, -1), font: "Menlo", ...baseOptions });
    }
    return new TextRun({ text: part, ...baseOptions });
  });
}

async function generateDocxFile(targetPath, spec = {}) {
  const docx = require("docx");
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    BorderStyle,
    ShadingType,
    PageBreak,
  } = docx;

  const headingMap = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6,
  };

  const children = [];

  if (spec.title) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.LEFT,
        spacing: { after: spec.subtitle ? 120 : 280 },
        children: [new TextRun({ text: String(spec.title), bold: true })],
      })
    );
  }
  if (spec.subtitle) {
    children.push(
      new Paragraph({
        spacing: { after: 280 },
        children: [new TextRun({ text: String(spec.subtitle), color: "64748B", size: 22 })],
      })
    );
  }

  const blocks =
    Array.isArray(spec.blocks) && spec.blocks.length > 0
      ? spec.blocks
      : spec.markdown
      ? parseMarkdownToDocBlocks(spec.markdown)
      : [];

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = String(block.type || "paragraph").toLowerCase();

    if (type === "heading") {
      const level = Math.min(6, Math.max(1, Number(block.level) || 1));
      children.push(
        new Paragraph({
          heading: headingMap[level] || HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 },
          children: parseRichTextRuns(block.text || "", TextRun),
        })
      );
      continue;
    }

    if (type === "bullet_list" || type === "bullet") {
      const items = Array.isArray(block.items) ? block.items : [block.text].filter(Boolean);
      for (const item of items) {
        children.push(
          new Paragraph({
            bullet: { level: Number(block.indent) || 0 },
            spacing: { after: 80 },
            children: parseRichTextRuns(String(item || ""), TextRun),
          })
        );
      }
      continue;
    }

    if (type === "numbered_list" || type === "numbered") {
      const items = Array.isArray(block.items) ? block.items : [block.text].filter(Boolean);
      items.forEach((item, idx) => {
        children.push(
          new Paragraph({
            spacing: { after: 80 },
            indent: { left: 360 },
            children: [
              new TextRun({ text: `${idx + 1}. `, bold: true }),
              ...parseRichTextRuns(String(item || ""), TextRun),
            ],
          })
        );
      });
      continue;
    }

    if (type === "quote") {
      children.push(
        new Paragraph({
          indent: { left: 360 },
          spacing: { before: 120, after: 120 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: "3B82F6", space: 8 },
          },
          children: parseRichTextRuns(block.text || "", TextRun, { color: "475569", italics: true }),
        })
      );
      continue;
    }

    if (type === "page_break") {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      continue;
    }

    if (type === "table") {
      const headers = Array.isArray(block.headers) ? block.headers : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const tableRows = [];

      const cellBorder = {
        top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
        left: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
        right: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
      };

      if (headers.length > 0) {
        tableRows.push(
          new TableRow({
            tableHeader: true,
            children: headers.map(
              (h) =>
                new TableCell({
                  borders: cellBorder,
                  shading: { type: ShadingType.SOLID, color: "F1F5F9" },
                  children: [
                    new Paragraph({
                      spacing: { before: 60, after: 60 },
                      children: [new TextRun({ text: String(h ?? ""), bold: true, size: 20 })],
                    }),
                  ],
                })
            ),
          })
        );
      }

      const colCount = Math.max(
        headers.length,
        rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
        1
      );

      for (const r of rows) {
        const arr = Array.isArray(r) ? r : [];
        const cells = [];
        for (let c = 0; c < colCount; c += 1) {
          cells.push(
            new TableCell({
              borders: cellBorder,
              children: [
                new Paragraph({
                  spacing: { before: 40, after: 40 },
                  children: parseRichTextRuns(String(arr[c] ?? ""), TextRun, { size: 20 }),
                }),
              ],
            })
          );
        }
        tableRows.push(new TableRow({ children: cells }));
      }

      if (tableRows.length > 0) {
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: tableRows,
          })
        );
        children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
      }
      continue;
    }

    children.push(
      new Paragraph({
        spacing: { after: 140, line: 340 },
        children: parseRichTextRuns(String(block.text || ""), TextRun),
      })
    );
  }

  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: "PingFang SC",
            size: 22,
          },
        },
      },
    },
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, buffer);
  return { format: "docx", bytes: buffer.length, blocksCount: blocks.length };
}

function estimateDisplayWidth(str) {
  let width = 0;
  for (const ch of String(str || "")) {
    width += ch.charCodeAt(0) > 127 ? 2 : 1;
  }
  return width;
}

async function generateXlsxFile(targetPath, spec = {}) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  const sheetSpecs =
    Array.isArray(spec.sheets) && spec.sheets.length > 0
      ? spec.sheets
      : [
          {
            name: spec.sheetName || spec.title || "Sheet1",
            headers: Array.isArray(spec.headers) ? spec.headers : [],
            rows: Array.isArray(spec.rows) ? spec.rows : [],
          },
        ];

  const usedNames = new Set();
  const summary = [];

  for (let sIdx = 0; sIdx < sheetSpecs.length; sIdx += 1) {
    const s = sheetSpecs[sIdx] || {};
    let safeName = String(s.name || `Sheet${sIdx + 1}`)
      .replace(/[\\/?*[\]:]/g, "_")
      .slice(0, 31)
      .trim() || `Sheet${sIdx + 1}`;
    while (usedNames.has(safeName)) {
      safeName = `${safeName.slice(0, 27)}_${sIdx + 1}`;
    }
    usedNames.add(safeName);

    const ws = workbook.addWorksheet(safeName);
    const headers = Array.isArray(s.headers) ? s.headers : [];
    const rows = Array.isArray(s.rows) ? s.rows : [];
    const hasHeaders = headers.length > 0;

    if (hasHeaders) {
      const headerRow = ws.addRow(headers);
      headerRow.height = 24;
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FF0F172A" }, size: 11 };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF1F5F9" },
        };
        cell.alignment = { vertical: "middle", horizontal: "left" };
        cell.border = {
          top: { style: "thin", color: { argb: "FFCBD5E1" } },
          bottom: { style: "thin", color: { argb: "FF94A3B8" } },
          left: { style: "thin", color: { argb: "FFE2E8F0" } },
          right: { style: "thin", color: { argb: "FFE2E8F0" } },
        };
      });
      ws.views = [{ state: "frozen", ySplit: 1 }];
    }

    for (const r of rows) {
      const arr = Array.isArray(r) ? r : [];
      const added = ws.addRow(arr);
      added.eachCell((cell) => {
        cell.alignment = { vertical: "middle", wrapText: false };
        cell.border = {
          bottom: { style: "thin", color: { argb: "FFF1F5F9" } },
          left: { style: "thin", color: { argb: "FFF1F5F9" } },
          right: { style: "thin", color: { argb: "FFF1F5F9" } },
        };
      });
    }

    const colCount = Math.max(
      headers.length,
      rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0)
    );
    const customWidths = Array.isArray(s.columnWidths) ? s.columnWidths : [];
    for (let c = 0; c < colCount; c += 1) {
      let maxW = headers[c] ? estimateDisplayWidth(headers[c]) : 8;
      for (let r = 0; r < Math.min(rows.length, 200); r += 1) {
        const val = rows[r]?.[c];
        if (val !== undefined && val !== null) {
          maxW = Math.max(maxW, estimateDisplayWidth(val));
        }
      }
      const width = Number(customWidths[c]) || Math.min(48, Math.max(10, maxW + 4));
      ws.getColumn(c + 1).width = width;
    }

    summary.push({ name: safeName, rows: rows.length + (hasHeaders ? 1 : 0), cols: colCount });
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await workbook.xlsx.writeFile(targetPath);
  const stat = await fsp.stat(targetPath);
  return { format: "xlsx", bytes: stat.size, sheets: summary };
}

const PPT_THEMES = {
  slate: { bg: "FFFFFF", title: "0F172A", body: "334155", accent: "2563EB", muted: "64748B", card: "F8FAFC" },
  blue: { bg: "F8FAFC", title: "1E3A8A", body: "1E293B", accent: "0284C7", muted: "64748B", card: "FFFFFF" },
  dark: { bg: "0F172A", title: "F8FAFC", body: "CBD5E1", accent: "38BDF8", muted: "94A3B8", card: "1E293B" },
  warm: { bg: "FFFBF5", title: "292524", body: "44403C", accent: "D97706", muted: "78716C", card: "FEF3C7" },
};

async function generatePptxFile(targetPath, spec = {}) {
  const PptxGenJS = require("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  if (spec.title) pptx.title = String(spec.title);

  const palette = PPT_THEMES[spec.theme] || PPT_THEMES.slate;
  const slidesInput = Array.isArray(spec.slides) ? spec.slides : [];

  if (spec.title) {
    const cover = pptx.addSlide();
    cover.background = { color: palette.bg };
    cover.addShape(pptx.ShapeType.rect, {
      x: 0.8,
      y: 2.35,
      w: 0.12,
      h: 2.2,
      fill: { color: palette.accent },
    });
    cover.addText(String(spec.title), {
      x: 1.15,
      y: 2.35,
      w: 11.2,
      h: 1.3,
      fontSize: 34,
      bold: true,
      color: palette.title,
      fontFace: "PingFang SC",
      valign: "top",
    });
    if (spec.subtitle) {
      cover.addText(String(spec.subtitle), {
        x: 1.15,
        y: 3.75,
        w: 10.8,
        h: 0.9,
        fontSize: 18,
        color: palette.muted,
        fontFace: "PingFang SC",
        valign: "top",
      });
    }
  }

  slidesInput.forEach((s, idx) => {
    if (!s || typeof s !== "object") return;
    const slide = pptx.addSlide();
    slide.background = { color: palette.bg };

    // 顶部细强调条
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.33,
      h: 0.08,
      fill: { color: palette.accent },
    });

    slide.addText(String(s.title || `第 ${idx + 1} 页`), {
      x: 0.75,
      y: 0.4,
      w: 11.8,
      h: 0.7,
      fontSize: 24,
      bold: true,
      color: palette.title,
      fontFace: "PingFang SC",
    });

    let contentY = 1.25;
    if (s.subtitle) {
      slide.addText(String(s.subtitle), {
        x: 0.75,
        y: 1.08,
        w: 11.8,
        h: 0.4,
        fontSize: 13,
        color: palette.muted,
        fontFace: "PingFang SC",
      });
      contentY = 1.55;
    }

    const bullets = Array.isArray(s.bullets) ? s.bullets.filter(Boolean) : [];
    const hasTable = s.table && Array.isArray(s.table.rows);

    if (bullets.length > 0) {
      const bulletRuns = bullets.map((b) => ({
        text: String(b),
        options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 8 },
      }));
      slide.addText(bulletRuns, {
        x: 0.8,
        y: contentY,
        w: 11.7,
        h: hasTable ? 2.4 : 5.3,
        fontSize: 16,
        color: palette.body,
        fontFace: "PingFang SC",
        valign: "top",
      });
      contentY += hasTable ? 2.5 : 5.3;
    } else if (s.text) {
      slide.addText(String(s.text), {
        x: 0.8,
        y: contentY,
        w: 11.7,
        h: hasTable ? 2.2 : 5.3,
        fontSize: 16,
        color: palette.body,
        fontFace: "PingFang SC",
        valign: "top",
      });
      contentY += hasTable ? 2.3 : 5.3;
    }

    if (hasTable) {
      const tHeaders = Array.isArray(s.table.headers) ? s.table.headers : [];
      const tRows = [];
      if (tHeaders.length > 0) {
        tRows.push(
          tHeaders.map((h) => ({
            text: String(h ?? ""),
            options: { bold: true, fill: { color: palette.card }, color: palette.title },
          }))
        );
      }
      for (const r of s.table.rows) {
        if (!Array.isArray(r)) continue;
        tRows.push(
          r.map((cell) => ({
            text: String(cell ?? ""),
            options: { color: palette.body },
          }))
        );
      }
      if (tRows.length > 0) {
        slide.addTable(tRows, {
          x: 0.8,
          y: Math.min(contentY, 4.2),
          w: 11.7,
          fontSize: 12,
          fontFace: "PingFang SC",
          border: { pt: 0.5, color: "CBD5E1" },
          autoPage: false,
        });
      }
    }

    if (s.notes) {
      slide.addNotes(String(s.notes));
    }

    slide.addText(`${idx + 1} / ${slidesInput.length}`, {
      x: 11.6,
      y: 7.05,
      w: 1.0,
      h: 0.3,
      fontSize: 10,
      color: palette.muted,
      align: "right",
    });
  });

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await pptx.writeFile({ fileName: targetPath });
  const stat = await fsp.stat(targetPath);
  return {
    format: "pptx",
    bytes: stat.size,
    slideCount: slidesInput.length + (spec.title ? 1 : 0),
  };
}

async function generateDocument(targetPath, spec = {}) {
  const ext = getDocExtension(targetPath);
  if (ext === "docx") return generateDocxFile(targetPath, spec);
  if (ext === "xlsx") return generateXlsxFile(targetPath, spec);
  if (ext === "pptx") return generatePptxFile(targetPath, spec);
  throw new Error(`不支持生成的文档格式: .${ext || "unknown"}（仅支持 docx / xlsx / pptx）`);
}

function sanitizeDocxPreviewHtml(rawHtml) {
  return String(rawHtml || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

async function previewDocumentForWorkbench(filePath) {
  const ext = getDocExtension(filePath);
  if (!SUPPORTED_READ_EXTS.has(ext)) {
    throw new Error(`不支持预览该文件格式: .${ext}`);
  }

  if (ext === "xlsx" || ext === "xlsm") {
    const sheets = await extractSpreadsheetSheets(filePath, ext);
    const MAX_PREVIEW_ROWS = 2000;
    return {
      kind: "spreadsheet",
      format: ext,
      sheets: sheets.map((s) => ({
        name: s.name,
        totalRows: s.totalRows,
        totalCols: s.totalCols,
        headers: s.headers,
        rows: s.rows.slice(0, MAX_PREVIEW_ROWS),
        truncated: s.totalRows > MAX_PREVIEW_ROWS,
      })),
    };
  }

  if (ext === "docx") {
    const mammoth = require("mammoth");
    const res = await mammoth.convertToHtml({ path: filePath });
    const html = sanitizeDocxPreviewHtml(res?.value || "");
    return {
      kind: "docx",
      format: "docx",
      html,
      warnings: Array.isArray(res?.messages)
        ? res.messages.filter((m) => m.type === "warning").map((m) => m.message)
        : [],
    };
  }

  if (ext === "doc") {
    const doc = await extractLegacyDocContent(filePath);
    return {
      kind: "doc",
      format: "doc",
      text: doc.body.slice(0, 120000),
      truncated: doc.body.length > 120000,
    };
  }

  if (ext === "pptx") {
    const slides = await extractPptxSlides(filePath);
    return {
      kind: "presentation",
      format: "pptx",
      slides,
    };
  }

  if (ext === "pdf") {
    const pdf = await extractPdfPages(filePath);
    const joined = pdf.pages
      .slice(0, 40)
      .map((p, idx) => `--- 第 ${idx + 1} 页 / 共 ${pdf.pageCount} 页 ---\n${p}`)
      .join("\n\n");
    return {
      kind: "pdf",
      format: "pdf",
      pageCount: pdf.pageCount,
      info: pdf.info,
      previewText: joined.slice(0, 100000),
      truncated: pdf.pageCount > 40 || joined.length > 100000,
    };
  }

  return null;
}

module.exports = {
  SUPPORTED_READ_EXTS,
  SUPPORTED_GENERATE_EXTS,
  getDocExtension,
  isSupportedReadDocument,
  isSupportedGenerateDocument,
  readDocument,
  generateDocument,
  previewDocumentForWorkbench,
};

