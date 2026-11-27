'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { CaseSummary, GradeResponse, PublicCase } from '@/lib/types';
import { DiffViewer } from './DiffViewer';

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];
const COMPLETED_STORAGE_KEY = 'hi_completed_scores_v1';
const ATTEMPTS_STORAGE_KEY = 'hi_completed_attempts_v1';

interface SavedAttempt {
  score: number;
  lockedStep: number;
  diagnosisChoice: string;
  rescueChoice: string;
}

function formatAgentModel(rawModel: string): string {
  const m = (rawModel || '').trim();
  if (!m) return 'SWE-agent';
  if (/llama[-_ ]?3\.1[-_ ]?70b/i.test(m) || /70b/i.test(m)) return 'SWE-agent (Llama-70B)';
  return `SWE-agent (${m.split('/').pop()})`;
}

function getShortCommandName(action: string): string {
  const firstLine = (action || '').trim().split('\n')[0]?.trim() || '';
  if (!firstLine || firstLine.startsWith('(')) return 'step';
  const token = firstLine.split(/\s+/)[0] || 'cmd';
  return token.replace(/[^a-zA-Z0-9_./-]/g, '').slice(0, 18) || 'cmd';
}

function formatShortCaseName(c: CaseSummary): string {
  if (c.repo && c.repo.includes('/')) {
    return c.repo.split('/')[1];
  }
  if (c.instance_id.includes('__')) {
    return c.instance_id.split('__')[1];
  }
  return c.instance_id;
}

function difficultyBadgeStyle(difficulty: CaseSummary['difficulty']): string {
  if (difficulty === 'Easy') {
    return 'bg-emerald-500/10 text-emerald-400';
  }
  if (difficulty === 'Hard') {
    return 'bg-rose-500/10 text-rose-400';
  }
  return 'bg-amber-500/10 text-amber-400';
}

export function ForensicsWorkspace() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string>('');
  const [caseData, setCaseData] = useState<PublicCase | null>(null);

  const [loadingList, setLoadingList] = useState<boolean>(true);
  const [loadingCase, setLoadingCase] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Replay & Progressive Disclosure State (-1 = Step 0 Initial Prompt, 0..N-1 = Steps 1..N)
  const [currentStepIdx, setCurrentStepIdx] = useState<number>(0);
  const [lockedStep, setLockedStep] = useState<number | null>(null);
  const [evidenceTab, setEvidenceTab] = useState<'issue' | 'diff'>('issue');
  const [evidenceExpanded, setEvidenceExpanded] = useState<boolean>(true);
  const [diagnosisChoice, setDiagnosisChoice] = useState<string>('');
  const [diagnosisConfirmed, setDiagnosisConfirmed] = useState<boolean>(false);
  const [rescueChoice, setRescueChoice] = useState<string>('');

  // Grading & Scorecard Modal State
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [gradeResult, setGradeResult] = useState<GradeResponse | null>(null);
  const [scorecardOpen, setScorecardOpen] = useState<boolean>(false);
  const [completedScores, setCompletedScores] = useState<Record<string, number>>({});
  const [savedAttempts, setSavedAttempts] = useState<Record<string, SavedAttempt>>({});

  // Beta CTA, Case Drawer, Attribution Modal & Toast State
  const [caseDrawerOpen, setCaseDrawerOpen] = useState<boolean>(false);
  const [caseFilter, setCaseFilter] = useState<'All' | 'Easy' | 'Medium' | 'Hard' | 'Unsolved'>('All');
  const [caseSearch, setCaseSearch] = useState<string>('');
  const [betaModalOpen, setBetaModalOpen] = useState<boolean>(false);
  const [licenseModalOpen, setLicenseModalOpen] = useState<boolean>(false);
  const [betaEmail, setBetaEmail] = useState<string>('');
  const [betaLinkCreated, setBetaLinkCreated] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Timer
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COMPLETED_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>;
        if (parsed && typeof parsed === 'object') {
          setCompletedScores(parsed);
        }
      }
      const rawAttempts = window.localStorage.getItem(ATTEMPTS_STORAGE_KEY);
      if (rawAttempts) {
        const parsedAttempts = JSON.parse(rawAttempts) as Record<string, SavedAttempt>;
        if (parsedAttempts && typeof parsedAttempts === 'object') {
          setSavedAttempts(parsedAttempts);
        }
      }
    } catch {
      // Ignore storage access errors in private browsing
    }
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const t = setTimeout(() => setToastMessage(null), 2600);
    return () => clearTimeout(t);
  }, [toastMessage]);

  // Live timer (pauses while loading or when any modal/drawer is open)
  useEffect(() => {
    if (
      loadingCase ||
      scorecardOpen ||
      caseDrawerOpen ||
      betaModalOpen ||
      licenseModalOpen ||
      gradeResult
    ) {
      return;
    }
    const handle = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(handle);
  }, [loadingCase, scorecardOpen, caseDrawerOpen, betaModalOpen, licenseModalOpen, gradeResult]);

  const formattedTime = useMemo(() => {
    const mins = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
    const secs = String(elapsedSeconds % 60).padStart(2, '0');
    return `${mins}:${secs}`;
  }, [elapsedSeconds]);

  // 1. Fetch case list on mount
  useEffect(() => {
    let cancelled = false;
    async function loadCases() {
      setLoadingList(true);
      try {
        const res = await fetch('/api/cases', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status} loading cases`);
        const data = (await res.json()) as { cases: CaseSummary[] };
        if (!cancelled) {
          const list = data.cases || [];
          setCases(list);
          if (list.length > 0) {
            const urlCase =
              typeof window !== 'undefined'
                ? new URLSearchParams(window.location.search).get('case')
                : null;
            const matched = list.find((c) => c.instance_id === urlCase);
            setActiveCaseId(matched ? matched.instance_id : list[0].instance_id);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load cases.');
        }
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    }
    loadCases();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Fetch individual public case when activeCaseId changes
  const fetchCaseById = useCallback(async (id: string) => {
    if (!id) return;
    setLoadingCase(true);
    setErrorMsg(null);
    setGradeResult(null);
    setScorecardOpen(false);
    setCurrentStepIdx(0); // Start immediately on Step 1; Step 0 is pill `0`
    setLockedStep(null);
    setDiagnosisChoice('');
    setDiagnosisConfirmed(false);
    setRescueChoice('');
    setEvidenceTab('issue');
    setEvidenceExpanded(true);
    setElapsedSeconds(0);

    try {
      const res = await fetch(`/api/case?id=${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status} loading case`);
      }
      const pub = (await res.json()) as PublicCase;
      setCaseData(pub);

      // Restore previous solved attempt if present in localStorage; otherwise stay strictly locked
      try {
        const rawAttempts = window.localStorage.getItem(ATTEMPTS_STORAGE_KEY);
        if (rawAttempts) {
          const parsed = JSON.parse(rawAttempts) as Record<string, SavedAttempt>;
          const prev = parsed?.[id];
          if (
            prev &&
            prev.lockedStep >= 1 &&
            prev.lockedStep <= pub.step_count &&
            pub.diagnosis_options.some((o) => o.id === prev.diagnosisChoice) &&
            pub.rescue_options.some((o) => o.id === prev.rescueChoice)
          ) {
            setLockedStep(prev.lockedStep);
            setDiagnosisChoice(prev.diagnosisChoice);
            setDiagnosisConfirmed(true);
            setRescueChoice(prev.rescueChoice);
          }
        }
      } catch {
        // Ignore storage read errors
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load case payload.');
    } finally {
      setLoadingCase(false);
    }
  }, []);

  useEffect(() => {
    if (activeCaseId) {
      fetchCaseById(activeCaseId);
    }
  }, [activeCaseId, fetchCaseById]);

  // Keyboard left/right step navigation (supports Step 0 at -1 through Step N at length-1)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && caseDrawerOpen) {
        setCaseDrawerOpen(false);
        return;
      }
      if (!caseData || scorecardOpen || caseDrawerOpen || betaModalOpen || licenseModalOpen) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTextInput =
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (tag === 'INPUT' && (target as HTMLInputElement).type !== 'radio');
      if (isTextInput) return;
      const minIdx = caseData.initial_prompt ? -1 : 0;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCurrentStepIdx((idx) => Math.max(minIdx, idx - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setCurrentStepIdx((idx) => Math.min(caseData.trajectory.length - 1, idx + 1));
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [caseData, scorecardOpen, caseDrawerOpen, betaModalOpen, licenseModalOpen]);

  const activeCaseSummary = useMemo(
    () => cases.find((c) => c.instance_id === activeCaseId) ?? null,
    [cases, activeCaseId]
  );

  const solvedCount = useMemo(
    () => cases.filter((c) => completedScores[c.instance_id] !== undefined).length,
    [cases, completedScores]
  );

  const filteredCases = useMemo(() => {
    const q = caseSearch.trim().toLowerCase();
    return cases.filter((c) => {
      if (caseFilter === 'Unsolved' && completedScores[c.instance_id] !== undefined) {
        return false;
      }
      if (
        (caseFilter === 'Easy' || caseFilter === 'Medium' || caseFilter === 'Hard') &&
        c.difficulty !== caseFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        c.instance_id.toLowerCase().includes(q) ||
        c.repo.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        `#${c.case_number}` === q
      );
    });
  }, [cases, caseFilter, caseSearch, completedScores]);

  const isViewingStepZero = currentStepIdx === -1;
  const activeStepObj =
    !isViewingStepZero && caseData ? caseData.trajectory[currentStepIdx] ?? null : null;
  const isReadyToSubmit =
    lockedStep !== null &&
    diagnosisConfirmed &&
    Boolean(diagnosisChoice) &&
    Boolean(rescueChoice);

  function handleResetAttempt() {
    setLockedStep(null);
    setDiagnosisChoice('');
    setDiagnosisConfirmed(false);
    setRescueChoice('');
    setGradeResult(null);
    setScorecardOpen(false);
    setCurrentStepIdx(0);
    setElapsedSeconds(0);
    showToast('Attempt reset — lock a failure step to begin.');
  }

  async function handleSubmitDiagnosis(e: React.FormEvent) {
    e.preventDefault();
    if (!caseData) return;

    if (lockedStep === null) {
      showToast('Lock the suspected failure step first.');
      return;
    }
    if (!diagnosisChoice || !diagnosisConfirmed) {
      showToast('Confirm your Root Cause Diagnosis first.');
      return;
    }
    if (!rescueChoice) {
      showToast('Select a Systemic Harness / Guardrail Fix option.');
      return;
    }

    setSubmitting(true);
    try {
      const inviteCode =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('invite') || undefined
          : undefined;

      const res = await fetch('/api/grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instance_id: caseData.instance_id,
          selected_step: lockedStep,
          diagnosis_choice: diagnosisChoice,
          rescue_choice: rescueChoice,
          elapsed_seconds: elapsedSeconds,
          invite_code: inviteCode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Grading failed (HTTP ${res.status})`);
      }
      const graded = data as GradeResponse;
      setGradeResult(graded);
      setScorecardOpen(true);
      setCompletedScores((prev) => {
        const updated = {
          ...prev,
          [caseData.instance_id]: Math.max(prev[caseData.instance_id] ?? 0, graded.score),
        };
        try {
          window.localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify(updated));
        } catch {
          // Ignore storage quota/privacy errors
        }
        return updated;
      });
      setSavedAttempts((prev) => {
        const updated: Record<string, SavedAttempt> = {
          ...prev,
          [caseData.instance_id]: {
            score: graded.score,
            lockedStep,
            diagnosisChoice,
            rescueChoice,
          },
        };
        try {
          window.localStorage.setItem(ATTEMPTS_STORAGE_KEY, JSON.stringify(updated));
        } catch {
          // Ignore storage quota/privacy errors
        }
        return updated;
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopyShareGrid() {
    if (!gradeResult) return;
    const origin =
      typeof window !== 'undefined' ? window.location.origin : 'https://harness-interview.vercel.app';
    const text = `${gradeResult.share_grid}\n${origin}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied scorecard grid to clipboard!');
    } catch {
      showToast('Unable to copy automatically — select text to copy.');
    }
  }

  function handlePrevCase() {
    if (!cases.length || !activeCaseId) return;
    const idx = cases.findIndex((c) => c.instance_id === activeCaseId);
    const prev = cases[(idx - 1 + cases.length) % cases.length];
    setScorecardOpen(false);
    setActiveCaseId(prev.instance_id);
  }

  function handleNextCase() {
    if (!cases.length || !activeCaseId) return;
    const idx = cases.findIndex((c) => c.instance_id === activeCaseId);
    const next = cases[(idx + 1) % cases.length];
    setScorecardOpen(false);
    setActiveCaseId(next.instance_id);
  }

  function handleCreateAssessmentLink(e: React.FormEvent) {
    e.preventDefault();
    const slug = Math.random().toString(36).slice(2, 8);
    const origin =
      typeof window !== 'undefined' ? window.location.origin : 'https://harness-interview.vercel.app';
    const link = `${origin}/?case=${encodeURIComponent(caseData?.instance_id || '')}&invite=${slug}`;
    setBetaLinkCreated(link);
    fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: betaEmail,
        instance_id: caseData?.instance_id,
        invite_code: slug,
      }),
    }).catch(() => {});
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(link).catch(() => {});
    }
    showToast('Candidate assessment link copied!');
  }

  const findOptionLabel = (
    options: { id: string; text: string }[],
    targetId: string
  ): { letter: string; text: string } | null => {
    const idx = options.findIndex((o) => o.id === targetId);
    if (idx === -1) return null;
    return { letter: OPTION_LETTERS[idx] || '?', text: options[idx].text };
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0a0a0a] text-[#ededed]">
      {/* ==================== SINGLE SLIM 56px TOP NAVBAR ==================== */}
      <header className="sticky top-0 z-30 h-14 border-b border-white/[0.08] bg-[#0a0a0a]/90 backdrop-blur-md">
        <div className="max-w-7xl h-full mx-auto px-4 sm:px-6 flex items-center justify-between gap-3">
          {/* Left: Brand */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-7 h-7 rounded-md bg-white/[0.06] border border-white/[0.1] flex items-center justify-center text-blue-400 font-mono font-semibold text-xs">
              HI
            </div>
            <span className="text-sm font-semibold tracking-tight text-white">
              Harness Interview
            </span>
          </div>

          {/* Center: Compact Case Switcher */}
          {cases.length > 0 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handlePrevCase}
                title="Previous case"
                aria-label="Previous case"
                className="w-8 h-8 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] flex items-center justify-center text-sm transition cursor-pointer"
              >
                ←
              </button>

              <button
                type="button"
                onClick={() => setCaseDrawerOpen(true)}
                className="h-8 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-xs transition flex items-center gap-2 cursor-pointer"
              >
                {activeCaseSummary ? (
                  <>
                    <span className="font-mono text-zinc-400">
                      #{activeCaseSummary.case_number}/{cases.length}
                    </span>
                    <span className="font-medium text-white truncate max-w-[110px] sm:max-w-[180px]">
                      {formatShortCaseName(activeCaseSummary)}
                    </span>
                    <span className="hidden sm:inline text-zinc-600">·</span>
                    <span
                      className={`hidden sm:inline-block px-1.5 py-0.5 rounded text-[11px] font-medium leading-none ${difficultyBadgeStyle(
                        activeCaseSummary.difficulty
                      )}`}
                    >
                      {activeCaseSummary.difficulty}
                    </span>
                    {completedScores[activeCaseSummary.instance_id] !== undefined && (
                      <span className="text-emerald-400 font-mono text-[11px] font-medium">
                        ✓ {completedScores[activeCaseSummary.instance_id]}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-zinc-300 font-medium">Select Case</span>
                )}
                <span className="text-zinc-500 text-[10px]">▾</span>
              </button>

              <button
                type="button"
                onClick={handleNextCase}
                title="Next case"
                aria-label="Next case"
                className="w-8 h-8 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] flex items-center justify-center text-sm transition cursor-pointer"
              >
                →
              </button>
            </div>
          )}

          {/* Right: Progress + Muted Timer + Scorecard Re-open */}
          <div className="flex items-center gap-3 shrink-0">
            {gradeResult && (
              <button
                type="button"
                onClick={() => setScorecardOpen(true)}
                className="px-2.5 py-1 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 text-xs font-medium transition cursor-pointer"
              >
                Score: {gradeResult.score}/100
              </button>
            )}

            {cases.length > 0 && (
              <button
                type="button"
                onClick={() => setCaseDrawerOpen(true)}
                title="Browse all 24 cases"
                className="hidden md:inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
              >
                <span>Solved</span>
                <span className="font-mono text-zinc-300">
                  {solvedCount}/{cases.length}
                </span>
              </button>
            )}

            <div
              title="Personal pacing only — elapsed time does not affect your score."
              className="group relative flex items-center gap-1 text-xs text-zinc-500 cursor-default"
            >
              <span className="font-mono tabular-nums">{formattedTime}</span>
              <span className="text-zinc-600 text-[11px]">ⓘ</span>
              <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity absolute right-0 top-full mt-2 w-48 p-2.5 rounded-lg bg-[#18181b] border border-white/[0.1] text-xs text-zinc-300 shadow-xl z-40 leading-snug">
                Personal reference only — time does not affect your score.
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ==================== LOADING / ERROR STATES ==================== */}
      {(loadingList || loadingCase) && (
        <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-16 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-zinc-400">Loading recorded session...</p>
          </div>
        </div>
      )}

      {!loadingList && !loadingCase && errorMsg && (
        <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-16 flex items-center justify-center">
          <div className="rounded-xl bg-[#121212] border border-white/[0.08] p-6 text-center space-y-3 max-w-md w-full">
            <p className="text-sm font-medium text-white">Unable to load session</p>
            <p className="text-xs font-mono text-rose-400">{errorMsg}</p>
            <button
              type="button"
              onClick={() => fetchCaseById(activeCaseId)}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* ==================== MAIN 1 -> 2 -> 3 WORKSPACE ==================== */}
      {!loadingList && !loadingCase && !errorMsg && caseData && (
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 pt-4 pb-10 space-y-6">
          {/* Ultra-clean single muted provenance breadcrumb line */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
            <span className="text-zinc-400">{formatAgentModel(caseData.model_name)}</span>
            <span className="text-zinc-700">·</span>
            <a
              href={`https://github.com/${caseData.repo}${caseData.base_commit ? `/tree/${caseData.base_commit}` : ''}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-zinc-400 hover:text-zinc-200 transition"
            >
              {caseData.repo}
              {caseData.base_commit ? ` @ ${caseData.base_commit}` : ''}
            </a>
            <span className="text-zinc-700">·</span>
            <a
              href="https://huggingface.co/datasets/nebius/SWE-agent-trajectories"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-blue-400 transition"
            >
              Dataset ↗
            </a>
          </div>

          {/* 1. TOP FULL-WIDTH COLLAPSIBLE PANEL: INITIAL TASK & FINAL BROKEN OUTPUT */}
          <section className="rounded-xl bg-[#121212] border border-white/[0.07] overflow-hidden">
            <div
              className={`px-6 h-12 flex flex-wrap items-center justify-between gap-3 ${
                evidenceExpanded ? 'border-b border-white/[0.06]' : ''
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <h2 className="text-sm font-semibold text-white whitespace-nowrap">
                  1. Initial Task &amp; Final Broken Output
                </h2>
                {!evidenceExpanded && (
                  <span className="hidden md:inline text-xs text-zinc-500 truncate max-w-md">
                    — {caseData.title}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setEvidenceTab('issue');
                      setEvidenceExpanded(true);
                    }}
                    className={`px-2.5 py-1 rounded-md text-xs transition cursor-pointer ${
                      evidenceTab === 'issue'
                        ? 'bg-white/[0.09] text-white font-medium'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    GitHub Issue (Task)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEvidenceTab('diff');
                      setEvidenceExpanded(true);
                    }}
                    className={`px-2.5 py-1 rounded-md text-xs transition cursor-pointer ${
                      evidenceTab === 'diff'
                        ? 'bg-white/[0.09] text-white font-medium'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Final Broken Git Diff
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setEvidenceExpanded((prev) => !prev)}
                  aria-expanded={evidenceExpanded}
                  className="text-xs text-zinc-400 hover:text-zinc-200 transition cursor-pointer"
                >
                  {evidenceExpanded ? 'Hide ▲' : 'Show ▼'}
                </button>
              </div>
            </div>

            {evidenceExpanded && (
              <div className="p-6 max-h-[300px] overflow-y-auto">
                {evidenceTab === 'issue' ? (
                  <div className="max-w-4xl space-y-3">
                    <h3 className="text-base font-semibold text-white leading-snug">
                      {caseData.title}
                    </h3>
                    <div className="font-sans text-[15px] leading-[1.6] text-[#ededed] whitespace-pre-wrap">
                      {caseData.problem_statement}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg bg-[#0a0a0a] p-4">
                    <DiffViewer diff={caseData.broken_patch} />
                  </div>
                )}
              </div>
            )}
          </section>

          {/* BOTTOM 2-COLUMN GRID: 2. RECORDED AGENT SESSION (LEFT) + 3. POST-MORTEM & HARNESS FIX (RIGHT) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* BOTTOM-LEFT: 2. RECORDED AGENT SESSION (ZERO SPOILERS) */}
            <section className="lg:col-span-6 rounded-xl bg-[#121212] border border-white/[0.07] flex flex-col overflow-hidden">
              {/* Panel Header */}
              <div className="px-6 h-12 border-b border-white/[0.06] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-sm font-semibold text-white">2. Recorded Agent Session</h2>
                  <span className="text-xs text-zinc-500 font-mono">
                    {caseData.step_count} steps
                  </span>
                </div>
                <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-zinc-500">
                  <kbd className="px-1.5 py-0.5 rounded bg-white/[0.05] font-mono text-[11px] text-zinc-400">
                    ←
                  </kbd>
                  <kbd className="px-1.5 py-0.5 rounded bg-white/[0.05] font-mono text-[11px] text-zinc-400">
                    →
                  </kbd>
                </span>
              </div>

              {/* Integrated Step Pills: 0 (Initial Prompt) + 1..N — ZERO SPOILERS */}
              <div className="px-6 py-4 border-b border-white/[0.06]">
                <div className="flex flex-wrap items-center gap-1.5">
                  {caseData.initial_prompt && (
                    <div className="group relative">
                      <button
                        type="button"
                        onClick={() => setCurrentStepIdx(-1)}
                        title="Step 0: Initial Prompt"
                        aria-label="View Step 0 (Initial Prompt)"
                        className={`min-w-[34px] h-8 px-2.5 rounded-lg text-xs font-mono transition cursor-pointer ${
                          isViewingStepZero
                            ? 'bg-blue-600 text-white font-semibold'
                            : 'bg-white/[0.04] text-zinc-400 hover:text-white hover:bg-white/[0.09]'
                        }`}
                      >
                        0
                      </button>
                      <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-100 absolute left-1/2 -translate-x-1/2 -top-7 px-2 py-0.5 rounded bg-[#1f1f23] border border-white/[0.1] text-[10px] font-mono text-zinc-200 whitespace-nowrap shadow-lg z-20">
                        prompt
                      </div>
                    </div>
                  )}

                  {caseData.trajectory.map((s, idx) => {
                    const isViewing = idx === currentStepIdx;
                    const isLocked = lockedStep === s.step;
                    const shortCmd = getShortCommandName(s.action);

                    let pillStyle =
                      'bg-white/[0.04] text-zinc-400 hover:text-white hover:bg-white/[0.09]';
                    if (isViewing && isLocked) {
                      pillStyle =
                        'bg-blue-600 text-white font-semibold ring-2 ring-amber-400/70';
                    } else if (isViewing) {
                      pillStyle = 'bg-blue-600 text-white font-semibold';
                    } else if (isLocked) {
                      pillStyle = 'bg-amber-500/20 text-amber-200 font-semibold ring-1 ring-amber-400/60';
                    }

                    return (
                      <div key={s.step} className="group relative">
                        <button
                          type="button"
                          onClick={() => setCurrentStepIdx(idx)}
                          title={`Step ${s.step}: ${shortCmd}`}
                          aria-label={`View Step ${s.step} (${shortCmd})`}
                          className={`min-w-[34px] h-8 px-2.5 rounded-lg text-xs font-mono transition flex items-center justify-center gap-1.5 cursor-pointer ${pillStyle}`}
                        >
                          <span>{s.step}</span>
                          {isLocked && (
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-300" />
                          )}
                        </button>
                        {/* Instant Neutral Command Tooltip */}
                        <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-100 absolute left-1/2 -translate-x-1/2 -top-7 px-2 py-0.5 rounded bg-[#1f1f23] border border-white/[0.1] text-[10px] font-mono text-zinc-200 whitespace-nowrap shadow-lg z-20">
                          {shortCmd}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Single-Step Inspector — Airy, Borderless Sections with Hairline Dividers */}
              {isViewingStepZero ? (
                <div className="p-6 space-y-4 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-white">
                      Step 0 — Initial Prompt (Session Kickoff)
                    </span>
                    <span className="text-xs text-zinc-500">Harness input</span>
                  </div>
                  <div className="font-sans text-[15px] leading-[1.6] text-[#ededed] whitespace-pre-wrap">
                    {caseData.initial_prompt}
                  </div>
                </div>
              ) : activeStepObj ? (
                <div className="p-6 space-y-6 flex-1">
                  {/* Step Title Row */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-white">
                      Step {activeStepObj.step}{' '}
                      <span className="text-zinc-500 font-normal">of {caseData.step_count}</span>
                    </span>
                    {lockedStep === activeStepObj.step ? (
                      <span className="px-2.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300 font-mono font-medium text-xs">
                        Locked: Step #{lockedStep}
                      </span>
                    ) : lockedStep !== null ? (
                      <span className="text-amber-300/80 font-mono text-xs">
                        Locked: Step #{lockedStep}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-500">
                        Commit the failure step below to unlock Section 3
                      </span>
                    )}
                  </div>

                  {/* Thought — Clean High-Contrast Sans-serif Prose (NO box border!) */}
                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                      Thought
                    </div>
                    <div className="font-sans text-[15px] leading-[1.6] text-[#ededed] whitespace-pre-wrap max-h-[280px] overflow-y-auto pr-1">
                      {activeStepObj.thought || '—'}
                    </div>
                  </div>

                  {/* Action — Monospace strictly for commands */}
                  <div className="pt-5 border-t border-white/[0.06] space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                      Action (Command)
                    </div>
                    <pre className="font-mono text-[13px] leading-relaxed px-4 py-3 rounded-lg bg-[#0a0a0a] text-blue-300 overflow-x-auto max-h-44 overflow-y-auto whitespace-pre-wrap">
                      {activeStepObj.action || '—'}
                    </pre>
                  </div>

                  {/* Observation — Monospace strictly for terminal output */}
                  <div className="pt-5 border-t border-white/[0.06] space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                      Observation (Terminal Output)
                    </div>
                    <pre className="font-mono text-xs leading-relaxed px-4 py-3 rounded-lg bg-[#0a0a0a] text-zinc-300 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                      {activeStepObj.observation || '—'}
                    </pre>
                  </div>
                </div>
              ) : null}

              {/* Bottom Step Navigation & Flag Controls */}
              <div className="px-6 py-4 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={currentStepIdx <= (caseData.initial_prompt ? -1 : 0)}
                    onClick={() =>
                      setCurrentStepIdx((i) => Math.max(caseData.initial_prompt ? -1 : 0, i - 1))
                    }
                    className="px-3.5 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-30 text-xs font-medium text-zinc-200 transition cursor-pointer disabled:cursor-not-allowed"
                  >
                    ← Previous
                  </button>
                  <button
                    type="button"
                    disabled={currentStepIdx >= caseData.trajectory.length - 1}
                    onClick={() =>
                      setCurrentStepIdx((i) => Math.min(caseData.trajectory.length - 1, i + 1))
                    }
                    className="px-3.5 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-30 text-xs font-medium text-zinc-200 transition cursor-pointer disabled:cursor-not-allowed"
                  >
                    Next →
                  </button>
                </div>

                {activeStepObj ? (
                  lockedStep === null ? (
                    <button
                      type="button"
                      onClick={() => {
                        setLockedStep(activeStepObj.step);
                        showToast(
                          `Locked Step #${activeStepObj.step} — Root Cause Diagnosis unlocked.`
                        );
                      }}
                      className="px-4 py-2 rounded-lg text-xs font-medium transition flex items-center gap-1.5 cursor-pointer bg-blue-600 hover:bg-blue-500 text-white"
                    >
                      <span>Lock Step #{activeStepObj.step} as Failure Point</span>
                    </button>
                  ) : (
                    <span
                      title="Failure step is locked for this attempt."
                      className="px-3.5 py-2 rounded-lg text-xs font-mono font-medium bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/40 select-none"
                    >
                      Locked: Step #{lockedStep}
                    </span>
                  )
                ) : (
                  <span className="text-xs text-zinc-500">
                    Step 0 is the kickoff prompt
                  </span>
                )}
              </div>
            </section>

            {/* BOTTOM-RIGHT: 3. POST-MORTEM & HARNESS FIX (STRICT PROGRESSIVE DISCLOSURE) */}
            <form
              onSubmit={handleSubmitDiagnosis}
              className="lg:col-span-6 lg:sticky lg:top-20 rounded-xl bg-[#121212] border border-white/[0.07] flex flex-col"
            >
              {/* Card Header + Synced Locked Step Indicator */}
              <div className="px-6 h-12 border-b border-white/[0.06] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-sm font-semibold text-white">
                    3. Post-Mortem &amp; Harness Fix
                  </h3>
                  {savedAttempts[caseData.instance_id] && lockedStep !== null && (
                    <button
                      type="button"
                      onClick={handleResetAttempt}
                      className="text-xs text-zinc-400 hover:text-white underline underline-offset-2 cursor-pointer"
                    >
                      Retake
                    </button>
                  )}
                </div>

                {lockedStep !== null ? (
                  <button
                    type="button"
                    onClick={() => setCurrentStepIdx(lockedStep - 1)}
                    title="Jump to locked failure step"
                    className="inline-flex items-center gap-1.5 text-xs font-mono px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 font-medium hover:bg-amber-500/25 transition cursor-pointer"
                  >
                    <span>Locked: Step #{lockedStep}</span>
                  </button>
                ) : (
                  <span className="text-xs text-zinc-500">Step 1 of 3</span>
                )}
              </div>

              {/* STAGE 1: LOCKED — DO NOT MOUNT Q1 OR Q2 IN DOM */}
              {lockedStep === null ? (
                <div className="p-8 sm:p-10 flex flex-col items-center justify-center text-center space-y-4 min-h-[280px]">
                  <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-zinc-400 text-base">
                    🔒
                  </div>
                  <div className="max-w-sm space-y-2">
                    <p className="font-sans text-[15px] leading-[1.6] text-[#ededed] font-medium">
                      Step 1: Inspect the recorded session and lock the exact failure step to unlock the post-mortem.
                    </p>
                    <p className="text-xs text-zinc-500 leading-relaxed">
                      Navigate steps 1–{caseData.step_count} on the left, then click &ldquo;Lock Step #X as Failure Point&rdquo; to reveal Question 1 without spoilers.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="p-6 space-y-8">
                    {/* STAGE 2: QUESTION 1 (ROOT CAUSE DIAGNOSIS) */}
                    <fieldset className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <legend className="text-sm font-medium text-white leading-snug">
                          Q1. Root Cause Diagnosis — Why did the agent&apos;s patch fail?
                        </legend>
                        {diagnosisConfirmed && (
                          <span className="shrink-0 text-xs font-medium text-emerald-400">
                            ✓ Confirmed
                          </span>
                        )}
                      </div>
                      <div className="space-y-2">
                        {caseData.diagnosis_options.map((opt, idx) => {
                          const selected = diagnosisChoice === opt.id;
                          const letter = OPTION_LETTERS[idx] || String(idx + 1);
                          return (
                            <label
                              key={opt.id}
                              className={`flex items-start gap-3.5 px-4 py-3.5 rounded-lg border transition font-sans text-[15px] leading-[1.55] ${
                                diagnosisConfirmed
                                  ? selected
                                    ? 'bg-blue-500/[0.12] border-blue-500/70 text-white cursor-default'
                                    : 'bg-white/[0.015] border-transparent text-zinc-500 opacity-50 cursor-default'
                                  : selected
                                  ? 'bg-blue-500/[0.12] border-blue-500/80 text-white cursor-pointer'
                                  : 'bg-white/[0.025] border-transparent text-[#ededed] hover:bg-white/[0.055] cursor-pointer'
                              }`}
                            >
                              <input
                                type="radio"
                                name="diagnosis_choice"
                                value={opt.id}
                                checked={selected}
                                disabled={diagnosisConfirmed}
                                onChange={() => setDiagnosisChoice(opt.id)}
                                className="sr-only"
                              />
                              <span
                                className={`w-6 h-6 rounded-md font-mono text-xs font-semibold flex items-center justify-center shrink-0 mt-0.5 ${
                                  selected
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-white/[0.06] text-zinc-400'
                                }`}
                              >
                                {letter}
                              </span>
                              <span>{opt.text}</span>
                            </label>
                          );
                        })}
                      </div>

                      {!diagnosisConfirmed && (
                        <div className="pt-2 flex items-center justify-between gap-3">
                          <span className="text-xs text-zinc-500">
                            Confirm Q1 to unlock the systemic harness question.
                          </span>
                          <button
                            type="button"
                            disabled={!diagnosisChoice}
                            onClick={() => setDiagnosisConfirmed(true)}
                            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-white/[0.06] disabled:text-zinc-500 text-white text-xs font-medium transition cursor-pointer disabled:cursor-not-allowed"
                          >
                            Confirm Diagnosis →
                          </button>
                        </div>
                      )}
                    </fieldset>

                    {/* STAGE 3: QUESTION 2 — MOUNTED ONLY AFTER Q1 IS CONFIRMED */}
                    {diagnosisConfirmed && (
                      <fieldset className="pt-6 border-t border-white/[0.06] space-y-3">
                        <legend className="text-sm font-medium text-white leading-snug">
                          Q2. Systemic Harness Fix — Which repo-agnostic guardrail prevents this failure class?
                        </legend>
                        <div className="space-y-2">
                          {caseData.rescue_options.map((opt, idx) => {
                            const selected = rescueChoice === opt.id;
                            const letter = OPTION_LETTERS[idx] || String(idx + 1);
                            return (
                              <label
                                key={opt.id}
                                className={`flex items-start gap-3.5 px-4 py-3.5 rounded-lg border cursor-pointer transition font-sans text-[15px] leading-[1.55] ${
                                  selected
                                    ? 'bg-blue-500/[0.12] border-blue-500/80 text-white'
                                    : 'bg-white/[0.025] border-transparent text-[#ededed] hover:bg-white/[0.055]'
                                }`}
                              >
                                <input
                                  type="radio"
                                  name="rescue_choice"
                                  value={opt.id}
                                  checked={selected}
                                  onChange={() => setRescueChoice(opt.id)}
                                  className="sr-only"
                                />
                                <span
                                  className={`w-6 h-6 rounded-md font-mono text-xs font-semibold flex items-center justify-center shrink-0 mt-0.5 ${
                                    selected
                                      ? 'bg-blue-600 text-white'
                                      : 'bg-white/[0.06] text-zinc-400'
                                  }`}
                                >
                                  {letter}
                                </span>
                                <span>{opt.text}</span>
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    )}
                  </div>

                  {/* Anchored Submit Footer — Shown Once Q1 Is Confirmed */}
                  {diagnosisConfirmed && (
                    <div className="px-6 py-4 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
                      <span className="text-xs text-zinc-500">
                        {!isReadyToSubmit
                          ? 'Select a systemic harness guardrail to submit.'
                          : '40 pts step (±1 = 25) · 30 pts cause · 30 pts guardrail'}
                      </span>
                      <button
                        type="submit"
                        disabled={submitting || !isReadyToSubmit}
                        className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-white/[0.06] disabled:text-zinc-500 text-white text-sm font-medium transition cursor-pointer disabled:cursor-not-allowed"
                      >
                        {submitting ? 'Grading...' : 'Submit Post-Mortem'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </form>
          </div>
        </main>
      )}

      {/* ==================== POST-SUBMISSION SCORECARD MODAL ==================== */}
      {scorecardOpen && gradeResult && caseData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="w-full max-w-5xl rounded-2xl bg-[#121212] border border-white/[0.1] shadow-2xl overflow-hidden my-auto max-h-[92vh] flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-white">
                  Post-Mortem Scorecard — Case #{caseData.case_number}
                </h3>
                <p className="text-xs text-zinc-400 font-mono mt-0.5">
                  {caseData.instance_id} · Completed in {formattedTime}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setScorecardOpen(false)}
                className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
                aria-label="Close scorecard"
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-6">
              {/* Top Row: Score + Verdict Summary + Share Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-3 rounded-xl bg-[#0a0a0a] p-5 flex flex-col justify-center items-center text-center">
                  <div className="text-xs text-zinc-400">Score</div>
                  <div className="text-4xl font-bold text-white mt-1 font-mono">
                    {gradeResult.score}
                    <span className="text-base text-zinc-500">/100</span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-xs font-mono text-zinc-400">
                    <span>{gradeResult.breakdown.step_points}/40</span>
                    <span>·</span>
                    <span>{gradeResult.breakdown.diagnosis_points}/30</span>
                    <span>·</span>
                    <span>{gradeResult.breakdown.rescue_points}/30</span>
                  </div>
                </div>

                <div className="lg:col-span-5 rounded-xl bg-[#0a0a0a] p-5 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-md ${
                        gradeResult.step_verdict === 'exact'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : gradeResult.step_verdict === 'close'
                          ? 'bg-amber-500/15 text-amber-300'
                          : 'bg-rose-500/15 text-rose-300'
                      }`}
                    >
                      Step: {gradeResult.step_verdict.toUpperCase()} (You: #{lockedStep}, Actual: #{gradeResult.reveal.actual_failure_step})
                    </span>
                    <span className="text-xs font-mono px-2 py-0.5 rounded bg-white/[0.06] text-zinc-300">
                      {gradeResult.reveal.failure_type}
                    </span>
                  </div>
                  <p className="font-sans text-sm text-[#ededed] leading-relaxed">
                    {gradeResult.reveal.root_cause}
                  </p>
                </div>

                <div className="lg:col-span-4 rounded-xl bg-[#0a0a0a] p-5 flex flex-col justify-between gap-3">
                  <pre className="font-mono text-xs leading-relaxed text-zinc-200 whitespace-pre-wrap">
                    {gradeResult.share_grid}
                  </pre>
                  <button
                    type="button"
                    onClick={handleCopyShareGrid}
                    className="w-full py-2 px-3 rounded-lg bg-white/[0.08] hover:bg-white/[0.12] text-xs font-medium text-white transition cursor-pointer"
                  >
                    Copy Share Grid
                  </button>
                </div>
              </div>

              {/* Live Community Benchmark Bar */}
              {gradeResult.case_stats && (
                <div className="rounded-xl bg-[#0a0a0a] px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-zinc-300">
                    Community Benchmark ({caseData.instance_id})
                  </span>
                  <div className="flex flex-wrap items-center gap-4 font-mono text-zinc-400">
                    <span>
                      Attempts: <strong className="text-white">{gradeResult.case_stats.total_attempts}</strong>
                    </span>
                    <span>
                      Avg: <strong className="text-white">{gradeResult.case_stats.avg_score}/100</strong>
                    </span>
                    <span>
                      Exact Step: <strong className="text-blue-300">{gradeResult.case_stats.exact_step_rate_pct}%</strong>
                    </span>
                    <span>
                      100/100: <strong className="text-emerald-300">{gradeResult.case_stats.perfect_rate_pct}%</strong>
                    </span>
                  </div>
                </div>
              )}

              {/* MCQ Verdicts Breakdown */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(['diagnosis', 'rescue'] as const).map((kind) => {
                  const v = gradeResult.mcq_verdicts[kind];
                  const opts =
                    kind === 'diagnosis' ? caseData.diagnosis_options : caseData.rescue_options;
                  const correctOpt = findOptionLabel(opts, v.correct_id);
                  const chosenOpt = findOptionLabel(opts, v.selected_id);
                  return (
                    <div key={kind} className="rounded-xl bg-[#0a0a0a] p-5 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-white">
                          {kind === 'diagnosis' ? 'Root Cause Diagnosis' : 'Systemic Harness Fix'}
                        </span>
                        <span
                          className={`text-xs font-mono font-semibold ${
                            v.correct ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {v.correct ? '✓ Correct (+30)' : '✕ Incorrect (+0)'}
                        </span>
                      </div>
                      <p className="font-sans text-sm text-zinc-300 leading-relaxed">{v.explanation}</p>
                      {!v.correct && correctOpt && (
                        <div className="p-3 rounded-lg bg-emerald-500/10 text-xs text-emerald-200 leading-relaxed">
                          <span className="font-semibold font-mono">Correct ({correctOpt.letter}): </span>
                          {correctOpt.text}
                        </div>
                      )}
                      {v.correct && chosenOpt && (
                        <div className="p-3 rounded-lg bg-emerald-500/10 text-xs text-emerald-200 leading-relaxed">
                          <span className="font-semibold font-mono">Selected ({chosenOpt.letter}): </span>
                          {chosenOpt.text}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Side-by-Side Patch Comparison */}
              <div className="space-y-2.5">
                <h4 className="text-xs font-semibold text-zinc-300">
                  Patch Comparison: Agent&apos;s Broken Patch vs. Ground-Truth Gold Patch
                </h4>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="rounded-xl bg-[#0a0a0a] overflow-hidden flex flex-col">
                    <div className="px-4 py-2.5 bg-rose-500/10 text-xs font-medium text-rose-300 flex items-center justify-between">
                      <span>Broken Patch (Submitted by Agent)</span>
                      <span className="font-mono text-[11px] text-rose-400/80">FAILED TESTS</span>
                    </div>
                    <div className="p-3 max-h-64 overflow-auto">
                      <DiffViewer diff={gradeResult.reveal.broken_patch} />
                    </div>
                  </div>

                  <div className="rounded-xl bg-[#0a0a0a] overflow-hidden flex flex-col">
                    <div className="px-4 py-2.5 bg-emerald-500/10 text-xs font-medium text-emerald-300 flex items-center justify-between">
                      <span>Gold Patch (Reference Fix)</span>
                      <span className="font-mono text-[11px] text-emerald-400/80">PASSES SUITE</span>
                    </div>
                    <div className="p-3 max-h-64 overflow-auto">
                      <DiffViewer diff={gradeResult.reveal.gold_patch} />
                    </div>
                  </div>
                </div>
              </div>

              {/* B2B Recruiter CTA */}
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-5 flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold text-white">
                    Want to evaluate engineering candidates on real agent traces?
                  </p>
                  <p className="text-xs text-zinc-400">
                    Generate a shareable assessment link for your hiring pipeline.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setBetaLinkCreated(null);
                    setBetaModalOpen(true);
                  }}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition shrink-0 cursor-pointer"
                >
                  Create Assessment Link
                </button>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setCurrentStepIdx(gradeResult.reveal.actual_failure_step - 1);
                  setScorecardOpen(false);
                }}
                className="px-4 py-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-zinc-200 text-xs font-medium transition cursor-pointer"
              >
                Jump to Step #{gradeResult.reveal.actual_failure_step}
              </button>
              <button
                type="button"
                onClick={handleNextCase}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition cursor-pointer"
              >
                Next Challenge Case →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== LIGHTWEIGHT SELF-SERVE BETA / LINK MODAL ==================== */}
      {betaModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#121212] border border-white/[0.1] shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                Create Candidate Assessment Link
              </h3>
              <button
                type="button"
                onClick={() => setBetaModalOpen(false)}
                className="text-zinc-400 hover:text-white text-sm cursor-pointer"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Generate a shareable challenge link for your hiring pipeline or join the Pro waitlist to upload internal failed agent sessions.
            </p>
            <form onSubmit={handleCreateAssessmentLink} className="space-y-3">
              <input
                type="email"
                required
                value={betaEmail}
                onChange={(e) => setBetaEmail(e.target.value)}
                placeholder="work-email@company.com"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#0a0a0a] border border-white/[0.1] focus:border-blue-500 outline-none text-sm text-white"
              />
              <button
                type="submit"
                className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition cursor-pointer"
              >
                Generate Shareable Assessment Link
              </button>
            </form>
            {betaLinkCreated && (
              <div className="p-3 rounded-lg bg-[#0a0a0a] border border-emerald-500/30 space-y-1.5">
                <div className="text-xs font-medium text-emerald-400">
                  ✓ Assessment Link Copied to Clipboard
                </div>
                <div className="font-mono text-xs text-zinc-300 break-all">
                  {betaLinkCreated}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== ATTRIBUTION & LICENSES FOOTER ==================== */}
      <footer className="border-t border-white/[0.06] bg-[#0a0a0a] mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
          <div>
            Adapted from{' '}
            <a
              href="https://huggingface.co/datasets/nebius/SWE-agent-trajectories"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
            >
              nebius/SWE-agent-trajectories
            </a>{' '}
            &amp;{' '}
            <a
              href="https://huggingface.co/datasets/nebius/SWE-bench-extra"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
            >
              nebius/SWE-bench-extra
            </a>{' '}
            (CC BY 4.0) · Permissively licensed open-source repositories.
          </div>
          <button
            type="button"
            onClick={() => setLicenseModalOpen(true)}
            className="text-zinc-400 hover:text-white underline underline-offset-2 cursor-pointer"
          >
            Licenses &amp; Notices
          </button>
        </div>
      </footer>

      {/* ==================== 24-CASE SELECTOR DRAWER / MODAL ==================== */}
      {caseDrawerOpen && (
        <div
          onClick={() => setCaseDrawerOpen(false)}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/75 backdrop-blur-sm p-4 pt-12 sm:pt-16 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl rounded-2xl bg-[#121212] border border-white/[0.1] shadow-2xl overflow-hidden flex flex-col max-h-[82vh]"
          >
            {/* Drawer Header */}
            <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Challenge Case Bank ({cases.length} Recorded Sessions)
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Ordered from quick onboarding cases to deep multi-step sessions · Solved {solvedCount} of {cases.length}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCaseDrawerOpen(false)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
                aria-label="Close case selector"
              >
                ✕
              </button>
            </div>

            {/* Filter Pills + Search */}
            <div className="px-6 py-3 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                {(['All', 'Easy', 'Medium', 'Hard', 'Unsolved'] as const).map((tab) => {
                  const active = caseFilter === tab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setCaseFilter(tab)}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition cursor-pointer ${
                        active
                          ? 'bg-blue-600/20 text-blue-300'
                          : 'text-zinc-400 hover:text-white hover:bg-white/[0.05]'
                      }`}
                    >
                      {tab}
                    </button>
                  );
                })}
              </div>

              <input
                type="text"
                value={caseSearch}
                onChange={(e) => setCaseSearch(e.target.value)}
                placeholder="Filter by repo or issue..."
                className="w-full sm:w-56 px-3 py-1.5 rounded-lg bg-[#0a0a0a] border border-white/[0.08] focus:border-blue-500 outline-none text-xs text-white placeholder-zinc-500"
              />
            </div>

            {/* Scrollable Case List */}
            <div className="divide-y divide-white/[0.05] overflow-y-auto">
              {filteredCases.length === 0 ? (
                <div className="p-8 text-center text-xs text-zinc-500">
                  No cases match the current filter.
                </div>
              ) : (
                filteredCases.map((c) => {
                  const isCurrent = c.instance_id === activeCaseId;
                  const score = completedScores[c.instance_id];
                  const shortRepo = formatShortCaseName(c);
                  return (
                    <button
                      key={c.instance_id}
                      type="button"
                      onClick={() => {
                        setActiveCaseId(c.instance_id);
                        setCaseDrawerOpen(false);
                      }}
                      className={`w-full px-6 py-3.5 text-left flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 transition cursor-pointer ${
                        isCurrent ? 'bg-blue-500/[0.1]' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-zinc-500 w-7 shrink-0">
                            #{c.case_number}
                          </span>
                          <span className="text-sm font-medium text-white">{shortRepo}</span>
                          <span className="text-xs font-mono text-zinc-500 hidden md:inline">
                            ({c.repo})
                          </span>
                          {isCurrent && (
                            <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 text-[10px] font-semibold leading-none">
                              ACTIVE
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-400 truncate pl-9">{c.title}</p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 pl-9 sm:pl-0">
                        <span className="text-xs font-mono text-zinc-400">{c.step_count} steps</span>
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${difficultyBadgeStyle(
                            c.difficulty
                          )}`}
                        >
                          {c.difficulty}
                        </span>
                        {score !== undefined ? (
                          <span className="w-14 text-right text-emerald-400 font-mono text-xs font-medium">
                            ✓ {score}
                          </span>
                        ) : (
                          <span className="w-14 text-right text-zinc-600 text-xs">—</span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== LICENSES & THIRD-PARTY NOTICES MODAL ==================== */}
      {licenseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-2xl bg-[#121212] border border-white/[0.1] shadow-2xl overflow-hidden my-auto max-h-[88vh] flex flex-col">
            <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                Open-Source Data &amp; License Notices
              </h3>
              <button
                type="button"
                onClick={() => setLicenseModalOpen(false)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition cursor-pointer"
                aria-label="Close license notices"
              >
                ✕
              </button>
            </div>
            <div className="p-6 overflow-y-auto space-y-4 text-sm text-zinc-300 leading-relaxed">
              <div className="space-y-1.5">
                <h4 className="font-semibold text-white">
                  1. Datasets — Creative Commons Attribution 4.0 (CC BY 4.0)
                </h4>
                <p>
                  Recorded agent sessions and benchmark patch pairs are adapted from{' '}
                  <a
                    href="https://huggingface.co/datasets/nebius/SWE-agent-trajectories"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline font-mono text-xs"
                  >
                    nebius/SWE-agent-trajectories
                  </a>{' '}
                  and{' '}
                  <a
                    href="https://huggingface.co/datasets/nebius/SWE-bench-extra"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline font-mono text-xs"
                  >
                    nebius/SWE-bench-extra
                  </a>{' '}
                  by Nebius under CC BY 4.0.
                </p>
              </div>

              <div className="space-y-1.5">
                <h4 className="font-semibold text-white">
                  2. Upstream Open-Source Repositories (MIT / BSD / Apache-2.0)
                </h4>
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1 pl-4 list-disc font-mono text-xs text-zinc-300">
                  {Array.from(new Set(cases.map((c) => c.repo).filter(Boolean))).map((repo) => (
                    <li key={repo}>
                      <a
                        href={`https://github.com/${repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline"
                      >
                        {repo}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== TOAST NOTIFICATION ==================== */}
      <div
        className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] pointer-events-none transition-all duration-200 ${
          toastMessage ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
        }`}
      >
        {toastMessage && (
          <div className="px-4 py-2 rounded-lg bg-white text-zinc-950 text-xs font-semibold shadow-xl">
            {toastMessage}
          </div>
        )}
      </div>
    </div>
  );
}
