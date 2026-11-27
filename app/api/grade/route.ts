import { NextRequest, NextResponse } from 'next/server';
import { gradeCaseSubmission } from '@/lib/cases';
import { recordSubmissionAndGetStats } from '@/lib/db';
import type { GradeRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: Partial<GradeRequest>;
  try {
    body = (await request.json()) as Partial<GradeRequest>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON request body.' }, { status: 400 });
  }

  const {
    instance_id,
    selected_step,
    diagnosis_choice,
    rescue_choice,
    elapsed_seconds,
    invite_code,
  } = body;

  if (
    typeof instance_id !== 'string' ||
    typeof selected_step !== 'number' ||
    typeof diagnosis_choice !== 'string' ||
    typeof rescue_choice !== 'string'
  ) {
    return NextResponse.json(
      {
        error:
          'Missing or invalid fields. Expected { instance_id, selected_step, diagnosis_choice, rescue_choice }.',
      },
      { status: 400 }
    );
  }

  try {
    const result = await gradeCaseSubmission({
      instance_id,
      selected_step,
      diagnosis_choice,
      rescue_choice,
    });
    if (!result) {
      return NextResponse.json({ error: `Case '${instance_id}' not found.` }, { status: 404 });
    }

    const caseStats = await recordSubmissionAndGetStats({
      instance_id,
      selected_step,
      step_verdict: result.step_verdict,
      diagnosis_choice,
      diagnosis_correct: result.mcq_verdicts.diagnosis.correct,
      rescue_choice,
      rescue_correct: result.mcq_verdicts.rescue.correct,
      score: result.score,
      elapsed_seconds: typeof elapsed_seconds === 'number' ? elapsed_seconds : undefined,
      invite_code: typeof invite_code === 'string' ? invite_code : undefined,
    });

    return NextResponse.json(
      {
        ...result,
        case_stats: caseStats,
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to grade submission.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
