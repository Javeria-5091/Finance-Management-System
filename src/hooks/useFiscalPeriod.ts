import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { CurrentPeriod } from "@/types/accounting.types";

export function useFiscalPeriod() {
  const [currentPeriod, setCurrentPeriod] = useState<CurrentPeriod | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // FIXED: Add finance schema — RPC lives in finance schema
    supabase.schema("finance").rpc("get_current_period").then(({ data, error }) => {
      if (error) {
        console.error("Period fetch error:", error.message);
      }
      setCurrentPeriod(data?.[0] || null);
      setLoading(false);
    });
  }, []);

  return { currentPeriod, loading };
}
