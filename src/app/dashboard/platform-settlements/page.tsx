'use client';
import {useEffect,useState} from 'react';
import toast from 'react-hot-toast';
export default function PlatformSettlements()
{
    const [rows,setRows]=useState<any[]>([]);
    const load=async()=>{const r=await fetch('/api/finance/platform-settlements');
        const j=await r.json();
        if(r.ok)setRows(j.data||[]);
        else toast.error(j.error||'Failed')};
        useEffect(()=>{load()},[]);
        const reconcile=async(id:string)=>{const r=await fetch(`/api/finance/platform-settlements/${id}`,{method:'POST'});
        const j=await r.json();
        if(!r.ok)toast.error(j.error||'Failed');
        else{toast.success(`Reconciled; fee variance ${j.data?.fee_variance??0}`);
        load()}};
        return <div className="space-y-6">
            <h1 className="text-2xl font-bold">Platform Settlements</h1>
            <p className="text-sm text-gray-500">Expected fee is calculated from the active rule; actual deductions remain the source for final cash settlement.</p>
            <div className="overflow-auto">
                <table className="w-full text-sm">
                    <thead><tr><th>Reference</th><th>Date</th><th>Gross</th><th>Expected Fee</th><th>Actual Fee</th><th>Net</th><th>Status</th><th/></tr></thead>
                    <tbody>{rows.map(r=><tr key={r.id} className="border-t"><td>{r.settlement_reference}</td><td>{r.settlement_date}</td><td>{r.gross_amount} {r.currency}</td><td>{r.expected_fee_amount}</td><td>{r.actual_fee_amount}</td><td>{r.net_amount}</td><td>{r.status}</td><td>{['DRAFT','SUBMITTED','VERIFIED','APPROVED'].includes(r.status)&&<button onClick={()=>reconcile(r.id)} className="text-blue-600">Reconcile</button>}</td></tr>)}</tbody>
                </table>
            </div>
            </div>}
