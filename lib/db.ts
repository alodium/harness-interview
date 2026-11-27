import 'server-only';

import { neon } from '@neondatabase/serverless';
import type { CaseLiveStats } from './types';

function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

export interface SubmissionLogInput {
  instance_id: string;
  selected_step: number;
  step_verdict: 'exact' | 'close' | 'miss';
  diagnosis_choice: string;
  diagnosis_correct: boolean;
  rescue_choice: string;
  rescue_correct: boolean;
  score: number;
  elapsed_seconds?: number;
  invite_code?: string;
}

export async function recordSubmissionAndGetStats(
  input: SubmissionLogInput
): Promise<CaseLiveStats | null> {
  const sql = getSql();
  if (!sql) return null;

  const elapsed =
    typeof input.elapsed_seconds === 'number' &&
    Number.isFinite(input.elapsed_seconds) &&
    input.elapsed_seconds >= 0
      ? Math.round(input.elapsed_seconds)
      : null;

  const invite =
    typeof input.invite_code === 'string' && input.invite_code.trim()
      ? input.invite_code.trim().slice(0, 64)
      : null;

  if (input.invite_code === '__e2e_test__') {
    return null;
  }

  try {
    const rows = await sql`
      with inserted as (
        insert into submissions (
          instance_id,
          selected_step,
          step_verdict,
          diagnosis_choice,
          diagnosis_correct,
          rescue_choice,
          rescue_correct,
          score,
          elapsed_seconds,
          invite_code
        ) values (
          ${input.instance_id},
          ${input.selected_step},
          ${input.step_verdict},
          ${input.diagnosis_choice},
          ${input.diagnosis_correct},
          ${input.rescue_choice},
          ${input.rescue_correct},
          ${input.score},
          ${elapsed},
          ${invite}
        )
        returning score, step_verdict
      ),
      all_rows as (
        select score, step_verdict
        from submissions
        where instance_id = ${input.instance_id}
        union all
        select score, step_verdict
        from inserted
      )
      select
        count(*)::int as total_attempts,
        round(avg(score))::int as avg_score,
        round(100.0 * count(*) filter (where score = 100) / count(*))::int as perfect_rate_pct,
        round(100.0 * count(*) filter (where step_verdict = 'exact') / count(*))::int as exact_step_rate_pct
      from all_rows
    `;

    const r = rows[0];
    if (!r) return null;
    return {
      total_attempts: Number(r.total_attempts),
      avg_score: Number(r.avg_score),
      perfect_rate_pct: Number(r.perfect_rate_pct),
      exact_step_rate_pct: Number(r.exact_step_rate_pct),
    };
  } catch (err) {
    console.error('[Neon DB] Failed to record submission:', err);
    return null;
  }
}

export async function recordWaitlistLead(params: {
  email: string;
  instance_id?: string;
  invite_code?: string;
}): Promise<boolean> {
  const sql = getSql();
  if (!sql) return false;

  const cleanEmail = params.email.trim().toLowerCase().slice(0, 254);
  const instanceId = params.instance_id ? params.instance_id.trim().slice(0, 120) : null;
  const inviteCode = params.invite_code ? params.invite_code.trim().slice(0, 64) : null;

  try {
    await sql`
      insert into waitlist_leads (email, instance_id, invite_code)
      values (${cleanEmail}, ${instanceId}, ${inviteCode})
      on conflict ((lower(email)))
      do update set
        instance_id = coalesce(excluded.instance_id, waitlist_leads.instance_id),
        invite_code = coalesce(excluded.invite_code, waitlist_leads.invite_code)
    `;
    return true;
  } catch (err) {
    console.error('[Neon DB] Failed to record waitlist lead:', err);
    return false;
  }
}

export async function getAggregateCaseStats() {
  const sql = getSql();
  if (!sql) return null;

  const rows = await sql`
    select
      instance_id,
      count(*)::int as total_attempts,
      round(avg(score))::int as avg_score,
      round(100.0 * count(*) filter (where score = 100) / count(*))::int as perfect_rate_pct,
      round(100.0 * count(*) filter (where step_verdict = 'exact') / count(*))::int as exact_step_rate_pct,
      round(100.0 * count(*) filter (where diagnosis_correct) / count(*))::int as diagnosis_pass_rate_pct,
      round(100.0 * count(*) filter (where rescue_correct) / count(*))::int as harness_pass_rate_pct,
      round(avg(elapsed_seconds))::int as avg_elapsed_seconds
    from submissions
    group by instance_id
    order by total_attempts desc
  `;

  return rows;
}
