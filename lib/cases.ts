import 'server-only';

import fs from 'node:fs';
import path from 'node:path';

import { MANIFEST_DATA, STATIC_PUBLIC_CASES_MAP } from './caseRegistry.generated';
import exampleAnswerKeys from '../data/answer_keys.example.json';

import type {
  CaseSummary,
  GradeRequest,
  GradeResponse,
  McqOption,
  PublicCase,
} from './types';

interface StoredAnswerKey {
  failure_step: number;
  failure_type: string;
  correct_diagnosis_id: string;
  correct_rescue_id: string;
  root_cause: string;
  rescue_prompt_criteria: string;
  gold_patch: string;
  diagnosis_explanations: Record<string, string>;
  rescue_explanations: Record<string, string>;
}

type AnswerKeyMap = Record<string, StoredAnswerKey>;

const STATIC_PUBLIC_CASES = STATIC_PUBLIC_CASES_MAP as Record<string, PublicCase>;
const EXAMPLE_KEYS = exampleAnswerKeys as AnswerKeyMap;

const ANSWER_KEYS_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedRemoteKeys: { data: AnswerKeyMap; loadedAt: number } | null = null;
let cachedLocalKeys: AnswerKeyMap | null | undefined = undefined;

function shuffleOptions(options: McqOption[]): McqOption[] {
  const copy = options.map((opt) => ({ id: String(opt.id), text: String(opt.text) }));
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Loads answer keys in strict priority order:
 *   1. Remote Private GitHub Gist via process.env.ANSWER_KEYS_URL (+ optional GITHUB_TOKEN), cached in memory.
 *   2. Local gitignored private_data/answer_keys.json (for local development).
 *   3. Public dummy fallback data/answer_keys.example.json (for open-source contributors).
 */
async function loadAnswerKeys(): Promise<AnswerKeyMap> {
  const remoteUrl = process.env.ANSWER_KEYS_URL?.trim();
  if (remoteUrl) {
    const now = Date.now();
    if (cachedRemoteKeys && now - cachedRemoteKeys.loadedAt < ANSWER_KEYS_CACHE_TTL_MS) {
      return cachedRemoteKeys.data;
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json, application/json',
      'User-Agent': 'harness-interview',
    };
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(remoteUrl, { headers, cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Failed to fetch ANSWER_KEYS_URL (HTTP ${res.status}).`);
    }

    const parsed = (await res.json()) as Record<string, unknown>;
    let resolvedMap: AnswerKeyMap;

    // Support both raw Gist URLs and GitHub Gist API URLs (https://api.github.com/gists/<id>)
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
      const files = parsed.files as Record<string, { content?: string }>;
      const targetFile =
        files['answer_keys.json'] ||
        Object.values(files).find((f) => typeof f?.content === 'string');
      if (!targetFile?.content) {
        throw new Error('Gist payload did not contain an answer_keys.json file.');
      }
      resolvedMap = JSON.parse(targetFile.content) as AnswerKeyMap;
    } else {
      resolvedMap = parsed as unknown as AnswerKeyMap;
    }

    cachedRemoteKeys = { data: resolvedMap, loadedAt: now };
    return resolvedMap;
  }

  // 2. Local gitignored private_data/answer_keys.json
  if (cachedLocalKeys === undefined) {
    const localPath = path.join(process.cwd(), 'private_data', 'answer_keys.json');
    if (fs.existsSync(localPath)) {
      const raw = fs.readFileSync(localPath, 'utf-8');
      cachedLocalKeys = JSON.parse(raw) as AnswerKeyMap;
    } else {
      cachedLocalKeys = null;
    }
  }
  if (cachedLocalKeys) {
    return cachedLocalKeys;
  }

  // 3. Fallback dummy keys for open-source contributors
  return EXAMPLE_KEYS;
}

export function getCaseManifest(): CaseSummary[] {
  return MANIFEST_DATA.cases.map((c) => ({
    instance_id: String(c.instance_id),
    case_number: Number(c.case_number),
    title: String(c.title),
    difficulty: c.difficulty as CaseSummary['difficulty'],
    repo: String(c.repo),
    step_count: Number(c.step_count),
  }));
}

function readPublicCaseFile(instanceId: string): PublicCase | null {
  if (!instanceId || !Object.prototype.hasOwnProperty.call(STATIC_PUBLIC_CASES, instanceId)) {
    return null;
  }
  return STATIC_PUBLIC_CASES[instanceId];
}

export function getPublicCase(instanceId: string): PublicCase | null {
  const p = readPublicCaseFile(instanceId);
  if (!p) {
    return null;
  }

  // Explicit field whitelist guarantees zero secret leakage
  return {
    instance_id: String(p.instance_id),
    case_number: Number(p.case_number),
    title: String(p.title),
    difficulty: p.difficulty,
    repo: String(p.repo),
    base_commit: String(p.base_commit),
    model_name: String(p.model_name),
    source_dataset: String(p.source_dataset || 'nebius/SWE-agent-trajectories'),
    initial_prompt: String(p.initial_prompt || ''),
    step_count: Number(p.step_count),
    problem_statement: String(p.problem_statement),
    broken_patch: String(p.broken_patch),
    trajectory: p.trajectory.map((s) => ({
      step: Number(s.step),
      thought: String(s.thought),
      action: String(s.action),
      observation: String(s.observation),
    })),
    diagnosis_options: shuffleOptions(p.diagnosis_options),
    rescue_options: shuffleOptions(p.rescue_options),
  };
}

export async function gradeCaseSubmission(payload: GradeRequest): Promise<GradeResponse | null> {
  const pub = readPublicCaseFile(payload.instance_id);
  if (!pub) {
    return null;
  }

  const allKeys = await loadAnswerKeys();
  const key = allKeys[payload.instance_id];
  if (!key) {
    throw new Error(`Answer key for '${payload.instance_id}' is not configured.`);
  }

  const selectedStep = Number(payload.selected_step);
  if (!Number.isInteger(selectedStep) || selectedStep < 1 || selectedStep > pub.step_count) {
    throw new Error(`selected_step must be an integer between 1 and ${pub.step_count}.`);
  }

  const validDiagIds = new Set(pub.diagnosis_options.map((o) => o.id));
  const validRescueIds = new Set(pub.rescue_options.map((o) => o.id));
  if (!validDiagIds.has(payload.diagnosis_choice)) {
    throw new Error('Invalid diagnosis_choice option ID.');
  }
  if (!validRescueIds.has(payload.rescue_choice)) {
    throw new Error('Invalid rescue_choice option ID.');
  }

  // 1. Deterministic Step Grading (40 pts exact, 25 pts ±1, 0 pts miss)
  const stepDiff = Math.abs(selectedStep - key.failure_step);
  let stepVerdict: 'exact' | 'close' | 'miss';
  let stepPoints: number;
  let stepEmoji: string;
  let stepFeedback: string;

  if (stepDiff === 0) {
    stepVerdict = 'exact';
    stepPoints = 40;
    stepEmoji = '🟩';
    stepFeedback = `Pinpointed exact failure point (Step ${key.failure_step} of ${pub.step_count}).`;
  } else if (stepDiff === 1) {
    stepVerdict = 'close';
    stepPoints = 25;
    stepEmoji = '🟨';
    stepFeedback = `Close (±1 step): you flagged Step ${selectedStep}, while the decisive failure occurred at Step ${key.failure_step}.`;
  } else {
    stepVerdict = 'miss';
    stepPoints = 0;
    stepEmoji = '🟥';
    stepFeedback = `Missed failure step: you flagged Step ${selectedStep}, whereas the agent went off-track at Step ${key.failure_step}.`;
  }

  // 2. Deterministic Root Cause MCQ Grading (30 pts)
  const diagCorrect = payload.diagnosis_choice === key.correct_diagnosis_id;
  const diagPoints = diagCorrect ? 30 : 0;
  const diagEmoji = diagCorrect ? '🟩' : '🟥';
  const diagExplanation =
    key.diagnosis_explanations[payload.diagnosis_choice] ||
    (diagCorrect ? 'Correct root cause diagnosis.' : 'Incorrect root cause diagnosis.');

  // 3. Deterministic Systemic Harness / Guardrail Fix MCQ Grading (30 pts)
  const rescueCorrect = payload.rescue_choice === key.correct_rescue_id;
  const rescuePoints = rescueCorrect ? 30 : 0;
  const rescueEmoji = rescueCorrect ? '🟩' : '🟥';
  const rescueExplanation =
    key.rescue_explanations[payload.rescue_choice] ||
    (rescueCorrect
      ? 'Effective systemic harness guardrail.'
      : 'This guardrail would not prevent this class of failure.');

  const totalScore = stepPoints + diagPoints + rescuePoints;
  const feedback = `${stepFeedback} ${diagExplanation} ${rescueExplanation}`;

  const shareGrid = [
    `Harness Interview #${pub.case_number} (${pub.instance_id})`,
    `Score: ${totalScore}/100  ${stepEmoji}${diagEmoji}${rescueEmoji}`,
    `${stepEmoji} Failure Step (${stepVerdict.toUpperCase()})`,
    `${diagEmoji} Root Cause Diagnosis`,
    `${rescueEmoji} Systemic Harness Fix`,
  ].join('\n');

  return {
    score: totalScore,
    breakdown: {
      step_points: stepPoints,
      diagnosis_points: diagPoints,
      rescue_points: rescuePoints,
    },
    step_verdict: stepVerdict,
    mcq_verdicts: {
      diagnosis: {
        correct: diagCorrect,
        selected_id: payload.diagnosis_choice,
        correct_id: key.correct_diagnosis_id,
        explanation: diagExplanation,
      },
      rescue: {
        correct: rescueCorrect,
        selected_id: payload.rescue_choice,
        correct_id: key.correct_rescue_id,
        explanation: rescueExplanation,
      },
    },
    feedback,
    reveal: {
      actual_failure_step: key.failure_step,
      failure_type: key.failure_type,
      root_cause: key.root_cause,
      rescue_prompt_criteria: key.rescue_prompt_criteria,
      broken_patch: pub.broken_patch,
      gold_patch: key.gold_patch,
    },
    share_grid: shareGrid,
  };
}
