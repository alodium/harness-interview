import { NextResponse } from 'next/server';
import { getAggregateCaseStats } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const stats = await getAggregateCaseStats();
    if (!stats) {
      return NextResponse.json(
        { configured: false, cases: [] },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { configured: true, cases: stats },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[GET /api/stats] Error:', err);
    return NextResponse.json({ error: 'Unable to load aggregate stats.' }, { status: 500 });
  }
}
