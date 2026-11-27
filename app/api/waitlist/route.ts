import { NextRequest, NextResponse } from 'next/server';
import { recordWaitlistLead } from '@/lib/db';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  let body: { email?: unknown; instance_id?: unknown; invite_code?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'Valid email address required.' }, { status: 400 });
  }

  const saved = await recordWaitlistLead({
    email,
    instance_id: typeof body.instance_id === 'string' ? body.instance_id : undefined,
    invite_code: typeof body.invite_code === 'string' ? body.invite_code : undefined,
  });

  return NextResponse.json({ ok: true, persisted: saved }, { status: 200 });
}
