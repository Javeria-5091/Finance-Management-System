import { supabase as browserSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';

// BUG-007 FIX: This service previously imported the browser supabase client
// directly. When called from an API route, the browser client has no
// authenticated session, causing RLS to reject queries or return wrong data.
//
// Each function below now accepts an optional `supabaseClient` parameter.
// API routes pass their server-side authenticated client (from getAuthSupabase());
// frontend code omits it and the browser client is used (with its valid session).
type SClient = SupabaseClient<any, any, any>;
function resolveClient(override?: SClient | null): SClient {
  return override || (browserSupabase as unknown as SClient);
}
// Backward-compat alias: existing function bodies
// continue to reference `supabase` directly.
const supabase = browserSupabase;
import type { OrganizationConfig } from '@/types/accounting.types';

// ⭐ Organization table 'core' schema mein hai
const SCHEMA = 'core';

export async function getOrgConfig(): Promise<OrganizationConfig> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('organization_config')
    .select('*')
    .eq('active', true)
    .single();

  if (error) throw error;
  return data as OrganizationConfig;
}

export async function updateOrgConfig(
  id: string,
  updates: Partial<OrganizationConfig>
): Promise<OrganizationConfig> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('organization_config')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as OrganizationConfig;
}