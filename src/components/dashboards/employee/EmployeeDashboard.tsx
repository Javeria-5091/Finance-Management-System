'use client';
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";

export function EmployeeDashboard() {
  const { user } = useAuth();
  const [myExpenses, setMyExpenses] = useState<any[]>([]);

  useEffect(() => {
    if(!user) return;
    // RLS sirf uski expenses degi
    supabase.from("expenses").select("*").eq("created_by", user.id).then(res => {
      if(res.data) setMyExpenses(res.data);
    });
  }, [user]);

  const pending = myExpenses.filter(e => e.status === 'DRAFT' || e.status === 'SUBMITTED').length;

  return (
    <div className="p-6 bg-gray-50 min-h-screen">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">My Dashboard</h1>
      <div className="bg-white p-6 rounded-xl shadow-sm border max-w-md">
        <h3 className="font-semibold text-gray-700">Expense Summary</h3>
        <p className="text-3xl font-bold text-orange-500 mt-2">{pending}</p>
        <p className="text-sm text-gray-500">Pending Approvals</p>
      </div>
    </div>
  );
}