import { supabase } from '@/lib/supabase';
import type {
  ChartOfAccount,
  ChartOfAccountTree,
  PostableAccount,
  COAFilters,
  CreateAccountInput,
} from '@/types/accounting.types';

// ⭐ Yeh sab tables 'finance' schema mein hain
const SCHEMA = 'finance';

export async function getCOATree(): Promise<ChartOfAccountTree[]> {
  // ⭐ .schema(SCHEMA) add kiya
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
    query = query.or(`code.ilike.%${filters.search}%,name.ilike.%${filters.search}%`);
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
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('chart_of_accounts')
    .insert({
      ...input,
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
  return false; // Phase 2 mein implement hoga
}

export async function getAccountTypeSummary() {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('account_type_summary')
    .select('*');

  if (error) throw error;
  return data;
}