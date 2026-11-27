export interface CaseSummary {
  instance_id: string;
  case_number: number;
  title: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  repo: string;
  step_count: number;
}

export interface TrajectoryStep {
  step: number;
  thought: string;
  action: string;
  observation: string;
}

export interface McqOption {
  id: string;
  text: string;
}

export interface PublicCase {
  instance_id: string;
  case_number: number;
  title: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  repo: string;
  base_commit: string;
  model_name: string;
  source_dataset: string;
  initial_prompt: string;
  step_count: number;
  problem_statement: string;
  broken_patch: string;
  trajectory: TrajectoryStep[];
  diagnosis_options: McqOption[];
  rescue_options: McqOption[];
}

export interface GradeRequest {
  instance_id: string;
  selected_step: number;
  diagnosis_choice: string;
  rescue_choice: string;
  elapsed_seconds?: number;
  invite_code?: string;
}

export interface McqVerdictItem {
  correct: boolean;
  selected_id: string;
  correct_id: string;
  explanation: string;
}

export interface CaseLiveStats {
  total_attempts: number;
  avg_score: number;
  perfect_rate_pct: number;
  exact_step_rate_pct: number;
}

export interface GradeResponse {
  score: number;
  breakdown: {
    step_points: number;
    diagnosis_points: number;
    rescue_points: number;
  };
  step_verdict: 'exact' | 'close' | 'miss';
  mcq_verdicts: {
    diagnosis: McqVerdictItem;
    rescue: McqVerdictItem;
  };
  feedback: string;
  reveal: {
    actual_failure_step: number;
    failure_type: string;
    root_cause: string;
    rescue_prompt_criteria: string;
    broken_patch: string;
    gold_patch: string;
  };
  share_grid: string;
  case_stats?: CaseLiveStats | null;
}
