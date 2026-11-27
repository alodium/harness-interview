# Harness Interview (`harness-interview`)

An open-source developer assessment and post-mortem challenge for the AI-agent era. Engineers inspect **24 real recorded SWE-agent failure sessions** (Initial Task & Final Broken Output + Step-by-Step Recorded Agent Session starting from Step 0) and must:

1. **Pinpoint the exact failure step** (`40 pts` exact, `25 pts` ±1 step).
2. **Diagnose the technical root cause** (`30 pts` 4-option MCQ).
3. **Select the Systemic Harness / Guardrail Fix** — a repo-agnostic hook, policy, or tool constraint that prevents that entire class of failure across any repository (`30 pts` 4-option MCQ).

## Architecture & Public-Repo Safety
- **Zero Runtime LLM API Keys / \$0 Grading Cost:** 100% deterministic server-side grading on Next.js API routes / Vercel Serverless Functions.
- **Public Cases, Private Answer Keys:**
  - `data/cases/*.json` contains **only sanitized public session payloads** (task, broken diff, neutral steps, and MCQ options with opaque hashes) — completely safe to commit to a public repository.
  - Real answer keys live exclusively in `private_data/answer_keys.json` (gitignored) and are hosted in a **Private GitHub Gist** in production.
  - `POST /api/grade` loads answer keys in strict priority order:
    1. `process.env.ANSWER_KEYS_URL` (fetched with `process.env.GITHUB_TOKEN` and cached in memory for 5 minutes).
    2. Local `private_data/answer_keys.json` during local development.
    3. Fallback to `data/answer_keys.example.json` (dummy keys so open-source contributors can run the app and test grading locally out of the box).
- **Zero UI Spoilers:** All steps `1..N` render identically prior to submission, and MCQ options are Fisher-Yates shuffled on every `GET /api/case` request.

## Local Development (Open-Source Contributors)

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Without `private_data/answer_keys.json` or `ANSWER_KEYS_URL`, `/api/grade` automatically falls back to `data/answer_keys.example.json`.

## Production Deployment (Private Answer Keys via GitHub Gist)

1. Upload `private_data/answer_keys.json` to a **Secret/Private GitHub Gist**:
   ```bash
   gh gist create private_data/answer_keys.json -d "Harness Interview Answer Keys"
   ```
2. Create a GitHub Personal Access Token (fine-grained or classic with `gist` read scope).
3. Add these environment variables in Vercel (**Settings → Environment Variables**):
   - `ANSWER_KEYS_URL` = `https://api.github.com/gists/<GIST_ID>` (or the raw Gist URL)
   - `GITHUB_TOKEN` = `<your_github_token>`
   - `DATABASE_URL` = *(optional)* Neon Serverless Postgres connection string for live community stats.

## Production Build & Zero-Leak Verification
```bash
npm run build
npm run start
# In a second terminal:
python3 scripts/verify_e2e.py http://127.0.0.1:3000
```

## Data Provenance, Attribution & Licenses
- Recorded agent sessions and benchmark problem/patch pairs are adapted from [`nebius/SWE-agent-trajectories`](https://huggingface.co/datasets/nebius/SWE-agent-trajectories) and [`nebius/SWE-bench-extra`](https://huggingface.co/datasets/nebius/SWE-bench-extra) under **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**.
- All 24 upstream repositories are permissively licensed (**MIT / BSD / Apache-2.0**).
- Full attribution and license notices are documented in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and accessible in the web app footer.
