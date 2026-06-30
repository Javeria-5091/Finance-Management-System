"use client";
import { useAuth } from "@/context/AuthContext";
import Link from "next/link";

export default function DashboardPage() {
  const { user } = useAuth();

  return (
    <div>
      <h2 className="text-2xl font-bold text-white mb-2">Welcome back! 👋</h2>
      <p className="text-gray-400 mb-8">Logged in as: <span className="text-blue-400">{user?.email}</span></p>
      
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 text-center">
        <h3 className="text-lg font-medium text-white mb-2">Ready to track your finances?</h3>
        <p className="text-gray-400 mb-4">Start by adding your first income entry.</p>
        <Link href="/dashboard/income" className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-lg font-medium transition-colors">
          Go to Income
        </Link>
      </div>
    </div>
  );
}