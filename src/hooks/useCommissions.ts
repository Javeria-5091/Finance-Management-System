import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

type Filters={search?:string;status?:string;commission_type?:string;person_type?:string;project_id?:string;contractor_id?:string};
async function api(path:string, init?:RequestInit){const r=await fetch(path,{...init,headers:{'Content-Type':'application/json',...(init?.headers||{})}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Commission request failed');return j.data;}
const invalidate=(qc:any)=>{qc.invalidateQueries({queryKey:['commissions']});qc.invalidateQueries({queryKey:['commission-stats']});qc.invalidateQueries({queryKey:['commission-by-person']});qc.invalidateQueries({queryKey:['commission-by-project']});qc.invalidateQueries({queryKey:['commission-by-type']});qc.invalidateQueries({queryKey:['commission-status-summary']});};
export const useCommissionStats=()=>useQuery({queryKey:['commission-stats'],queryFn:()=>api('/api/finance/commissions?stats=1'),staleTime:30000});
export const useCommissions=(filters?:Filters)=>useQuery({queryKey:['commissions',filters],queryFn:()=>api('/api/finance/commissions?'+new URLSearchParams(Object.entries(filters||{}).filter(([,v])=>!!v) as [string,string][]).toString()),staleTime:15000});
export const useCommissionByPerson=()=>useQuery({queryKey:['commission-by-person'],queryFn:()=>api('/api/finance/commissions?summary=person'),staleTime:30000});
export const useCommissionByProject=()=>useQuery({queryKey:['commission-by-project'],queryFn:()=>api('/api/finance/commissions?summary=project'),staleTime:30000});
export const useCommissionByType=()=>useQuery({queryKey:['commission-by-type'],queryFn:()=>api('/api/finance/commissions?summary=type'),staleTime:30000});
export const useCommissionStatusSummary=()=>useQuery({queryKey:['commission-status-summary'],queryFn:()=>api('/api/finance/commissions?summary=status'),staleTime:30000});
export const useCreateCommission=()=>{const qc=useQueryClient();return useMutation({mutationFn:(input:any)=>api('/api/finance/commissions',{method:'POST',body:JSON.stringify(input)}),onSuccess:()=>invalidate(qc)})};
export const useUpdateCommission=()=>{const qc=useQueryClient();return useMutation({mutationFn:({id,updates}:{id:string;updates:any})=>api('/api/finance/commissions/'+id,{method:'PATCH',body:JSON.stringify(updates)}),onSuccess:()=>invalidate(qc)})};
export const useDeleteCommission=()=>{const qc=useQueryClient();return useMutation({mutationFn:(id:string)=>api('/api/finance/commissions/'+id,{method:'DELETE'}),onSuccess:()=>invalidate(qc)})};
export const useApproveCommission=()=>{const qc=useQueryClient();return useMutation({mutationFn:({id}:{id:string;approvedBy?:string})=>api('/api/finance/commissions/'+id,{method:'PATCH',body:JSON.stringify({action:'approve'})}),onSuccess:()=>invalidate(qc)})};
export const useMarkCommissionPaid=()=>{const qc=useQueryClient();return useMutation({mutationFn:({id,paymentDate,paymentRef}:{id:string;paymentDate:string;paymentRef:string})=>api('/api/finance/commissions/'+id,{method:'PATCH',body:JSON.stringify({action:'pay',payment_date:paymentDate,payment_ref:paymentRef})}),onSuccess:()=>invalidate(qc)})};
