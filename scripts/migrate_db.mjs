import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';

function loadEnvLocal() {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const raw of fs.readFileSync(p, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k && !process.env[k]) process.env[k] = v;
    }
  }
}

loadEnvLocal();

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const schemaPath = path.join(process.cwd(), 'db', 'schema.sql');
const rawSql = fs.readFileSync(schemaPath, 'utf-8');

const statements = rawSql
  .split(';')
  .map((s) =>
    s
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim()
  )
  .filter(Boolean);

for (const stmt of statements) {
  await sql.query(stmt);
  console.log('[OK] Applied:', stmt.split('\n')[0]);
}

const tables = await sql`
  select table_name
  from information_schema.tables
  where table_schema = 'public'
  order by table_name
`;
console.log('[OK] Verified Neon tables:', tables.map((t) => t.table_name));
