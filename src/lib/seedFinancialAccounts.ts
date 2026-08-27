
import { supabase } from './supabase';

export async function seedFinancialAccountsIfEmpty() {
  const { data: existing } = await supabase
    .schema('finance').from('financial_accounts')
    .select('id')
    .limit(1);

  if (existing && existing.length > 0) return; // Already seeded

  // Get ledger account IDs from COA
  const { data: coa } = await supabase
    .schema('finance').from('chart_of_accounts')
    .select('id, code')
    .in('code', ['1110','1120','1130','1140','1150','1160','1170','1180']);

  if (!coa) return;

  const getAccount = (code: string) => coa.find(c => c.code === code)?.id;

  const accounts = [
    { account_name: 'Bank Account PKR', institution_name: 'Bank Alfalah', institution_type: 'BANK', account_type: 'CURRENT', currency: 'PKR', masked_identifier: '****5678', linked_ledger_account_id: getAccount('1110'), is_default: true },
    { account_name: 'JazzCash PKR', institution_name: 'JazzCash', institution_type: 'WALLET', account_type: 'DIGITAL_WALLET', currency: 'PKR', masked_identifier: '****9012', linked_ledger_account_id: getAccount('1120') },
    { account_name: 'EasyPaisa PKR', institution_name: 'EasyPaisa', institution_type: 'WALLET', account_type: 'DIGITAL_WALLET', currency: 'PKR', masked_identifier: '****3456', linked_ledger_account_id: getAccount('1130') },
    { account_name: 'Wise USD', institution_name: 'Wise', institution_type: 'PLATFORM', account_type: 'PLATFORM_BALANCE', currency: 'USD', masked_identifier: '****7890', linked_ledger_account_id: getAccount('1140'), is_default: true },
    { account_name: 'Payoneer USD', institution_name: 'Payoneer', institution_type: 'PLATFORM', account_type: 'PLATFORM_BALANCE', currency: 'USD', masked_identifier: '****2345', linked_ledger_account_id: getAccount('1150') },
    { account_name: 'Freelancer USD', institution_name: 'Freelancer', institution_type: 'PLATFORM', account_type: 'PLATFORM_BALANCE', currency: 'USD', masked_identifier: '****6789', linked_ledger_account_id: getAccount('1160') },
    { account_name: 'Upwork USD', institution_name: 'Upwork', institution_type: 'PLATFORM', account_type: 'PLATFORM_BALANCE', currency: 'USD', masked_identifier: '****4321', linked_ledger_account_id: getAccount('1170') },
    { account_name: 'Petty Cash PKR', institution_name: 'Cash', institution_type: 'CASH', account_type: 'PETTY_CASH', currency: 'PKR', masked_identifier: null, linked_ledger_account_id: getAccount('1180') },
  ].filter(a => a.linked_ledger_account_id); // Only insert if COA account exists

  const { error } = await supabase
    .schema('finance').from('financial_accounts')
    .insert(accounts);

  if (error) console.error('Seed financial accounts failed:', error);
  else console.log('Financial accounts seeded successfully');
}