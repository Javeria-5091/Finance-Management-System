import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { CurrentPeriod } from "@/types/accounting.types";

export function useFiscalPeriod() {
  const [currentPeriod, setCurrentPeriod] = useState<CurrentPeriod | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.rpc("get_current_period").then(({ data }) => {
      setCurrentPeriod(data?.[0] || null);
      setLoading(false);
    });
  }, []);

  return { currentPeriod, loading };
}