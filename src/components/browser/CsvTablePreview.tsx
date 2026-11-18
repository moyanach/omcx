import React, { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, Table2 } from "lucide-react";

const MAX_PREVIEW_ROWS = 1000;

export function parseDelimitedTable(
  raw: string,
  delimiter: "," | "\t" = ","
): { headers: string[]; rows: string[][]; truncatedRows: number } {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  if (!text.trim()) {
    return { headers: [], rows: [], truncatedRows: 0 };
  }

  const parsedRows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.length > 1 || row[0] !== "") {
        parsedRows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    parsedRows.push(row);
  }

  if (parsedRows.length === 0) {
    return { headers: [], rows: [], truncatedRows: 0 };
  }

  const headerRow = parsedRows[0].map((h, idx) => (h.trim() ? h.trim() : `列 ${idx + 1}`));
  const body = parsedRows.slice(1);
  const maxCols = Math.max(
    headerRow.length,
    ...body.slice(0, MAX_PREVIEW_ROWS).map((r) => r.length)
  );
  const normalizedHeaders = Array.from({ length: maxCols }, (_, idx) =>
    headerRow[idx] || `列 ${idx + 1}`
  );
  const truncatedRows = Math.max(0, body.length - MAX_PREVIEW_ROWS);
  const rows = body.slice(0, MAX_PREVIEW_ROWS).map((r) =>
    Array.from({ length: maxCols }, (_, idx) => r[idx] ?? "")
  );

  return { headers: normalizedHeaders, rows, truncatedRows };
}

interface CsvTablePreviewProps {
  content?: string;
  ext?: string;
  structuredData?: {
    headers: string[];
    rows: string[][];
    totalRows?: number;
    truncated?: boolean;
  };
}

export const CsvTablePreview: React.FC<CsvTablePreviewProps> = ({
  content = "",
  ext = "csv",
  structuredData,
}) => {
  const delimiter: "," | "\t" = ext.toLowerCase() === "tsv" ? "\t" : ",";
  const [filterText, setFilterText] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const { headers, rows, truncatedRows } = useMemo(() => {
    if (structuredData) {
      const h = Array.isArray(structuredData.headers) ? structuredData.headers : [];
      const r = Array.isArray(structuredData.rows) ? structuredData.rows : [];
      const maxCols = Math.max(
        h.length,
        ...r.slice(0, 200).map((row) => (Array.isArray(row) ? row.length : 0)),
        0
      );
      const normHeaders = Array.from({ length: maxCols }, (_, idx) =>
        String(h[idx] ?? "").trim() || `列 ${idx + 1}`
      );
      // 当第一行与 headers 完全相同（例如 xlsx 第一行是表头）时展示从第 2 行开始的数据
      const body =
        r.length > 0 && h.length > 0 && r[0].every((val, idx) => String(val ?? "") === String(h[idx] ?? ""))
          ? r.slice(1)
          : r;
      const normRows = body.map((row) =>
        Array.from({ length: maxCols }, (_, idx) => String(row?.[idx] ?? ""))
      );
      const total = structuredData.totalRows ?? r.length;
      return {
        headers: normHeaders,
        rows: normRows,
        truncatedRows: structuredData.truncated ? Math.max(1, total - r.length) : 0,
      };
    }
    return parseDelimitedTable(content, delimiter);
  }, [content, delimiter, structuredData]);

  const displayRows = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.some((cell) => cell.toLowerCase().includes(q)))
      : rows;

    if (sortCol === null) return filtered;
    const sorted = [...filtered].sort((a, b) => {
      const av = (a[sortCol] ?? "").trim();
      const bv = (b[sortCol] ?? "").trim();
      const an = Number(av.replace(/,/g, ""));
      const bn = Number(bv.replace(/,/g, ""));
      let cmp = 0;
      if (av !== "" && bv !== "" && Number.isFinite(an) && Number.isFinite(bn)) {
        cmp = an - bn;
      } else {
        cmp = av.localeCompare(bv, "zh-CN", { numeric: true });
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rows, filterText, sortCol, sortDir]);

  const handleSort = (colIdx: number) => {
    if (sortCol !== colIdx) {
      setSortCol(colIdx);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(null);
    }
  };

  if (headers.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-[var(--ui-text-faint)]">
        当前表格文件为空
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[var(--ui-stage-bg)] overflow-hidden">
      {/* 表格统计与筛选工具栏 */}
      <div className="px-3 py-2 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-2 text-[11px] text-[var(--ui-text-muted)]">
          <Table2 size={13} className="text-[var(--ui-accent-emerald)]" />
          <span className="font-mono">
            {displayRows.length} / {rows.length} 行 · {headers.length} 列
          </span>
          {truncatedRows > 0 && (
            <span className="text-[10px] text-[var(--ui-accent-amber)]">
              (已截断后 {truncatedRows} 行)
            </span>
          )}
        </div>

        <div className="ui-focus-ring h-6.5 w-48 rounded-lg bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] flex items-center px-2 gap-1.5">
          <Search size={11} className="text-[var(--ui-text-faint)] flex-shrink-0" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="筛选单元格..."
            className="w-full bg-transparent text-[11px] text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none"
          />
        </div>
      </div>

      {/* 交互式滚动表格 */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="w-full border-collapse text-[11.5px] text-left">
          <thead className="sticky top-0 z-10 bg-[var(--ui-card-header-bg)] backdrop-blur-sm">
            <tr>
              <th className="w-10 px-2.5 py-2 border-b border-r border-[color:var(--ui-divider-hairline)] text-[10px] font-mono text-[var(--ui-text-faint)] text-center">
                #
              </th>
              {headers.map((header, idx) => {
                const isSorted = sortCol === idx;
                return (
                  <th
                    key={`${header}-${idx}`}
                    onClick={() => handleSort(idx)}
                    className="px-3 py-2 border-b border-r border-[color:var(--ui-divider-hairline)] font-semibold text-[var(--ui-text-primary)] whitespace-nowrap cursor-pointer hover:bg-[var(--ui-block-hover-bg)] transition-colors select-none"
                    title="点击按此列排序"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="truncate max-w-[220px]">{header}</span>
                      {isSorted ? (
                        sortDir === "asc" ? (
                          <ArrowUp size={11} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
                        ) : (
                          <ArrowDown size={11} className="text-[var(--ui-accent-blue)] flex-shrink-0" />
                        )
                      ) : (
                        <ArrowUpDown size={10.5} className="text-[var(--ui-text-faint)] opacity-50 flex-shrink-0" />
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td
                  colSpan={headers.length + 1}
                  className="py-8 text-center text-xs text-[var(--ui-text-faint)]"
                >
                  无匹配筛选结果
                </td>
              </tr>
            ) : (
              displayRows.map((row, rIdx) => (
                <tr
                  key={rIdx}
                  className="hover:bg-[var(--ui-block-hover-bg)] transition-colors border-b border-[color:var(--ui-divider-hairline)]"
                >
                  <td className="px-2.5 py-1.5 border-r border-[color:var(--ui-divider-hairline)] text-[10px] font-mono text-[var(--ui-text-faint)] text-center select-none">
                    {rIdx + 1}
                  </td>
                  {row.map((val, cIdx) => (
                    <td
                      key={cIdx}
                      className="px-3 py-1.5 border-r border-[color:var(--ui-divider-hairline)] text-[var(--ui-text-secondary)] max-w-[320px] truncate select-text"
                      title={val}
                    >
                      {val}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CsvTablePreview;
