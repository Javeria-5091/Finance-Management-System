"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

export interface KPICardProps {
  label: string;
  value: string;
  change?: number;
  changeLabel?: string;
  sparklineData?: number[];
  color?: "green" | "red" | "blue" | "amber" | "purple" | "gray";
  icon?: React.ReactNode;
  onClick?: () => void;
}

const colorMap = {
  green: {
    bg: "bg-emerald-50 dark:bg-emerald-900/20",
    border: "border-emerald-200 dark:border-emerald-800/30",
    text: "text-emerald-700 dark:text-emerald-400",
    iconBg: "bg-emerald-100 dark:bg-emerald-900/40",
    stroke: "#10b981",
    fill: "#10b981",
  },
  red: {
    bg: "bg-red-50 dark:bg-red-900/20",
    border: "border-red-200 dark:border-red-800/30",
    text: "text-red-700 dark:text-red-400",
    iconBg: "bg-red-100 dark:bg-red-900/40",
    stroke: "#ef4444",
    fill: "#ef4444",
  },
  blue: {
    bg: "bg-blue-50 dark:bg-blue-900/20",
    border: "border-blue-200 dark:border-blue-800/30",
    text: "text-blue-700 dark:text-blue-400",
    iconBg: "bg-blue-100 dark:bg-blue-900/40",
    stroke: "#3b82f6",
    fill: "#3b82f6",
  },
  amber: {
    bg: "bg-amber-50 dark:bg-amber-900/20",
    border: "border-amber-200 dark:border-amber-800/30",
    text: "text-amber-700 dark:text-amber-400",
    iconBg: "bg-amber-100 dark:bg-amber-900/40",
    stroke: "#f59e0b",
    fill: "#f59e0b",
  },
  purple: {
    bg: "bg-purple-50 dark:bg-purple-900/20",
    border: "border-purple-200 dark:border-purple-800/30",
    text: "text-purple-700 dark:text-purple-400",
    iconBg: "bg-purple-100 dark:bg-purple-900/40",
    stroke: "#8b5cf6",
    fill: "#8b5cf6",
  },
  gray: {
    bg: "bg-gray-50 dark:bg-gray-800",
    border: "border-gray-200 dark:border-gray-700",
    text: "text-gray-700 dark:text-gray-300",
    iconBg: "bg-gray-100 dark:bg-gray-700",
    stroke: "#6b7280",
    fill: "#6b7280",
  },
};

export default function KPICard({
  label,
  value,
  change,
  changeLabel,
  sparklineData,
  color = "blue",
  icon,
  onClick,
}: KPICardProps) {
  const c = colorMap[color];
  const isPositive = change !== undefined && change > 0;
  const isNegative = change !== undefined && change < 0;
  const isNeutral = change === undefined || change === 0;

  const sparkData = sparklineData?.map((v, i) => ({ v, i })) || [];

  return (
    <div
      onClick={onClick}
      className={`relative overflow-hidden rounded-xl border p-4 transition-all ${
        onClick ? "cursor-pointer hover:shadow-md" : ""
      } ${c.bg} ${c.border}`}
    >
      {/* Sparkline background */}
      {sparkData.length > 1 && (
        <div className="absolute bottom-0 left-0 right-0 h-16 opacity-20">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData}>
              <defs>
                <linearGradient id={`spark-${color}-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={c.fill} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={c.fill} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={c.stroke}
                strokeWidth={1.5}
                fill={`url(#spark-${color}-${label})`}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="relative">
        <div className="flex items-start justify-between mb-2">
          <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">
            {label}
          </p>
          {icon && (
            <div className={`w-8 h-8 rounded-lg ${c.iconBg} flex items-center justify-center`}>{icon}</div>
          )}
        </div>
        <p className={`text-xl font-bold ${c.text} tracking-tight`}>{value}</p>
        {(isPositive || isNegative || isNeutral) && (
          <div className="flex items-center gap-1 mt-1.5">
            {isPositive && <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />}
            {isNegative && <TrendingDown className="w-3.5 h-3.5 text-red-500" />}
            {isNeutral && <Minus className="w-3.5 h-3.5 text-gray-400" />}
            {change !== undefined && (
              <span
                className={`text-xs font-semibold ${
                  isPositive
                    ? "text-emerald-600"
                    : isNegative
                    ? "text-red-500"
                    : "text-gray-400"
                }`}
              >
                {isPositive ? "+" : ""}
                {change.toFixed(1)}%
              </span>
            )}
            {changeLabel && (
              <span className="text-[10px] text-gray-400">{changeLabel}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
