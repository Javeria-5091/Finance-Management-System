'use client';
import { useEffect, useState } from 'react';
export default function OpeningBalancePage()
{
 const [evidence,setEvidence]=useState<any>(null); 
 const [loading,setLoading]=useState(false);
 const load=async()=>{
    setLoading(true);
    try{
        const r=await fetch('/api/finance/opening-balance/evidence',{credentials:'include'});setEvidence(await r.json());
    }
    finally{setLoading(false)}
};
 useEffect(()=>{load()},[]);
 return <div className="p-6 space-y-5"><div>
    <h1 className="text-2xl font-semibold">Opening Balance Migration Evidence</h1>
    <p className="text-sm text-gray-500">Source import counts, debit/credit totals and linked journal evidence.</p>
    </div>
  <button onClick={load} disabled={loading} className="px-4 py-2 rounded-lg border">{loading?'Refreshing…':'Refresh evidence'}</button>
  {evidence?.reconciliation && <div className="grid grid-cols-2 md:grid-cols-5 gap-3">{[['Rows',evidence.reconciliation.row_count],['Debit',evidence.reconciliation.total_debit],['Credit',evidence.reconciliation.total_credit],['Difference',evidence.reconciliation.difference],['Balanced',evidence.reconciliation.balanced?'YES':'NO']].map(([k,v])=><div key={String(k)} className="rounded-lg border p-4">
    <div className="text-xs text-gray-500">{k}</div>
    <div className="font-semibold mt-1">{String(v)}</div>
    </div>
)
}
</div>}
  <div className="rounded-lg border overflow-auto">
    <table className="w-full text-sm"><thead><tr className="border-b">
        <th className="p-3 text-left">Batch</th>
        <th>Rows</th><th>Debit</th><th>Credit</th><th>Journals</th></tr></thead>
        <tbody>{(evidence?.batches||[]).map((b:any)=><tr key={b.import_batch_id} className="border-b">
            <td className="p-3">{b.import_batch_id}</td>
            <td>{b.row_count}</td><td>{Number(b.total_debit).toFixed(2)}</td><td>{Number(b.total_credit).toFixed(2)}</td><td>{b.journal_ids.join(', ')||'—'}</td></tr>)}</tbody>
            </table>
            </div>
 </div>
}
