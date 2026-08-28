'use client';
import {useEffect,useState} from 'react';
import toast from 'react-hot-toast';
export default function PurchaseRequests()
{
    const [rows,setRows]=useState<any[]>([]);
    const [form,setForm]=useState({description:'',amount:'',currency:'PKR',category:'',justification:''});
    const load=async()=>{const r=await fetch('/api/finance/purchase-requests');
        const j=await r.json();
        if(!r.ok)toast.error(j.error||'Failed');
        else setRows(j.data||[])};useEffect(()=>{load()},[]);
        const create=async()=>{const r=await fetch('/api/finance/purchase-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...form,amount:Number(form.amount)})});
        const j=await r.json();
        if(!r.ok)toast.error(j.error||'Failed');
        else{toast.success('Purchase request created');
            setForm({description:'',amount:'',currency:'PKR',category:'',justification:''});
            load()
        }};
        const transition=async(id:string,status:string)=>{const r=await fetch(`/api/finance/purchase-requests/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
        const j=await r.json();
        if(!r.ok)toast.error(j.error||'Failed');
        else{toast.success(`Request ${status.toLowerCase()}`);
        load()
    }};
    return <div className="space-y-6">
        <h1 className="text-2xl font-bold">Purchase Requests</h1>
        <div className="grid md:grid-cols-2 gap-3">{['description','amount','currency','category','justification'].map(k=><input key={k} className="border rounded p-2 dark:bg-gray-800" placeholder={k} value={(form as any)[k]} onChange={e=>setForm({...form,[k]:e.target.value})}/>)}</div>
        <button onClick={create} className="px-4 py-2 rounded bg-blue-600 text-white">Create Request</button>
        <div className="overflow-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr>
                        <th>Number</th>
                        <th>Description</th>
                        <th>Amount</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
            <tbody>{rows.map(r=>
                <tr key={r.id} className="border-t">
                    <td>{r.request_number}</td>
                    <td>{r.description}</td>
                    <td>{r.currency} {r.amount}</td>
                    <td>{r.status}</td>
                    <td className="space-x-2">{r.status==='DRAFT'&&<button onClick={()=>transition(r.id,'SUBMITTED')} className="text-blue-600">Submit</button>}
                    {r.status==='SUBMITTED'&&<button onClick={()=>transition(r.id,'APPROVED')} className="text-green-600">Approve</button>}
                    </td>
                </tr>
                )}
                </tbody>
                </table></div></div>
}
