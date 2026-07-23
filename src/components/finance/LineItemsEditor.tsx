"use client";
import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";

interface LineItem {
  id: string;
  account_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  withholding_rate: number;
  tax_amount: number;
  withholding_amount: number;
  line_total: number;
  project_id: string | null;
}

interface LineItemsEditorProps {
  accounts: { id: string; code: string; name: string; normal_balance: string }[];
  initialLines?: LineItem[];
  currency?: string;
  exchangeRate?: number;
  onChange: (lines: LineItem[]) => void;
  readOnly?: boolean;
}

function createEmptyLine(): LineItem {
  return {
    id: crypto.randomUUID(),
    account_id: "",
    description: "",
    quantity: 1,
    unit_price: 0,
    tax_rate: 0,
    withholding_rate: 0,
    tax_amount: 0,
    withholding_amount: 0,
    line_total: 0,
    project_id: null,
  };
}

function recalcLine(line: LineItem, exchangeRate: number): LineItem {
  const qty = parseFloat(String(line.quantity)) || 0;
  const price = parseFloat(String(line.unit_price)) || 0;
  const taxRate = parseFloat(String(line.tax_rate)) || 0;
  const whtRate = parseFloat(String(line.withholding_rate)) || 0;

  const basePrice = qty * price;
  const taxAmt = basePrice * taxRate / 100;
  const whtAmt = basePrice * whtRate / 100;

  // line_total stores value in ORIGINAL currency (not base)
  // Parent multiplies by exchangeRate when needed for display
  return {
    ...line,
    tax_amount: taxAmt,
    withholding_amount: whtAmt,
    line_total: basePrice + taxAmt + whtAmt,
  };
}

export default function LineItemsEditor({
  accounts,
  initialLines = [],
  currency = "PKR",
  exchangeRate = 1,
  onChange,
  readOnly = false,
}: LineItemsEditorProps) {
  const [lines, setLines] = useState<LineItem[]>(
    initialLines.length > 0 ? initialLines.map((l) => recalcLine(l, exchangeRate)) : [createEmptyLine()]
  );

  // Sync parent ONLY when lines actually change — no infinite loops
  useEffect(() => {
    onChange(lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  // Re-sync if initialLines prop changes externally
  useEffect(() => {
    if (initialLines.length > 0) {
      setLines(initialLines.map((l) => recalcLine(l, exchangeRate)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLines]);

  const updateLine = useCallback(
    (index: number, field: keyof LineItem, value: string | number) => {
      setLines((prev) => {
        const updated = prev.map((l, i) => (i === index ? { ...l, [field]: value } : l));
        updated[index] = recalcLine(updated[index], exchangeRate);
        return updated;
      });
    },
    [exchangeRate]
  );

  const addLine = useCallback(() => {
    setLines((prev) => [...prev, createEmptyLine()]);
  }, []);

  const removeLine = useCallback((index: number) => {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }, []);

  // Totals in BASE currency
  const toBase = (val: number) => val * exchangeRate;
  const baseSubtotal = lines.reduce((s, l) => s + toBase(l.quantity * l.unit_price), 0);
  const baseTaxTotal = lines.reduce((s, l) => s + toBase(l.tax_amount), 0);
  const baseWhtTotal = lines.reduce((s, l) => s + toBase(l.withholding_amount), 0);
  const baseGrandTotal = lines.reduce((s, l) => s + toBase(l.line_total), 0);

  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-3">
      {/* Summary Bar */}
      <div className="bg-gray-50 dark:bg-gray-900/30 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
        <div className="flex flex-wrap justify-between items-center text-xs font-medium text-gray-600 dark:text-gray-400 gap-2">
          <span>Line Items ({lines.length})</span>
          <div className="flex gap-4">
            <span>Subtotal: <strong className="text-gray-900 dark:text-white">{fmt(baseSubtotal)}</strong></span>
            <span>Tax: <strong className="text-gray-900 dark:text-white">{fmt(baseTaxTotal)}</strong></span>
            <span>WHT: <strong className="text-gray-900 dark:text-white">{fmt(baseWhtTotal)}</strong></span>
            <span>Grand Total: <strong className="text-blue-600 dark:text-blue-400">{fmt(baseGrandTotal)}</strong></span>
            <span className="text-gray-400">({currency} × {exchangeRate})</span>
          </div>
        </div>
      </div>

      {/* Header Row — 13 columns to match data rows */}
      <div className="hidden lg:grid lg:grid-cols-13 gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 px-2 pb-2 border-b dark:border-gray-700">
        <div className="col-span-3">Account (Expense)</div>
        <div className="col-span-2">Description</div>
        <div className="col-span-1 text-right">Qty</div>
        <div className="col-span-1 text-right">Unit Price</div>
        <div className="col-span-1 text-center">Tax %</div>
        <div className="col-span-1 text-right">Tax Amt</div>
        <div className="col-span-1 text-center">WHT %</div>
        <div className="col-span-1 text-right">WHT Amt</div>
        <div className="col-span-1 text-right">Total</div>
        <div className="col-span-1"></div>
      </div>

      {/* Data Rows */}
      <div className="space-y-2">
        {lines.map((line, index) => (
          <div
            key={line.id}
            className="grid grid-cols-2 lg:grid-cols-13 gap-2 items-center p-2 rounded-lg bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700/50 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
          >
            {/* Account */}
            <div className="col-span-2 lg:col-span-3">
              <select
                value={line.account_id}
                onChange={(e) => updateLine(index, "account_id", e.target.value)}
                disabled={readOnly}
                className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-shadow"
              >
                <option value="">Select Account...</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.code} - {acc.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Description */}
            <div className="col-span-2 lg:col-span-2">
              <input
                type="text"
                value={line.description}
                onChange={(e) => updateLine(index, "description", e.target.value)}
                disabled={readOnly}
                placeholder="Description"
                className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-shadow"
              />
            </div>

            {/* Qty */}
            <div className="col-span-1">
              <input
                type="number"
                value={line.quantity}
                onChange={(e) => updateLine(index, "quantity", e.target.value)}
                disabled={readOnly}
                min="0"
                className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs text-right focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-shadow"
              />
            </div>

            {/* Unit Price */}
            <div className="col-span-1">
              <input
                type="number"
                value={line.unit_price}
                onChange={(e) => updateLine(index, "unit_price", e.target.value)}
                disabled={readOnly}
                min="0"
                step="0.01"
                className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs text-right focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-shadow"
              />
            </div>

            {/* Tax % */}
            <div className="col-span-1">
              <input
                type="number"
                value={line.tax_rate}
                onChange={(e) => updateLine(index, "tax_rate", e.target.value)}
                disabled={readOnly}
                placeholder="0"
                min="0"
                max="100"
                step="0.1"
                className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs text-center focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-shadow"
              />
            </div>

            {/* Tax Amount (read-only) */}
            <div className="col-span-1 flex items-center justify-end">
              <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                {fmt(toBase(line.tax_amount))}
              </span>
            </div>

            {/* WHT % */}
            <div className="col-span-1">
              <input
                type="number"
                value={line.withholding_rate}
                onChange={(e) => updateLine(index, "withholding_rate", e.target.value)}
                disabled={readOnly}
                placeholder="0"
                min="0"
                max="100"
                step="0.1"
                className="w-full p-2 border dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs text-center focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-shadow"
              />
            </div>

            {/* WHT Amount (read-only) */}
            <div className="col-span-1 flex items-center justify-end">
              <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                {fmt(toBase(line.withholding_amount))}
              </span>
            </div>

            {/* Line Total (read-only) */}
            <div className="col-span-1 flex items-center justify-end">
              <span className="text-xs font-semibold text-gray-900 dark:text-white tabular-nums">
                {fmt(toBase(line.line_total))}
              </span>
            </div>

            {/* Delete Button */}
            <div className="col-span-1 flex items-center justify-end">
              {!readOnly && lines.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeLine(index)}
                  className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                  title="Remove line"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Add Line Button */}
      {!readOnly && (
        <button
          type="button"
          onClick={addLine}
          className="w-full py-2.5 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-500 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all duration-200 flex items-center justify-center gap-2"
        >
          <Plus size={16} /> Add Line Item
        </button>
      )}
    </div>
  );
}