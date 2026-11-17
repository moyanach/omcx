/**
 * 轻量无依赖 Markdown -> 独立 HTML 文档导出器（支持 GFM 表格、代码块、列表与打印 PDF 样式）
 */

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHref(url) {
  const clean = String(url || "").trim();
  if (/^(https?:\/\/|mailto:|#|\/|\.)/i.test(clean)) {
    return escapeHtml(clean);
  }
  return "#";
}

function formatInline(raw) {
  const codePlaceholders = [];
  let text = String(raw || "").replace(/`([^`]+)`/g, (_, code) => {
    const idx = codePlaceholders.length;
    codePlaceholders.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    return `<a href="${sanitizeHref(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>");

  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codePlaceholders[Number(idx)] || "");
  return text;
}

function splitTableRow(line) {
  let trimmed = String(line || "").trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableDivider(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|") && !trimmed.includes("-")) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function renderMarkdownBody(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fenceMatch = line.match(/^\s*```([a-zA-Z0-9_-]*)\s*$/);
    if (fenceMatch) {
      const lang = escapeHtml(fenceMatch[1] || "");
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(
        `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`
      );
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 标题
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${formatInline(headingMatch[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    // GFM 表格
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${formatInline(h)}</th>`).join("")}</tr></thead>`;
      const tbody =
        rows.length > 0
          ? `<tbody>${rows
              .map(
                (r) =>
                  `<tr>${headers
                    .map((_, colIdx) => `<td>${formatInline(r[colIdx] || "")}</td>`)
                    .join("")}</tr>`
              )
              .join("")}</tbody>`
          : "";
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // 引用块
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${quoteLines.map((l) => `<p>${formatInline(l)}</p>`).join("")}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      out.push(`<ul>${items.map((item) => `<li>${formatInline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push(`<ol>${items.map((item) => `<li>${formatInline(item)}</li>`).join("")}</ol>`);
      continue;
    }

    // 普通段落
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${paraLines.map((l) => formatInline(l)).join("<br />")}</p>`);
  }

  return out.join("\n");
}

function buildStandaloneMarkdownHtml(markdown, { title = "OMCX 导出文档" } = {}) {
  const safeTitle = escapeHtml(title);
  const bodyHtml = renderMarkdownBody(markdown);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 40px 24px 64px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      font-size: 15px;
      line-height: 1.72;
      color: #0f172a;
      background: #ffffff;
    }
    main {
      max-width: 860px;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 {
      margin: 1.4em 0 0.6em;
      line-height: 1.3;
      font-weight: 700;
      color: #0f172a;
    }
    h1 { font-size: 1.85em; padding-bottom: 0.35em; border-bottom: 1px solid #e2e8f0; }
    h2 { font-size: 1.45em; padding-bottom: 0.25em; border-bottom: 1px solid #f1f5f9; }
    h3 { font-size: 1.2em; }
    p { margin: 0.75em 0; }
    ul, ol { margin: 0.75em 0; padding-left: 1.6em; }
    li { margin: 0.3em 0; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.88em;
      background: #f1f5f9;
      padding: 0.15em 0.4em;
      border-radius: 4px;
      color: #1e293b;
    }
    pre {
      margin: 1em 0;
      padding: 14px 16px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow-x: auto;
      line-height: 1.55;
    }
    pre code {
      background: transparent;
      padding: 0;
      font-size: 13px;
    }
    blockquote {
      margin: 1em 0;
      padding: 0.4em 1em;
      border-left: 3px solid #cbd5e1;
      color: #475569;
      background: #f8fafc;
      border-radius: 0 6px 6px 0;
    }
    blockquote p { margin: 0.3em 0; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1em 0;
      font-size: 14px;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 8px 12px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f1f5f9;
      font-weight: 600;
    }
    tr:nth-child(even) td { background: #fafafa; }
    hr { border: none; border-top: 1px solid #e2e8f0; margin: 1.6em 0; }
    @media print {
      body { padding: 0; }
      pre, table, blockquote { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main>
${bodyHtml}
  </main>
</body>
</html>
`;
}

module.exports = {
  renderMarkdownBody,
  buildStandaloneMarkdownHtml,
};
