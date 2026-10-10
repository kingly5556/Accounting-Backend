import ExcelJS from "exceljs";
import type { StatementRow } from "./statements.js";

// Excel stores numbers as doubles. Satang up to 2^53 (about 90 trillion baht) convert to
// baht exactly; anything beyond that is written as text rather than silently rounded.
function bahtCell(satang: bigint): number | string {
  if (satang > BigInt(Number.MAX_SAFE_INTEGER) || satang < -BigInt(Number.MAX_SAFE_INTEGER)) return satang.toString();
  return Number(satang) / 100;
}

const MONEY = "#,##0.00;[Red]-#,##0.00";

function sheet(title: string, subtitle: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "K-ERP Accounting";
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([subtitle]).font = { italic: true, color: { argb: "FF666666" } };
  ws.addRow([]);
  return { wb, ws };
}

function header(ws: ExcelJS.Worksheet, labels: string[]) {
  const row = ws.addRow(labels);
  row.font = { bold: true };
  row.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF1F5" } };
  });
}

function money(ws: ExcelJS.Worksheet, cols: number[]) {
  for (const c of cols) {
    ws.getColumn(c).numFmt = MONEY;
    ws.getColumn(c).alignment = { horizontal: "right" };
  }
}

export async function trialBalanceXlsx(tb: {
  asOf: string;
  accounts: { code: string; name: string; debitBalance: bigint; creditBalance: bigint }[];
  totalDebit: bigint;
  totalCredit: bigint;
  balanced: boolean;
}) {
  const { wb, ws } = sheet("Trial Balance", `As of ${tb.asOf} (THB)`);
  header(ws, ["Code", "Account", "Debit", "Credit"]);
  for (const a of tb.accounts) {
    ws.addRow([a.code, a.name, a.debitBalance > 0n ? bahtCell(a.debitBalance) : null, a.creditBalance > 0n ? bahtCell(a.creditBalance) : null]);
  }
  const total = ws.addRow(["", "Total", bahtCell(tb.totalDebit), bahtCell(tb.totalCredit)]);
  total.font = { bold: true };
  ws.addRow([]);
  ws.addRow(["", tb.balanced ? "Debit = Credit (in balance)" : "OUT OF BALANCE"]);
  ws.columns = [{ width: 10 }, { width: 44 }, { width: 18 }, { width: 18 }];
  money(ws, [3, 4]);
  return wb.xlsx.writeBuffer();
}

function section(ws: ExcelJS.Worksheet, label: string, rows: StatementRow[], total: bigint, totalLabel: string) {
  ws.addRow([label]).font = { bold: true };
  for (const r of rows) ws.addRow([r.code, r.name, bahtCell(r.amount)]);
  const t = ws.addRow(["", totalLabel, bahtCell(total)]);
  t.font = { bold: true };
  ws.addRow([]);
}

export async function incomeStatementXlsx(is: {
  from: string;
  to: string;
  revenues: StatementRow[];
  expenses: StatementRow[];
  totalRevenue: bigint;
  totalExpense: bigint;
  netIncome: bigint;
}) {
  const { wb, ws } = sheet("Income Statement", `${is.from} to ${is.to} (THB)`);
  section(ws, "Revenue", is.revenues, is.totalRevenue, "Total revenue");
  section(ws, "Expenses", is.expenses, is.totalExpense, "Total expenses");
  const ni = ws.addRow(["", is.netIncome >= 0n ? "Net income" : "Net loss", bahtCell(is.netIncome)]);
  ni.font = { bold: true, size: 12 };
  ws.columns = [{ width: 10 }, { width: 44 }, { width: 18 }];
  money(ws, [3]);
  return wb.xlsx.writeBuffer();
}

export async function balanceSheetXlsx(bs: {
  asOf: string;
  assets: StatementRow[];
  liabilities: StatementRow[];
  equity: StatementRow[];
  netIncomeToDate: bigint;
  totalAssets: bigint;
  totalLiabilities: bigint;
  totalEquity: bigint;
  balanced: boolean;
}) {
  const { wb, ws } = sheet("Balance Sheet", `As of ${bs.asOf} (THB)`);
  section(ws, "Assets", bs.assets, bs.totalAssets, "Total assets");
  section(ws, "Liabilities", bs.liabilities, bs.totalLiabilities, "Total liabilities");
  ws.addRow(["Equity"]).font = { bold: true };
  for (const r of bs.equity) ws.addRow([r.code, r.name, bahtCell(r.amount)]);
  ws.addRow(["", "Net income to date (not yet closed)", bahtCell(bs.netIncomeToDate)]);
  ws.addRow(["", "Total equity", bahtCell(bs.totalEquity)]).font = { bold: true };
  ws.addRow([]);
  ws.addRow(["", bs.balanced ? "Assets = Liabilities + Equity (in balance)" : "OUT OF BALANCE"]);
  ws.columns = [{ width: 10 }, { width: 44 }, { width: 18 }];
  money(ws, [3]);
  return wb.xlsx.writeBuffer();
}
