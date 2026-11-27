import { NextResponse } from 'next/server';
import { getCaseManifest } from '@/lib/cases';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const cases = getCaseManifest();
    return NextResponse.json(
      { cases },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (err) {
    console.error('[GET /api/cases] Error:', err);
    return NextResponse.json({ error: 'Failed to load case list.' }, { status: 500 });
  }
}
