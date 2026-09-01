'use client';
import { useState, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useImportBankStatement } from '@/hooks/useBanking';
import { Upload, FileText, Loader2, AlertCircle, CheckCircle } from 'lucide-react';

interface Props {
  accountId: string;
  currency: string;
  onSuccess: () => void;
}

interface ParseResult {
  valid: boolean;
  lines: any[];
  errors: string[];
  totalDebits: number;
  totalCredits: number;
  rowCount: number;
}

// FND-BANK-03 FIX: the previous parser did `lines[i].split(',')` per
// text line, which breaks on any quoted field containing a comma (e.g.
// a description like `"Doe, John - salary"`) and on CRLF exports (a
// trailing \r ended up glued onto the last column). This is a small
// RFC4180-ish tokenizer: handles quoted fields, embedded commas,
// embedded newlines inside quotes, escaped `""` quotes, and CRLF/LF
// line endings.
function parseCSVRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    minimumFractionDigits: 0,
  }).format(amount);
}

export default function StatementImport({ accountId, currency, onSuccess }: Props) {
  const { user } = useAuth();
  const importStatement = useImportBankStatement();

  const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload');
  const [isImporting, setIsImporting] = useState(false);  // ✅ Separate state
  const [fileName, setFileName] = useState('');
  const [statementDate, setStatementDate] = useState(new Date().toISOString().split('T')[0]);
  const [openingBalance, setOpeningBalance] = useState('');
  const [closingBalance, setClosingBalance] = useState('');
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [parsedLines, setParsedLines] = useState<any[]>([]);
  const [importSummary, setImportSummary] = useState<{
    lines_inserted: number;
    duplicates_skipped: number;
  } | null>(null);
  const [error, setError] = useState('');

  const parseCSV = useCallback((text: string): ParseResult => {
    const rows = parseCSVRows(text);
    const errors: string[] = [];
    const result: any[] = [];
    let totalDebits = 0;
    let totalCredits = 0;

    for (let i = 1; i < rows.length; i++) {
      const parts = rows[i].map((s) => s.trim());
      if (parts.length < 4) {
        errors.push(`Row ${i + 1}: Not enough columns`);
        continue;
      }

      const [dateStr, desc, ref, amountStr, balanceStr] = parts;
      const amount = parseFloat((amountStr || '').replace(/[^0-9.-]/g, ''));

      if (isNaN(amount)) {
        errors.push(`Row ${i + 1}: Invalid amount "${amountStr}"`);
        continue;
      }

      if (!dateStr || isNaN(new Date(dateStr).getTime())) {
        errors.push(`Row ${i + 1}: Invalid date "${dateStr}"`);
        continue;
      }

      if (amount > 0) totalDebits += amount;
      else totalCredits += Math.abs(amount);

      result.push({
        bank_statement_id: '',
        line_number: i,
        transaction_date: dateStr,
        description: desc || null,
        reference: ref || null,
        counterparty: null,
        transaction_identifier: null,
        amount,
        balance_after: balanceStr ? parseFloat(balanceStr.replace(/[^0-9.-]/g, '')) : null,
        reconciliation_status: 'UNRECONCILED',
      });
    }

    return {
      valid: errors.length === 0 && result.length > 0,
      lines: result,
      errors,
      totalDebits,
      totalCredits,
      rowCount: result.length,
    };
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setError('');

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const result = parseCSV(text);
      setParseResult(result);
      setParsedLines(result.lines);

      if (result.valid) {
        setStep('preview');
        if (result.lines.length > 0) {
          setStatementDate(result.lines[0].transaction_date);
        }
      } else {
        setError(result.errors.join('\n'));
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!user?.id || !openingBalance || !closingBalance) {
      setError('Opening and closing balances are required');
      return;
    }

    setIsImporting(true);  // ✅ Use separate state
    setError('');

    try {
      // FND-BANK-03 FIX: one atomic RPC call instead of a create-
      // statement-then-batch-insert-lines flow. organization_id is
      // resolved server-side (never sent from here), the header and
      // every line commit in a single DB transaction, and duplicate
      // lines from a repeat import are skipped rather than duplicated.
      const { data, error: importErr } = await importStatement.mutateAsync({
        financial_account_id: accountId,
        statement_date: statementDate,
        opening_balance: parseFloat(openingBalance),
        closing_balance: parseFloat(closingBalance),
        currency,
        file_name: fileName,
        lines: parsedLines.map((l) => ({
          transaction_date: l.transaction_date,
          description: l.description,
          reference: l.reference,
          counterparty: l.counterparty,
          transaction_identifier: l.transaction_identifier,
          amount: l.amount,
          balance_after: l.balance_after,
        })),
      });

      if (importErr) throw new Error(importErr.message);

      setImportSummary(data);
      setStep('done');
      onSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsImporting(false);  // ✅ Always reset
    }
  };

  const inputCls =
    'w-full px-3 py-2 border dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm outline-none focus:ring-2 focus:ring-blue-500';
  const labelCls = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  if (step === 'done') {
    return (
      <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30 rounded-xl p-8 text-center">
        <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-3" />
        <h3 className="text-lg font-bold text-green-700 dark:text-green-400">Import Complete!</h3>
        <p className="text-sm text-green-600 dark:text-green-400 mt-1">
          {importSummary ? importSummary.lines_inserted : parsedLines.length} lines imported from {fileName}
        </p>
        {!!importSummary?.duplicates_skipped && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            {importSummary.duplicates_skipped} line(s) were already imported previously and were skipped.
          </p>
        )}
        <button
          onClick={() => {
            setStep('upload');
            setParseResult(null);
            setParsedLines([]);
            setFileName('');
            setImportSummary(null);
          }}
          className="mt-4 text-sm text-green-700 dark:text-green-400 underline hover:no-underline"
        >
          Import another statement
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl p-5 space-y-4">
      <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
        <Upload className="w-4 h-4" /> Import Bank Statement (CSV)
      </h3>

      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/30 rounded-lg p-3">
        <p className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-1">Expected CSV Format:</p>
        <code className="text-[11px] text-blue-600 dark:text-blue-400 font-mono">
          Date, Description, Reference, Amount, Balance
        </code>
        <p className="text-[10px] text-blue-500 dark:text-blue-400 mt-1">
          Amount: positive = debit/in, negative = credit/out. Header row will be skipped.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-lg p-3">
          <p className="text-xs text-red-700 dark:text-red-400 font-medium flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5" /> Error
          </p>
          <pre className="text-[11px] text-red-600 dark:text-red-400 mt-1 whitespace-pre-wrap">{error}</pre>
        </div>
      )}

      {step === 'upload' && (
        <div className="border-2 border-dashed dark:border-gray-600 rounded-lg p-8 text-center">
          <FileText className="w-10 h-10 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
          <label className="cursor-pointer">
            <span className="text-sm text-blue-600 dark:text-blue-400 font-medium hover:underline">
              Click to select CSV file
            </span>
            <input type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
          </label>
          <p className="text-xs text-gray-400 mt-2">CSV files only</p>
        </div>
      )}

      {step === 'preview' && parseResult && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className={labelCls}>File</label>
              <p className="text-sm text-gray-900 dark:text-white truncate">{fileName}</p>
            </div>
            <div>
              <label className={labelCls}>Statement Date *</label>
              <input
                type="date"
                value={statementDate}
                onChange={(e) => setStatementDate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Opening Balance *</label>
              <input
                type="number"
                step="0.01"
                value={openingBalance}
                onChange={(e) => setOpeningBalance(e.target.value)}
                className={inputCls}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className={labelCls}>Closing Balance *</label>
              <input
                type="number"
                step="0.01"
                value={closingBalance}
                onChange={(e) => setClosingBalance(e.target.value)}
                className={inputCls}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3 grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-xs text-gray-400 dark:text-gray-500">Rows</p>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{parseResult.rowCount}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400 dark:text-gray-500">Total Debits</p>
              <p className="text-lg font-bold text-green-600 dark:text-green-400">
                {formatCurrency(parseResult.totalDebits)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400 dark:text-gray-500">Total Credits</p>
              <p className="text-lg font-bold text-red-600 dark:text-red-400">
                {formatCurrency(parseResult.totalCredits)}
              </p>
            </div>
          </div>

          <div className="border dark:border-gray-700 rounded-lg overflow-hidden max-h-40 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">Date</th>
                  <th className="px-2 py-2 text-left">Description</th>
                  <th className="px-2 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {parsedLines.slice(0, 5).map((l, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1.5 text-gray-400">{i + 1}</td>
                    <td className="px-2 py-1.5 text-gray-700 dark:text-gray-300">{l.transaction_date}</td>
                    <td className="px-2 py-1.5 text-gray-700 dark:text-gray-300 truncate max-w-[150px]">{l.description}</td>
                    <td className={`px-2 py-1.5 text-right font-medium ${l.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {formatCurrency(l.amount)}
                    </td>
                  </tr>
                ))}
                {parsedLines.length > 5 && (
                  <tr>
                    <td colSpan={4} className="px-2 py-1.5 text-center text-gray-400">
                      ... and {parsedLines.length - 5} more rows
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end gap-3">
            <button
              onClick={() => {
                setStep('upload');
                setParseResult(null);
                setParsedLines([]);
                setFileName('');
              }}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-white rounded-lg text-sm"
            >
              Back
            </button>
            <button
              onClick={handleImport}
              disabled={isImporting || !openingBalance || !closingBalance}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-2"
            >
              {isImporting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {isImporting ? 'Importing...' : `Import ${parsedLines.length} Lines`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}