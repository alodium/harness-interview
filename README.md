# Harness Interview (`harness-interview`)

**Live Demo:** https://harness-interview.vercel.app

An open-source developer assessment and post-mortem challenge for the AI-agent era. Engineers inspect **24 real recorded SWE-agent failure sessions** (Initial Task & Final Broken Output + Step-by-Step Recorded Agent Session starting from Step 0) using **strict progressive disclosure**:

1. **Lock the exact failure step** (`40 pts` exact, `25 pts` ±1 step) — Q1 and Q2 stay unmounted until committed.
2. **Confirm the technical root cause** (`30 pts` 4-option MCQ) — unlocks Q2 only after Q1 is confirmed.
3. **Select the Systemic Harness / Guardrail Fix** — a repo-agnostic hook, policy, or tool constraint that prevents that entire class of failure across any repository (`30 pts` 4-option MCQ).

## Architecture & Public-Repo Safety
- **Zero Runtime LLM API Keys / $0 Grading Cost:** 100% deterministic server-side grading on Next.js API routes / Vercel Serverless Functions.
- **Public Cases, Private Answer Keys:**
  - `data/cases/*.json` contains **only sanitized public session payloads** (task, broken diff, neutral steps, and MCQ options with opaque hashes) — completely safe in a public repository.
  - Real answer keys live exclusively in `private_data/answer_keys.json` (gitignored) and are hosted in a **Secret GitHub Gist** in production.
  - `POST /api/grade` loads answer keys in strict priority order:
    1. `process.env.ANSWER_KEYS_URL` (optional `process.env.GITHUB_TOKEN` for private Gist API URLs; cached in memory for 5 minutes).
    2. Local `private_data/answer_keys.json` during local development.
    3. Fallback to `data/answer_keys.example.json` (dummy keys so open-source contributors can run the app and test grading locally out of the box).
- **Zero UI Spoilers:** All steps `1..N` render identically prior to submission, MCQ options are Fisher-Yates shuffled on every `GET /api/case` request, and locked questions are never mounted in the DOM.

## Local Development (Open-Source Contributors)

```bash
git clone https://github.com/alodium/harness-interview.git
cd harness-interview
npm install
npm run dev
```

Open `http://localhost:3000`. Without `private_data/answer_keys.json` or `ANSWER_KEYS_URL`, `/api/grade` automatically falls back to `data/answer_keys.example.json` so every flow works out of the box.

## Self-Hosting with Your Own Private Answer Keys

1. Copy `data/answer_keys.example.json` to `private_data/answer_keys.json` and fill in your real answer keys (file is gitignored).
2. Upload `private_data/answer_keys.json` to a **Secret GitHub Gist**:
   ```bash
   gh gist create private_data/answer_keys.json -d "Harness Interview Answer Keys"
   ```
3. Add these environment variables in Vercel (**Settings → Environment Variables**):
   - `ANSWER_KEYS_URL` = Raw Secret Gist URL (`https://gist.githubusercontent.com/<user>/<gist_id>/raw/answer_keys.json`) or GitHub Gist API URL (`https://api.github.com/gists/<gist_id>`).
   - `GITHUB_TOKEN` = *(optional)* GitHub PAT with `gist` read access (only needed if using the Gist API URL instead of the raw Secret Gist URL).
   - `DATABASE_URL` = *(optional)* Neon Serverless Postgres connection string (`db/schema.sql`) for live community stats and assessment links.

## Production Build & Zero-Leak Verification
```bash
npm run build
npm run start
# In a second terminal:
python3 scripts/verify_e2e.py http://127.0.0.1:3000
```
*(Automatically uses `private_data/answer_keys.json` if present, or falls back to `data/answer_keys.example.json` on fresh clones.)*

## Data Provenance, Attribution & Licenses
- App source code is licensed under the **[MIT License](./LICENSE)**.
- Recorded agent sessions and benchmark problem/patch pairs are adapted from [`nebius/SWE-agent-trajectories`](https://huggingface.co/datasets/nebius/SWE-agent-trajectories) and [`nebius/SWE-bench-extra`](https://huggingface.co/datasets/nebius/SWE-bench-extra) under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**.
- All upstream repositories are permissively licensed (**MIT / BSD-3-Clause / Apache-2.0**). Full attribution is documented in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and accessible in the web app footer.
