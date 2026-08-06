"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { useAssetCategories, useCreateFixedAsset, useUpdateFixedAsset, useNextAssetCode } from "@/hooks/useFixedAssets";
import type { FixedAsset, FixedAssetFormInput } from "@/types/fixed-assets.types";
import { financeDB } from "@/lib/supabase";
import { useQuery } from "@tanstack/react-query";
import { logAudit } from "@/lib/logAction";
import toast from "react-hot-toast";

// =============================================================================
// AssetForm — Create / Edit Fixed Asset Modal
// Convention: P0 style — raw HTML + Tailwind, no shadcn
// File: src/components/sections/AssetForm.tsx
// =============================================================================

interface AssetFormProps {
  asset?: FixedAsset | null;
  onClose: () => void;
  onSuccess: () => void;
}

const EMPTY_FORM: FixedAssetFormInput = {
  code: "",
  name: "",
  category_id: "",
  description: "",
  purchase_date: "",
  purchase_cost: 0,
  currency_id: "PKR",
  base_cost: 0,
  serial_number: "",
  warranty_start: "",
  warranty_end: "",
  location: "",
  linked_asset_account_id: "",
  linked_depreciation_account_id: "",
  linked_expense_account_id: "",
};

export default function AssetForm({ asset, onClose, onSuccess }: AssetFormProps) {
  const { user } = useAuth();
  const { isDark } = useTheme();
  const isEdit = !!asset;

  const [form, setForm] = useState<FixedAssetFormInput>(EMPTY_FORM);

  const { data: categories = [], isLoading: catLoading } = useAssetCategories();
  const { data: nextCode } = useNextAssetCode();
  const createMut = useCreateFixedAsset();
  const updateMut = useUpdateFixedAsset();

  // Fetch chart of accounts for linked account dropdowns
  const { data: accounts = [], isLoading: accLoading } = useQuery({
    queryKey: ["coa-asset-dropdown"],
    queryFn: async () => {
      const { data, error } = await financeDB
        .from("chart_of_accounts")
        .select("id, code, name")
        .eq("is_active", true)
        .order("code");
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 60000,
  });

  // Populate form for edit mode, or set auto-generated code for create mode
  useEffect(() => {
    if (isEdit && asset) {
      setForm({
        code: asset.code,
        name: asset.name,
        category_id: asset.category_id,
        description: asset.description || "",
        purchase_date: asset.purchase_date,
        purchase_cost: asset.purchase_cost,
        currency_id: (asset as unknown as Record<string, unknown>).currency as string || "PKR",
        base_cost: asset.base_cost,
        serial_number: asset.serial_number || "",
        warranty_start: asset.warranty_start || "",
        warranty_end: asset.warranty_end || "",
        location: asset.location || "",
        linked_asset_account_id: asset.linked_asset_account_id || "",
        linked_depreciation_account_id: asset.linked_depreciation_account_id || "",
        linked_expense_account_id: asset.linked_expense_account_id || "",
      });
    } else if (nextCode) {
      setForm((f) => ({ ...f, code: nextCode }));
    }
  }, [isEdit, asset, nextCode]);

  // Auto-fill accounts from selected category
  const handleCategoryChange = (categoryId: string) => {
    const cat = categories.find((c) => c.id === categoryId);
    if (cat) {
      setForm((f) => ({
        ...f,
        category_id: categoryId,
        linked_asset_account_id: cat.linked_asset_account_id || "",
        linked_depreciation_account_id: cat.linked_depreciation_account_id || "",
        linked_expense_account_id: cat.linked_expense_account_id || "",
      }));
    } else {
      setForm((f) => ({ ...f, category_id: categoryId }));
    }
  };

  const handleChange = (field: keyof FixedAssetFormInput, value: string | number) => {
    setForm((f) => ({ ...f, [field]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user?.id) return;

    if (!form.name.trim() || !form.category_id || !form.purchase_date || !form.purchase_cost || !form.base_cost) {
      toast.error("Please fill all required fields (Name, Category, Date, Cost, Base Cost)");
      return;
    }

    if (isEdit && asset) {
      updateMut.mutate(
        { id: asset.id, input: form },
        {
          onSuccess: () => {
            toast.success("Asset updated successfully");
            logAudit.update("fixed_assets", asset.id, "Asset details updated");
            onSuccess();
            onClose();
          },
          onError: (err: Error) => toast.error(err.message),
        }
      );
    } else {
      createMut.mutate(
        { input: form, userId: user.id },
        {
          onSuccess: (data: any) => {
            toast.success("Asset created successfully");
            const newId = (data as Record<string, unknown> | undefined)?.id as string || "";
            logAudit.create("fixed_assets", newId, "New asset created");
            onSuccess();
            onClose();
          },
          onError: (err: Error) => toast.error(err.message),
        }
      );
    }
  };

  // ─── Reusable class strings ─────────────────────────────────────────────
  const inputCls = `w-full px-3 py-2 rounded-lg border text-sm ${
    isDark
      ? "bg-gray-800 border-gray-700 text-gray-100 placeholder-gray-500 focus:border-blue-500"
      : "bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-blue-500"
  } focus:outline-none focus:ring-1 focus:ring-blue-500`;

  const labelCls = `block text-sm font-medium mb-1 ${isDark ? "text-gray-300" : "text-gray-700"}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className={`w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl shadow-2xl p-6 ${
          isDark ? "bg-gray-900 border border-gray-700" : "bg-white border border-gray-200"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold">{isEdit ? "Edit Asset" : "Add New Asset"}</h2>
          <button
            onClick={onClose}
            className={`p-1 rounded-lg ${isDark ? "hover:bg-gray-800 text-gray-400" : "hover:bg-gray-100 text-gray-500"}`}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Row 1: Code + Name */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Asset Code</label>
              <input
                type="text"
                value={form.code}
                readOnly
                className={`${inputCls} opacity-60 cursor-not-allowed`}
              />
            </div>
            <div>
              <label className={labelCls}>Asset Name *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => handleChange("name", e.target.value)}
                className={inputCls}
                placeholder="e.g. Dell Latitude 5540"
                required
              />
            </div>
          </div>

          {/* Category */}
          <div>
            <label className={labelCls}>Category *</label>
            {catLoading ? (
              <div className={`text-sm py-2 ${isDark ? "text-gray-500" : "text-gray-400"}`}>Loading categories...</div>
            ) : categories.length === 0 ? (
              <div>
                <select className={`${inputCls} opacity-60 cursor-not-allowed`} disabled>
                  <option value="">-- No Categories Found --</option>
                </select>
                <p className={`text-xs mt-1 text-amber-500`}>
                  No asset categories exist. Please run the seed SQL first to create default categories.
                </p>
              </div>
            ) : (
              <select
                value={form.category_id}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className={inputCls}
                required
              >
                <option value="">-- Select Category --</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.code} — {cat.name}
                  </option>
                ))}
              </select>
            )}
            {form.category_id && (
              <p className={`text-xs mt-1 ${isDark ? "text-gray-500" : "text-gray-400"}`}>
                Useful life: {categories.find((c) => c.id === form.category_id)?.useful_life_months} months
                &middot; Residual: {categories.find((c) => c.id === form.category_id)?.residual_value_pct}%
                &middot; Method: {categories.find((c) => c.id === form.category_id)?.depreciation_method.replace(/_/g, " ")}
              </p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className={labelCls}>Description</label>
            <textarea
              value={form.description}
              onChange={(e) => handleChange("description", e.target.value)}
              className={inputCls}
              rows={2}
              placeholder="Optional description..."
            />
          </div>

          {/* Row: Purchase Date + Cost + Currency */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>Purchase Date *</label>
              <input
                type="date"
                value={form.purchase_date}
                onChange={(e) => handleChange("purchase_date", e.target.value)}
                className={inputCls}
                required
              />
            </div>
            <div>
              <label className={labelCls}>Purchase Cost *</label>
              <input
                type="number"
                value={form.purchase_cost || ""}
                onChange={(e) => handleChange("purchase_cost", Number(e.target.value))}
                className={inputCls}
                placeholder="0"
                min="0"
                step="0.01"
                required
              />
            </div>
            <div>
              <label className={labelCls}>Currency</label>
              <input
                type="text"
                value={form.currency_id}
                onChange={(e) => handleChange("currency_id", e.target.value)}
                className={inputCls}
                placeholder="PKR"
              />
            </div>
          </div>

          {/* Row: Base Cost + Serial Number */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Base Cost (PKR) *</label>
              <input
                type="number"
                value={form.base_cost || ""}
                onChange={(e) => handleChange("base_cost", Number(e.target.value))}
                className={inputCls}
                placeholder="0"
                min="0"
                step="0.01"
                required
              />
            </div>
            <div>
              <label className={labelCls}>Serial Number</label>
              <input
                type="text"
                value={form.serial_number}
                onChange={(e) => handleChange("serial_number", e.target.value)}
                className={inputCls}
                placeholder="Optional"
              />
            </div>
          </div>

          {/* Row: Warranty Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Warranty Start</label>
              <input
                type="date"
                value={form.warranty_start}
                onChange={(e) => handleChange("warranty_start", e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Warranty End</label>
              <input
                type="date"
                value={form.warranty_end}
                onChange={(e) => handleChange("warranty_end", e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          {/* Location */}
          <div>
            <label className={labelCls}>Location</label>
            <input
              type="text"
              value={form.location}
              onChange={(e) => handleChange("location", e.target.value)}
              className={inputCls}
              placeholder="e.g. Head Office, Room 204"
            />
          </div>

          {/* Linked Accounts Section */}
          <div className={`p-4 rounded-lg border ${isDark ? "border-gray-700 bg-gray-800/50" : "border-gray-200 bg-gray-50"}`}>
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-sm font-medium ${isDark ? "text-gray-300" : "text-gray-700"}`}>Linked Accounts</span>
              <span className={`text-xs px-2 py-0.5 rounded ${isDark ? "bg-gray-700 text-gray-400" : "bg-gray-200 text-gray-500"}`}>
                auto-filled from category
              </span>
            </div>
            {accLoading ? (
              <div className={`text-sm py-2 ${isDark ? "text-gray-500" : "text-gray-400"}`}>Loading accounts...</div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={labelCls}>Asset Account</label>
                  <select
                    value={form.linked_asset_account_id}
                    onChange={(e) => handleChange("linked_asset_account_id", e.target.value)}
                    className={inputCls}
                  >
                    <option value="">-- None --</option>
                    {accounts.map((acc: Record<string, unknown>) => (
                      <option key={acc.id as string} value={acc.id as string}>
                        {acc.code as string} — {acc.name as string}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Depreciation Account</label>
                  <select
                    value={form.linked_depreciation_account_id}
                    onChange={(e) => handleChange("linked_depreciation_account_id", e.target.value)}
                    className={inputCls}
                  >
                    <option value="">-- None --</option>
                    {accounts.map((acc: Record<string, unknown>) => (
                      <option key={acc.id as string} value={acc.id as string}>
                        {acc.code as string} — {acc.name as string}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Expense Account</label>
                  <select
                    value={form.linked_expense_account_id}
                    onChange={(e) => handleChange("linked_expense_account_id", e.target.value)}
                    className={inputCls}
                  >
                    <option value="">-- None --</option>
                    {accounts.map((acc: Record<string, unknown>) => (
                      <option key={acc.id as string} value={acc.id as string}>
                        {acc.code as string} — {acc.name as string}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Buttons */}
          <div className={`flex justify-end gap-3 pt-4 border-t ${isDark ? "border-gray-700" : "border-gray-200"}`}>
            <button
              type="button"
              onClick={onClose}
              className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                isDark
                  ? "border-gray-600 text-gray-300 hover:bg-gray-800"
                  : "border-gray-300 text-gray-700 hover:bg-gray-100"
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMut.isPending || updateMut.isPending}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {createMut.isPending || updateMut.isPending
                ? "Saving..."
                : isEdit
                ? "Update Asset"
                : "Create Asset"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
