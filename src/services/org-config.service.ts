import { supabase } from '@/lib/supabase';
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