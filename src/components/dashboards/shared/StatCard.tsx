import { LucideIcon } from "lucide-react";

interface StatCardProps {
  title: string;
  value: string;
  color: string;
  bg: string;
  icon: LucideIcon;
  isDark: boolean;
}

export function StatCard({ title, value, color, bg, icon: Icon, isDark }: StatCardProps) {
  return (
    <div className={`rounded-xl p-4 group transition-all border ${isDark ? 'bg-gray-900/60 border-gray-800 hover:border-gray-700' : 'bg-white border-gray-200 hover:border-gray-300 shadow-sm hover:shadow-md'}`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-[10px] uppercase tracking-wider font-bold ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{title}</p>
        <div className={`p-1.5 rounded-lg ${bg}`}><Icon className={`w-3.5 h-3.5 ${color}`} /></div>
      </div>
      <p className={`text-lg font-extrabold tracking-tight ${color}`}>{value}</p>
    </div>
  );
}