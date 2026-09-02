import { NextResponse } from 'next/server';

// F-P1-19: this legacy URL previously listed all receipts and could create a
// new receipt without idempotency. The canonical allocation API is
// /api/finance/payment-allocations. Fail closed instead of preserving a
// misleading money-creating endpoint.
export async function GET() { return NextResponse.json({ error: 'Deprecated endpoint. Use /api/finance/payment-allocations.' }, { status: 410 }); }
export async function POST() { return NextResponse.json({ error: 'Deprecated endpoint. Use /api/finance/payment-allocations.' }, { status: 410 }); }
