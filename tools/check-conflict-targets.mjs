#!/usr/bin/env node
// ACBP static check — `ON CONFLICT ON CONSTRAINT` must never name a unique INDEX.
//
// WHY THIS EXISTS (D1). `credit_transactions_reservation_key_uq` is created with `CREATE UNIQUE INDEX ... WHERE ...`.
// A partial unique index is the ONLY way to express a scoped uniqueness rule in PostgreSQL — unique CONSTRAINTS
// cannot carry a `WHERE`. But `ON CONFLICT ON CONSTRAINT <name>` accepts only a real table constraint, so targeting
// an index by name raises `42704: constraint ... does not exist` AT RUNTIME, on the first row that reaches it. In
// this repository that first row was a credit reservation: no reservation could ever succeed, and the money path was
// dead until a real database ran it. Nothing in typecheck, lint or a unit test could see it.
//
// The rule is exact and has no false-positive shape: an index name is never a valid `ON CONFLICT ON CONSTRAINT`
// target, partial or not. Use inference instead — `.onConflict(oc => oc.columns([...]).where(...))` — which matches
// the index by its columns and predicate.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'packages', 'database', 'migrations');
const SCAN_ROOTS = [join(ROOT, 'packages'), join(ROOT, 'apps'), join(ROOT, 'tests')];
const SKIP = new Set(['node_modules', 'dist', 'build', '.next', '.turbo']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|mts|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

// ── 1. Every index name the migrations create ────────────────────────────────────────────────────────────────
const indexNames = new Map(); // name -> { file, partial }
for (const file of walk(MIGRATIONS)) {
  const src = readFileSync(file, 'utf8');
  // `create [unique] index [concurrently] [if not exists] <name> on <table> (...) [where ...]`
  const re = /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on\s+([^;`]*)/gi;
  for (const m of src.matchAll(re)) {
    indexNames.set(m[1], { file: relative(ROOT, file), partial: /\bwhere\b/i.test(m[2] ?? '') });
  }
}

// ── 2. Every ON CONFLICT target named as a constraint ────────────────────────────────────────────────────────
const violations = [];
for (const root of SCAN_ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    const targets = [];
    // Kysely: .onConflict(oc => oc.constraint('name')...)
    for (const m of src.matchAll(/\.constraint\(\s*['"`]([a-z0-9_]+)['"`]\s*\)/gi)) {
      targets.push({ name: m[1], form: '.constraint(...)', index: m.index ?? 0 });
    }
    // Raw SQL: on conflict on constraint name
    for (const m of src.matchAll(/on\s+conflict\s+on\s+constraint\s+([a-z0-9_]+)/gi)) {
      targets.push({ name: m[1], form: 'ON CONFLICT ON CONSTRAINT', index: m.index ?? 0 });
    }
    for (const t of targets) {
      const hit = indexNames.get(t.name);
      if (!hit) continue;
      const line = src.slice(0, t.index).split('\n').length;
      violations.push({ file: relative(ROOT, file), line, ...t, createdIn: hit.file, partial: hit.partial });
    }
  }
}

if (violations.length > 0) {
  console.error('\n✖ ON CONFLICT targets a unique INDEX, which PostgreSQL rejects at runtime (42704):\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.form} names "${v.name}", created as a ${v.partial ? 'PARTIAL ' : ''}unique INDEX in ${v.createdIn}.`);
    console.error(`    ON CONFLICT ON CONSTRAINT accepts only a real table CONSTRAINT. Target it by inference instead:`);
    console.error(`      .onConflict((oc) => oc.columns([...]).where(...).doNothing())`);
    console.error(`    The predicate must match the index's own WHERE clause.\n`);
  }
  console.error(`${violations.length} violation(s).\n`);
  process.exit(1);
}

// ── 3. NEGATIVE SELF-TEST ────────────────────────────────────────────────────────────────────────────────────
// A checker that stops matching becomes a checker that always passes — the same "guard written but never applied"
// failure this tool exists to catch, one level up. So prove the detector still fires on a synthetic defect before
// reporting a clean tree. If these regexes ever drift, THIS fails rather than the tree going quietly green.
{
  const idx = /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on\s+([^;`]*)/gi;
  const probeIndex = [...'create unique index probe_uq on t (a, b) where kind = 1'.matchAll(idx)];
  const kysely = [...`.constraint('probe_uq')`.matchAll(/\.constraint\(\s*['"`]([a-z0-9_]+)['"`]\s*\)/gi)];
  const raw = [...'on conflict on constraint probe_uq'.matchAll(/on\s+conflict\s+on\s+constraint\s+([a-z0-9_]+)/gi)];
  const ok =
    probeIndex.length === 1 && probeIndex[0][1] === 'probe_uq' && /\bwhere\b/i.test(probeIndex[0][2] ?? '') && kysely[0]?.[1] === 'probe_uq' && raw[0]?.[1] === 'probe_uq';
  if (!ok) {
    console.error('✖ conflict-target check FAILED ITS OWN SELF-TEST — the detector no longer recognises a known defect.');
    console.error('  A clean result from this tool would be meaningless. Fix the patterns before trusting a pass.');
    process.exit(2);
  }
}

const partials = [...indexNames.values()].filter((x) => x.partial).length;
console.log(`✔ conflict-target check: ${indexNames.size} index name(s) known (${partials} partial); no ON CONFLICT names one. Self-test passed.`);
