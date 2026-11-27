-- AgentForensics Neon Postgres Schema
-- Follows Postgres best practices: identity PKs, text + check constraints,
-- timestamptz, and covering composite index for per-case live stats.

create table if not exists submissions (
  id bigint generated always as identity primary key,
  instance_id text not null,
  selected_step integer not null,
  step_verdict text not null check (step_verdict in ('exact', 'close', 'miss')),
  diagnosis_choice text not null,
  diagnosis_correct boolean not null,
  rescue_choice text not null,
  rescue_correct boolean not null,
  score smallint not null check (score >= 0 and score <= 100),
  elapsed_seconds integer check (elapsed_seconds is null or elapsed_seconds >= 0),
  invite_code text,
  created_at timestamptz not null default now()
);

create index if not exists submissions_instance_score_idx
  on submissions (instance_id, score);

create index if not exists submissions_created_at_idx
  on submissions (created_at desc);

create table if not exists waitlist_leads (
  id bigint generated always as identity primary key,
  email text not null,
  instance_id text,
  invite_code text,
  created_at timestamptz not null default now()
);

create unique index if not exists waitlist_leads_email_lower_idx
  on waitlist_leads (lower(email));
