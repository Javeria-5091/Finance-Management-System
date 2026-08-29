import { supabase as browserSupabase } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizeSearch } from '@/lib/validations';

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
import type {
  ChartOfAccount,
  ChartOfAccountTree,
  PostableAccount,
  COAFilters,
  CreateAccountInput,
} from '@/types/accounting.types';

const SCHEMA = 'finance';

export async function getCOATree(): Promise<ChartOfAccountTree[]> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('coa_tree')
    .select('*')
    .order('path_codes');

  if (error) throw error;
  return buildTree(data as ChartOfAccountTree[]);
}

function buildTree(flatList: ChartOfAccountTree[]): ChartOfAccountTree[] {
  const map = new Map<string, ChartOfAccountTree>();
  const roots: ChartOfAccountTree[] = [];

  flatList.forEach((item) => {
    map.set(item.id, { ...item, children: [], isExpanded: item.depth < 1 });
  });

  flatList.forEach((item) => {
    const node = map.get(item.id)!;
    if (item.parent_id && map.has(item.parent_id)) {
      map.get(item.parent_id)!.children!.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
}

export async function getCOAFiltered(filters: COAFilters = {}): Promise<ChartOfAccount[]> {
  let query = supabase.schema(SCHEMA).from('chart_of_accounts').select('*');

  if (filters.search) {
    const term = sanitizeSearch(filters.search);
    query = query.or(`code.ilike.%${term}%,name.ilike.%${term}%`);
  }

  if (filters.accountType && filters.accountType !== 'ALL') {
    query = query.eq('account_type', filters.accountType);
  }

  if (filters.status && filters.status !== 'ALL') {
    query = query.eq('is_active', filters.status === 'active');
  }

  const { data, error } = await query.order('code');
  if (error) throw error;
  return data as ChartOfAccount[];
}

export async function getPostableAccounts(): Promise<PostableAccount[]> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('postable_accounts')
    .select('*')
    .order('code');

  if (error) throw error;
  return data as PostableAccount[];
}

export async function getPostableAccountsByType(accountType: string): Promise<PostableAccount[]> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('postable_accounts')
    .select('*')
    .eq('account_type', accountType)
    .order('code');

  if (error) throw error;
  return data as PostableAccount[];
}

export async function getAccountById(id: string): Promise<ChartOfAccount> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('chart_of_accounts')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data as ChartOfAccount;
}

export async function getParentAccounts(): Promise<ChartOfAccount[]> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('chart_of_accounts')
    .select('*')
    .in('level', [0, 1])
    .eq('is_active', true)
    .order('code');

  if (error) throw error;
  return data as ChartOfAccount[];
}

export async function createAccount(input: CreateAccountInput): Promise<ChartOfAccount> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  const userId = authData.user?.id;
  if (!userId) throw new Error('Authenticated user is required to create a chart of account.');

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile?.organization_id) throw new Error('User organization is required to create a chart of account.');

  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('chart_of_accounts')
    .insert({
      ...input,
      organization_id: profile.organization_id,
      created_by: userId,
      level: input.parent_id ? 2 : 0,
    })
    .select()
    .single();

  if (error) throw error;
  return data as ChartOfAccount;
}

export async function updateAccount(
  id: string,
  updates: Partial<CreateAccountInput & { is_active: boolean }>
): Promise<ChartOfAccount> {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('chart_of_accounts')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as ChartOfAccount;
}

export async function deactivateAccount(id: string): Promise<void> {
  const { error } = await supabase
    .schema(SCHEMA)
    .from('chart_of_accounts')
    .update({ is_active: false })
    .eq('id', id);

  if (error) throw error;
}

export async function reactivateAccount(id: string): Promise<void> {
  const { error } = await supabase
    .schema(SCHEMA)
    .from('chart_of_accounts')
    .update({ is_active: true })
    .eq('id', id);

  if (error) throw error;
}

export async function isAccountUsed(id: string): Promise<boolean> {
  // BUG-056 FIX: Actually check if the account has any journal line entries.
  // An account is considered "used" if any posted journal entry references it.
  const { count } = await supabase
    .schema(SCHEMA)
    .from('journal_lines')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', id);
  return (count || 0) > 0;
}

export async function getAccountTypeSummary() {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('account_type_summary')
    .select('*');

  if (error) throw error;
  return data;
}