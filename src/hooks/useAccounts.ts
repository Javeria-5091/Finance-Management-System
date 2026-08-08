import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { PostableAccount } from "@/types/accounting.types";

export function useAccounts(accountType?: string | string[]) {
  const [accounts, setAccounts] = useState<PostableAccount[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // FIXED: Add finance schema — table lives in finance.postable_accounts
    let query = supabase.schema("finance").from("postable_accounts").select("*").order("code");
    
    if (accountType) {
      if (Array.isArray(accountType)) {
        query = query.in("account_type", accountType);
      } else {
        query = query.eq("account_type", accountType);
      }
    }
    
    query.then(({ data, error }) => {
      if (error) console.error("Accounts fetch error:", error.message);
      setAccounts((data as PostableAccount[]) || []);
      setLoading(false);
    });
  }, [accountType]);

  return { accounts, loading };
}
