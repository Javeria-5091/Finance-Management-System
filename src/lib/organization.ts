import { supabase } from '@/lib/supabase';

export async function getCurrentOrganizationId(): Promise<string> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) throw new Error('Authentication required');

  const { data, error } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data?.organization_id) {
    throw new Error('Organization context is required');
  }
  return data.organization_id;
}
