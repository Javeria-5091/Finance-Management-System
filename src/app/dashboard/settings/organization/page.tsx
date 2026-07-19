'use client';

import { useState, useEffect } from 'react';
import { Building2, Save, Check } from 'lucide-react';
import { getOrgConfig, updateOrgConfig } from '@/types/services/org-config.service';
import type { OrganizationConfig } from '@/types/accounting.types';

const TIMEZONES = ['Asia/Karachi', 'Asia/Dubai', 'America/New_York', 'UTC'];
const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
const NUMBER_FORMATS = ['en-PK', 'en-US', 'en-GB'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const ROUNDING_METHODS = ['HALF_UP', 'HALF_DOWN', 'CEILING', 'FLOOR'];

export default function OrganizationSettingsPage() {
  const [config, setConfig] = useState<OrganizationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newCurrency, setNewCurrency] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const data = await getOrgConfig();
      setConfig(data);
    } catch (error) {
      console.error('Failed to load org config:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!config) return;
    try {
      setSaving(true);
      await updateOrgConfig(config.id, config);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      console.error('Failed to save:', error);
      alert('Failed to save organization settings');
    } finally {
      setSaving(false);
    }
  };

  const addCurrency = () => {
    if (!newCurrency || !config) return;
    if (config.enabled_currencies.includes(newCurrency.toUpperCase())) return;
    setConfig({
      ...config,
      enabled_currencies: [...config.enabled_currencies, newCurrency.toUpperCase()],
    });
    setNewCurrency('');
  };

  const removeCurrency = (currency: string) => {
    if (!config || currency === config.base_currency) return;
    setConfig({
      ...config,
      enabled_currencies: config.enabled_currencies.filter((c) => c !== currency),
    });
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-center py-20 text-gray-400 dark:text-gray-500">Loading organization settings...</div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="p-6">
        <div className="text-center py-20 text-red-500 dark:text-red-400">Failed to load organization configuration</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Building2 className="w-6 h-6 text-gray-500 dark:text-gray-400" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Organization Settings</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Configure your organization&apos;s financial settings</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            saved
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-blue-600 text-white hover:bg-blue-700 dark:hover:bg-blue-800'
          }`}
        >
          {saved ? (
            <>
              <Check className="w-4 h-4" />
              Saved!
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Changes'}
            </>
          )}
        </button>
      </div>

      {/* Settings Card */}
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
        {/* General Section */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">General</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Organization Name</label>
              <input
                type="text"
                value={config.org_name}
                onChange={(e) => setConfig({ ...config, org_name: e.target.value })}
                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Base Currency</label>
                <select
                  value={config.base_currency}
                  onChange={(e) => setConfig({ ...config, base_currency: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                >
                  {config.enabled_currencies.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Decimal Precision</label>
                <input
                  type="number"
                  min={0}
                  max={6}
                  value={config.decimal_precision}
                  onChange={(e) => setConfig({ ...config, decimal_precision: parseInt(e.target.value) || 2 })}
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Enabled Currencies</label>
              <div className="flex flex-wrap gap-2 mb-2">
                {config.enabled_currencies.map((c) => (
                  <span
                    key={c}
                    className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm ${
                      c === config.base_currency
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {c}
                    {c !== config.base_currency && (
                      <button
                        onClick={() => removeCurrency(c)}
                        className="ml-1 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newCurrency}
                  onChange={(e) => setNewCurrency(e.target.value.toUpperCase())}
                  className="w-24 px-3 py-1.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                  placeholder="EUR"
                  maxLength={3}
                />
                <button
                  onClick={addCurrency}
                  className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                >
                  Add
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Timezone</label>
                <select
                  value={config.timezone}
                  onChange={(e) => setConfig({ ...config, timezone: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date Format</label>
                <select
                  value={config.date_format}
                  onChange={(e) => setConfig({ ...config, date_format: e.target.value })}
                  className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
                >
                  {DATE_FORMATS.map((df) => (
                    <option key={df} value={df}>{df}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Number Format</label>
              <select
                value={config.number_format}
                onChange={(e) => setConfig({ ...config, number_format: e.target.value })}
                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
              >
                {NUMBER_FORMATS.map((nf) => (
                  <option key={nf} value={nf}>{nf}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Fiscal Year Configuration */}
        <div className="p-6 border-b border-gray-200 dark:border-gray-700 bg-amber-50/50 dark:bg-amber-900/10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Fiscal Year Configuration</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Month</label>
              <select
                value={config.fiscal_year_start_month}
                onChange={(e) =>
                  setConfig({ ...config, fiscal_year_start_month: parseInt(e.target.value) })
                }
                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
              >
                {MONTHS.map((m, i) => (
                  <option key={i} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">End Month</label>
              <select
                value={config.fiscal_year_end_month}
                onChange={(e) =>
                  setConfig({ ...config, fiscal_year_end_month: parseInt(e.target.value) })
                }
                className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
              >
                {MONTHS.map((m, i) => (
                  <option key={i} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
            ⚠ Changing this affects future fiscal years only
          </p>
        </div>

        {/* Rounding */}
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Rounding</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Method</label>
            <select
              value={config.rounding_method}
              onChange={(e) =>
                setConfig({
                  ...config,
                  rounding_method: e.target.value as OrganizationConfig['rounding_method'],
                })
              }
              className="w-full px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-600"
            >
              {ROUNDING_METHODS.map((rm) => (
                <option key={rm} value={rm}>{rm}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}