import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) 
{
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) 
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken:false, persistSession:false } });
    const { data, error } = await db.schema('core').rpc('process_approval_slas');
    if (error) 
        return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ escalated: data ?? 0 });
}
