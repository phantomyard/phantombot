/**
 * Evaluate the Jev backends against the bundled corpora (issue #597).
 *
 *   bun scripts/evalJevJudge.ts            # threat-judge corpus (default)
 *   bun scripts/evalJevJudge.ts --router   # brain-swap router corpus
 *
 * Requires a working credential, exactly like production: an API key in the
 * env (default PHANTOMBOT_JEV_API_KEY; override with --key-env NAME) and a
 * reachable endpoint (--base-url, default OpenRouter; --model, default
 * typesafe/jev-1.13). With no key the script says so and exits 2 — it never
 * silently "passes".
 *
 * The judge report leads with the FALSE-NEGATIVE rate on injection cases —
 * the number that matters for a security control: an injection scored below
 * the hold threshold is an unscreened prompt. A screener that is fast and
 * cheap but misses injection is worse than the harness judge it replaces,
 * so the default exit code is 1 when any injection case is missed
 * (--allow-false-negatives downgrades that to a report).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { jevJudgeThreat } from "../src/lib/jevJudge.ts";
import { jevRoute } from "../src/lib/jevRouter.ts";
import {
  JEV_DEFAULT_KEY_ENV,
  JEV_DEFAULT_MODEL,
  JEV_OPENROUTER_BASE_URL,
} from "../src/lib/jev.ts";

interface JudgeCase {
  id: string;
  kind: string;
  expect: "hold" | "allow";
  content: string;
  priors?: string;
  note?: string;
}
interface JudgeCorpus {
  threshold: number;
  cases: JudgeCase[];
}
interface RouterCase {
  id: string;
  expect: "primary" | "coder";
  text: string;
  history?: string[];
  note?: string;
}
interface RouterCorpus {
  cases: RouterCase[];
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

const keyEnv = arg("--key-env") ?? JEV_DEFAULT_KEY_ENV;
const apiKey = process.env[keyEnv]?.trim();
const baseUrl = arg("--base-url") ?? JEV_OPENROUTER_BASE_URL;
const model = arg("--model") ?? JEV_DEFAULT_MODEL;

if (!apiKey) {
  console.error(
    `no API key: set ${keyEnv} (or pass --key-env NAME). ` +
      "The eval never runs against a guessed credential.",
  );
  process.exit(2);
}

const settings = { baseUrl, apiKey, model };

if (has("--router")) {
  await evalRouter();
} else {
  await evalJudge();
}

async function evalJudge(): Promise<void> {
  const path = join(import.meta.dir, "../tests/fixtures/jev-judge-corpus.json");
  const corpus = JSON.parse(await readFile(path, "utf8")) as JudgeCorpus;
  const threshold = Number(arg("--threshold")) || corpus.threshold;

  console.log(
    `jev judge eval — ${corpus.cases.length} cases, threshold ${threshold}, ${baseUrl}, ${model}\n`,
  );

  let falseNegatives = 0;
  let falsePositives = 0;
  let errors = 0;
  let latencySum = 0;
  const injectionCases = corpus.cases.filter((c) => c.kind === "injection");

  for (const c of corpus.cases) {
    const r = await jevJudgeThreat(c.content, {
      settings,
      priors: c.priors,
    });
    if (!r.ok) {
      errors++;
      console.log(`ERR   ${c.id}: ${r.error}`);
      continue;
    }
    latencySum += r.latencyMs ?? 0;
    const held = r.verdict.score >= threshold;
    const expected = c.expect === "hold";
    const miss = held !== expected;
    if (miss && expected) falseNegatives++;
    if (miss && !expected) falsePositives++;
    const mark = miss ? (expected ? "FN ✗" : "FP ✗") : "ok  ";
    console.log(
      `${mark}  ${c.id}  score=${r.verdict.score} expect=${c.expect}` +
        (miss && c.note ? `\n       ${c.note}` : ""),
    );
  }

  const judged = corpus.cases.length - errors;
  const fnRate =
    injectionCases.length > 0
      ? falseNegatives / injectionCases.length
      : 0;
  console.log(
    `\n${judged}/${corpus.cases.length} judged (${errors} errors) · ` +
      `false negatives on injection: ${falseNegatives}/${injectionCases.length} (${(fnRate * 100).toFixed(1)}%) · ` +
      `false positives: ${falsePositives} · ` +
      `avg latency ${Math.round(latencySum / Math.max(1, judged))}ms`,
  );

  if (falseNegatives > 0 && !has("--allow-false-negatives")) {
    console.error(
      "\nFALSE NEGATIVES on injection cases — a screener that misses " +
        "injection is worse than the one it replaces. Failing.",
    );
    process.exit(1);
  }
}

async function evalRouter(): Promise<void> {
  const path = join(import.meta.dir, "../tests/fixtures/jev-router-corpus.json");
  const corpus = JSON.parse(await readFile(path, "utf8")) as RouterCorpus;

  console.log(
    `jev router eval — ${corpus.cases.length} cases, ${baseUrl}, ${model}\n`,
  );

  let misses = 0;
  let errors = 0;
  let latencySum = 0;
  for (const c of corpus.cases) {
    const r = await jevRoute({ settings, text: c.text, history: c.history });
    if (!r.ok) {
      errors++;
      console.log(`ERR   ${c.id}: ${r.error}`);
      continue;
    }
    latencySum += r.latencyMs;
    const miss = r.route !== c.expect;
    if (miss) misses++;
    console.log(
      `${miss ? "MISS ✗" : "ok  "}  ${c.id}  route=${r.route} (${r.confidence.toFixed(2)}) expect=${c.expect}` +
        (miss && c.note ? `\n       ${c.note}` : ""),
    );
  }
  const judged = corpus.cases.length - errors;
  console.log(
    `\n${judged}/${corpus.cases.length} routed (${errors} errors) · ` +
      `disagreements: ${misses} · avg latency ${Math.round(latencySum / Math.max(1, judged))}ms`,
  );
  // Routing quality is not a security gate — report, don't fail the run.
}
