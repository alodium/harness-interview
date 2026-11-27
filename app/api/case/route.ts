import { NextRequest, NextResponse } from 'next/server';
import { getPublicCase } from '@/lib/cases';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const instanceId = request.nextUrl.searchParams.get('id') || '';
  if (!instanceId) {
    return NextResponse.json({ error: 'Missing required query parameter: id' }, { status: 400 });
  }

  try {
    const publicCase = getPublicCase(instanceId);
    if (!publicCase) {
      return NextResponse.json({ error: `Case '${instanceId}' not found.` }, { status: 404 });
    }
    return NextResponse.json(publicCase, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[GET /api/case] Error:', err);
    return NextResponse.json({ error: 'Failed to load case.' }, { status: 500 });
  }
}
