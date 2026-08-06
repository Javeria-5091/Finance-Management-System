// ================================================================
// OSYSTIC Finance Management System — Payroll Hook (P1)
// ================================================================
// P0/P1 Convention: Custom hook for payroll data fetching
// Uses react-query pattern from existing codebase
// ================================================================

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";

// ─── Types ───
interface PayrollStats {
  activeEmployees: number;
  lastPayrollAmount: number;
  pendingAdvances: number;
  lastPayrollPeriod: string;
}

// ─── Main Payroll Hook ───
export function usePayroll() {
  const { user } = useAuth();
  const [stats, setStats] = useState<PayrollStats>({
    activeEmployees: 0,
    lastPayrollAmount: 0,
    pendingAdvances: 0,
    lastPayrollPeriod: "",
  });
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    if (!user) return;
    try {
      // Active employee count
      const { count: empCount } = await supabase
        .from("payroll_employees")
        .select("*", { count: "exact", head: true })
        .eq("status", "ACTIVE");

      // Last posted payroll run
      const { data: lastRun } = await supabase
        .from("payroll_runs")
        .select("payroll_period, total_net_pay")
        .eq("status", "POSTED")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      // Pending advance balance
      const { data: advances } = await supabase
        .from("payroll_advances")
        .select("remaining_balance")
        .in("approval_status", ["APPROVED", "PARTIALLY_RECOVERED"]);

      const pendingAdvances = (advances || []).reduce(
        (sum: number, a: any) => sum + Number(a.remaining_balance),
        0
      );

      setStats({
        activeEmployees: empCount || 0,
        lastPayrollAmount: (lastRun as any)?.total_net_pay || 0,
        pendingAdvances,
        lastPayrollPeriod: (lastRun as any)?.payroll_period || "",
      });
    } catch (err) {
      console.error("Failed to fetch payroll stats:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return { stats, loading, refetch: fetchStats };
}

// ─── Payroll Employees Hook ───
export function usePayrollEmployees(search?: string) {
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from("payroll_employees")
      .select("*")
      .order("created_at", { ascending: false });

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,employee_code.ilike.%${search}%,designation.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) console.error("Failed to fetch employees:", error.message);
    else setEmployees(data || []);
    setLoading(false);
  }, [search]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { employees, loading, refetch: fetch };
}

// ─── Payroll Runs Hook ───
export function usePayrollRuns() {
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("payroll_runs")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) console.error("Failed to fetch payroll runs:", error.message);
    else setRuns(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { runs, loading, refetch: fetch };
}