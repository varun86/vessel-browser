import type { ActionContext } from "../core";
import { resolveSelector } from "../../../utils/selector-resolver";

export async function handleExtractTable(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const selector = args.selector
    ? args.selector
    : args.index != null
      ? await resolveSelector(wc, args.index, undefined)
      : null;
  const tableJson = (await wc.executeJavaScript(`
    (function() {
      var table = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.querySelector('table')"};
      if (!table) return null;
      var headers = [];
      var headerRow = table.querySelector('thead tr') || table.querySelector('tr');
      if (headerRow) {
        headerRow.querySelectorAll('th, td').forEach(function(cell) {
          headers.push(cell.textContent.trim());
        });
      }
      var rows = [];
      var bodyRows = table.querySelectorAll('tbody tr');
      if (bodyRows.length === 0) bodyRows = table.querySelectorAll('tr');
      bodyRows.forEach(function(tr, idx) {
        if (idx === 0 && headers.length > 0 && !table.querySelector('thead')) return;
        var row = {};
        tr.querySelectorAll('td, th').forEach(function(cell, ci) {
          var key = headers[ci] || ("col_" + ci);
          row[key] = cell.textContent.trim();
        });
        if (Object.keys(row).length > 0) rows.push(row);
      });
      return { headers: headers, rows: rows, rowCount: rows.length };
    })()
  `)) as { headers: string[]; rows: Record<string, string>[]; rowCount: number } | null;
  if (!tableJson) return "Error: No table found on the page.";
  return `Extracted table (${tableJson.rowCount} rows):\n${JSON.stringify(tableJson, null, 2)}`;
}
