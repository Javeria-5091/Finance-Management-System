"use client";
import { Menu, Bell } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

interface TopNavbarProps {
  onMenuClick: () => void;
}

export default function TopNavbar({ onMenuClick }: TopNavbarProps) {
  const { user } = useAuth();
  const initials = user?.email ? user.email[0].toUpperCase() : "U";

  return (
    <header className="sticky top-0 z-30 h-16 bg-gray-900/80 backdrop-blur-md border-b border-gray-800 flex items-center justify-between px-4 lg:px-6">
      <div className="flex items-center gap-3">
        <button onClick={onMenuClick} className="lg:hidden text-gray-400 hover:text-white"><Menu size={22} /></button>
        <h1 className="text-lg font-semibold text-white">Finance Overview</h1>
      </div>
      
      <div className="flex items-center gap-3">
        <button className="relative p-2 text-gray-400 hover:text-white transition-colors">
          <Bell size={20} />
          <span className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full"></span>
        </button>
        <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-bold">
          {initials}
        </div>
      </div>
    </header>
  );
}