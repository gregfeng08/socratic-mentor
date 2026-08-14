#!/usr/bin/env node
// =============================================================================
// Socratic Mentor
//
// Watches a directory and, on each save, hands Claude the full diff of everything
// you've changed since launch — configured as a mentor that teaches by asking
// questions, never by writing the code for you.
//
// Two things feed the same ongoing conversation:
//   1. You save a file   -> the mentor sees what changed and reacts.
//   2. You type a reply  -> answer its questions, ask your own.
//
// Config lives in config.json. Nothing here is specific to graphics — point
// `watchPath` at anything you're learning.
// =============================================================================

import "dotenv/config"; // loads ANTHROPIC_API_KEY from a local .env file if present
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createPatch } from "diff";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
// config.json is gitignored (it holds your paths/prefs). On a fresh clone, seed
// it from the committed template so the app still runs.
if (!fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(path.join(__dirname, "config.example.json"), CONFIG_PATH);
  console.log("Created config.json from config.example.json.");
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

// Resolved from cfg — recomputed after the first-run wizard may change paths.
let WATCH_ROOT, PROJECT_ROOT, MEMORY_PATH, GOAL_PATH;
function resolvePaths() {
  WATCH_ROOT = path.resolve(__dirname, cfg.watchPath);
  PROJECT_ROOT = path.resolve(__dirname, cfg.projectRoot);
  MEMORY_PATH = path.join(__dirname, cfg.memoryFile);
  GOAL_PATH = path.join(__dirname, cfg.goalFile);
}
resolvePaths();

// ANSI helpers for a readable terminal.
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

// -----------------------------------------------------------------------------
// The mentor's character. This is the whole product — tune it freely.
// -----------------------------------------------------------------------------
const SYSTEM = `You are a patient, sharp programming mentor sitting beside a learner who is building a
project and wants to learn by doing. They have explicitly asked you NOT to write their code for them —
they want to work it out themselves, with you as a Socratic guide.

Hard rules:
- Never write a working solution, a full function, or more than a tiny illustrative fragment
  (at most a line or two, and only to disambiguate a concept — never the thing they're stuck on).
- Teach by asking. Prefer a pointed question that makes them notice the problem themselves over
  telling them the answer.
- When they are genuinely stuck (they say so, or the same mistake persists), give the SMALLEST
  possible hint that unblocks them — a concept to look up, the name of a function, the direction
  the bug is in — not the fix.
- Be brief. One to three sentences or questions per turn. This is a live coding session, not an essay.
- Meet them where they are. If they just wrote something correct, say so in a few words and point at
  the next interesting question. If they wrote a bug, ask a question that leads them to it.
- Use correct terminology for whatever domain they are working in, and let them look the rest up.

You receive a unified diff of everything the learner has changed since this session started, plus a
note of which file they just saved. Focus on the latest edit but use the whole diff for context. You
will not see whole files unless told; ask when you need more. The learner's stated goal and a one-time
overview of their codebase follow — ground your questions in those.`;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const fileSnapshots = new Map(); // absolute path -> current contents
const baseline = new Map(); // absolute path -> contents captured at session start
const messages = []; // the running conversation with the mentor
let sendWholeFile = false; // when true, saves include the full file, not just the diff
let projectContext = ""; // one-time codebase summary, loaded from / written to MEMORY_PATH
let projectGoal = ""; // the learner's own description of what they're building & want to learn
let awaitingGoal = false; // true on first run until they've described their goal
let awaitingSetup = false; // true while the first-run config wizard is running
let setupSteps = [];
let setupIndex = 0;
let setupResolve = null;

const client = new Anthropic(); // reads ANTHROPIC_API_KEY, or an `ant auth login` profile

// Serialize turns so file saves and typed replies never overlap a request.
let chain = Promise.resolve();
function enqueue(userContent) {
  messages.push({ role: "user", content: userContent });
  chain = chain.then(runTurn).catch((err) => {
    console.error("\n" + c.yellow("mentor error: ") + (err?.message || err));
    reprompt();
  });
}

// The goal + codebase overview are stable across the whole session, so we send
// them as ONE cached system block. After the first turn Claude reads it back at
// ~10% of the input price instead of re-billing it every message.
function buildSystem() {
  let text = SYSTEM;
  if (projectGoal) {
    text += `\n\n== The learner's project & goal, in their own words ==\n${projectGoal}`;
  }
  if (projectContext) {
    text += `\n\n== One-time overview of the codebase (you see only diffs during the session — lean on this) ==\n${projectContext}`;
  }
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

async function runTurn() {
  process.stdout.write("\n" + c.cyan("mentor ▸ "));
  const stream = client.messages.stream({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    thinking: { type: "adaptive" }, // a little reasoning; effort keeps it snappy
    output_config: { effort: cfg.effort }, // "low" for realtime; raise for depth
    system: buildSystem(),
    cache_control: { type: "ephemeral" }, // also cache the growing conversation prefix
    messages,
  });

  stream.on("text", (delta) => process.stdout.write(delta));
  const final = await stream.finalMessage();

  const text = final.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  messages.push({ role: "assistant", content: text });

  process.stdout.write("\n");
  reprompt();
}

// -----------------------------------------------------------------------------
// Session diff: the full unified diff of everything changed since launch,
// measured against the session-start snapshot (not save-over-save, not git).
// -----------------------------------------------------------------------------
function buildSessionDiff() {
  const patches = [];
  for (const [full, cur] of fileSnapshots) {
    const base = baseline.get(full) ?? ""; // files created this session diff against ""
    if (cur === base) continue;
    patches.push(createPatch(path.relative(WATCH_ROOT, full), base, cur, "session start", "now"));
  }
  let text = patches.join("\n");
  let truncated = false;
  if (text.length > cfg.maxDiffBytes) {
    text = text.slice(0, cfg.maxDiffBytes) + "\n… (diff truncated — it has grown large this session)";
    truncated = true;
  }
  return { text: text || "(no changes since session start)", truncated, fileCount: patches.length };
}

function matches(file) {
  return cfg.filePatterns.some((ext) => file.endsWith(ext));
}

// Skip anything under an ignored directory (node_modules, .git, …).
function isIgnoredPath(rel) {
  return rel.split(path.sep).some((seg) => cfg.scanIgnore.includes(seg));
}

function snapshotAll() {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (cfg.scanIgnore.includes(entry.name)) continue; // skip node_modules, .git, …
        walk(full);
      } else if (matches(entry.name)) {
        try {
          fileSnapshots.set(full, fs.readFileSync(full, "utf8"));
        } catch {}
      }
    }
  };
  if (fs.existsSync(WATCH_ROOT)) walk(WATCH_ROOT);
}

// -----------------------------------------------------------------------------
// One-time codebase scan -> memory file. Gives the mentor real context so its
// advice isn't guessing from a bare diff.
// -----------------------------------------------------------------------------
function scanProject(root) {
  const parts = [];
  let bytes = 0,
    count = 0,
    truncated = false;
  const walk = (dir) => {
    if (truncated) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (truncated) return;
      if (entry.isDirectory()) {
        if (cfg.scanIgnore.includes(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (
        cfg.scanExtensions.some((e) => entry.name.endsWith(e)) &&
        !cfg.scanIgnoreFiles.includes(entry.name)
      ) {
        const full = path.join(dir, entry.name);
        let content;
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (bytes + content.length > cfg.scanMaxBytes) {
          truncated = true;
          return;
        }
        parts.push(`\n===== ${path.relative(root, full)} =====\n${content}`);
        bytes += content.length;
        count++;
      }
    }
  };
  walk(root);
  return { text: parts.join("\n"), count, bytes, truncated };
}

async function summarize(root, source) {
  const resp = await client.messages.create({
    model: cfg.model,
    max_tokens: 3000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" }, // one-time; worth the extra care
    system: `You are analyzing a codebase to brief a Socratic coding mentor who will afterward see ONLY diffs of the learner's changes. Produce a concise, information-dense project overview in Markdown: the tech stack and build setup, the architecture and how the main files relate, key entry points, notable conventions, and — most importantly — what the learner appears to be building and where. Capture what a mentor would need to give context-aware guidance. Do NOT dump code; summarize. Keep it under ~500 words.`,
    messages: [
      { role: "user", content: `Project root: ${root}\n\nSource files follow:\n${source}` },
    ],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function ensureContext(force = false) {
  if (!force && fs.existsSync(MEMORY_PATH)) {
    projectContext = fs.readFileSync(MEMORY_PATH, "utf8");
    console.log(c.dim(`loaded cached project context (${cfg.memoryFile})`));
    return;
  }
  console.log(c.dim("scanning the project for context (one-time)…"));
  const { text, count, bytes, truncated } = scanProject(PROJECT_ROOT);
  console.log(
    c.dim(`  read ${count} files, ${Math.round(bytes / 1024)} KB${truncated ? " (truncated at cap)" : ""} — summarizing…`)
  );
  const summary = await summarize(PROJECT_ROOT, text);
  projectContext = `# Project context\n_Generated ${new Date().toISOString()} from ${cfg.projectRoot}_\n\n${summary}`;
  fs.writeFileSync(MEMORY_PATH, projectContext);
  console.log(c.green(`saved project context → ${cfg.memoryFile}`));
}

// -----------------------------------------------------------------------------
// Project goal — the learner describes it once, in their own words.
// -----------------------------------------------------------------------------
function loadGoal() {
  if (fs.existsSync(GOAL_PATH)) {
    projectGoal = fs.readFileSync(GOAL_PATH, "utf8").trim();
    return projectGoal.length > 0;
  }
  return false;
}

function saveGoal(text) {
  projectGoal = text.trim();
  fs.writeFileSync(GOAL_PATH, projectGoal + "\n");
}

function greet() {
  enqueue(
    "I'm starting a session. Using my stated goal and the codebase overview you were given, introduce yourself in one or two sentences, show me you understand what I'm building, remind me you won't write my code, and ask what I'm about to work on. Then wait."
  );
}

// -----------------------------------------------------------------------------
// Watcher (debounced per file)
// -----------------------------------------------------------------------------
const timers = new Map();
function watch() {
  fs.watch(WATCH_ROOT, { recursive: true }, (_event, filename) => {
    if (!filename || !matches(filename) || isIgnoredPath(filename)) return;
    const full = path.join(WATCH_ROOT, filename);
    clearTimeout(timers.get(full));
    timers.set(
      full,
      setTimeout(() => {
        timers.delete(full);
        let cur;
        try {
          cur = fs.readFileSync(full, "utf8");
        } catch {
          return; // file deleted or mid-write
        }
        const prev = fileSnapshots.get(full) ?? "";
        if (cur === prev) return;
        fileSnapshots.set(full, cur);
        const rel = path.relative(WATCH_ROOT, full);
        const { text, truncated, fileCount } = buildSessionDiff();
        const header = `The learner just saved ${rel}. Below is the full unified diff of everything they've changed since this session started (${fileCount} file(s)${truncated ? ", truncated" : ""}); react especially to the latest edit.`;
        enqueue(
          sendWholeFile
            ? `${header}\n\n${text}\n\nFull current contents of ${rel}:\n\n${cur}`
            : `${header}\n\n${text}`
        );
      }, cfg.debounceMs)
    );
  });
}

// -----------------------------------------------------------------------------
// Terminal input: let the learner reply to the mentor.
// -----------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function reprompt() {
  process.stdout.write("\n" + c.green("you ▸ "));
}
const COMMANDS = `${c.dim("commands:")}
  ${c.green("/hint")} ${c.dim("[what you're unsure about]")}   next smallest hint, optionally about a specific thing
  ${c.green("/goal")} ${c.dim("[new goal]")}                  show your project goal, or set a new one
  ${c.green("/whole-file")}                       toggle full-file vs diff-only context on save
  ${c.green("/rescan")}                           re-scan the codebase, rebuild project context
  ${c.green("/help")}                             show this list
  ${c.green("/quit")}                             exit`;

rl.on("line", (line) => {
  const text = line.trim();

  // First-run wizard consumes lines (empty input = keep the shown default).
  if (awaitingSetup) {
    setupSteps[setupIndex].apply(text);
    setupIndex += 1;
    if (setupIndex < setupSteps.length) return askSetupStep();
    awaitingSetup = false;
    saveConfig();
    console.log(c.dim("saved config.json"));
    const done = setupResolve;
    setupResolve = null;
    return done();
  }

  if (!text) return reprompt();

  // First-run goal capture: the learner's first line becomes their project goal.
  if (awaitingGoal) {
    saveGoal(text);
    awaitingGoal = false;
    console.log(c.dim(`saved project goal → ${cfg.goalFile}`));
    return greet();
  }

  if (text === "/quit" || text === "/exit") {
    rl.close();
    process.exit(0);
  }
  if (text === "/help") {
    console.log("\n" + COMMANDS);
    return reprompt();
  }
  if (text === "/whole-file") {
    sendWholeFile = !sendWholeFile;
    console.log(
      "\n" + c.dim(`whole-file context is now ${sendWholeFile ? "ON — the mentor sees full files on save" : "OFF — the mentor sees only the diff"}`)
    );
    return reprompt();
  }
  if (text === "/rescan") {
    console.log();
    ensureContext(true)
      .then(reprompt)
      .catch((err) => {
        console.error(c.yellow("rescan failed: ") + (err?.message || err));
        reprompt();
      });
    return;
  }
  if (text === "/goal" || text.startsWith("/goal ")) {
    const rest = text.slice(5).trim();
    if (rest) {
      saveGoal(rest);
      console.log(c.dim(`updated project goal → ${cfg.goalFile}`));
    } else {
      console.log("\n" + (projectGoal || c.dim("(no goal set yet)")));
    }
    return reprompt();
  }
  if (text === "/hint" || text.startsWith("/hint ")) {
    const detail = text.slice(5).trim();
    return enqueue(
      detail
        ? `I'm stuck, specifically on: ${detail}. Give me the single smallest next hint — a concept to look up, the name of a function, or the direction — not the fix.`
        : "I'm stuck. Give me the single smallest next hint — a concept to look up, the name of a function, or the direction the bug is in — not the fix, and not more than one hint."
    );
  }

  enqueue(text);
});

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// First-run wizard: pick the main config options interactively, persist them.
// -----------------------------------------------------------------------------
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function buildSetupSteps() {
  const models = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"];
  const efforts = ["low", "medium", "high"];
  return [
    {
      prompt:
        `Model?  ${c.dim("(Enter = " + cfg.model + ")")}\n` +
        `  1) claude-sonnet-5   ${c.dim("balanced (default)")}\n` +
        `  2) claude-opus-5     ${c.dim("sharpest")}\n` +
        `  3) claude-haiku-4-5  ${c.dim("cheapest, fastest")}`,
      apply: (a) => {
        if (!a) return;
        const i = parseInt(a, 10);
        cfg.model = i >= 1 && i <= 3 ? models[i - 1] : a;
      },
    },
    {
      prompt:
        `Effort?  ${c.dim("(Enter = " + cfg.effort + ")")}\n` +
        `  1) low ${c.dim("snappy (default)")}   2) medium   3) high ${c.dim("deeper pushback")}`,
      apply: (a) => {
        if (!a) return;
        const i = parseInt(a, 10);
        cfg.effort = i >= 1 && i <= 3 ? efforts[i - 1] : a;
      },
    },
    {
      prompt: `Folder to watch for your edits?  ${c.dim("(Enter = " + cfg.watchPath + ")")}`,
      apply: (a) => {
        if (a) cfg.watchPath = a;
      },
    },
    {
      prompt: `Project root to scan for context?  ${c.dim("(Enter = " + cfg.projectRoot + ")")}`,
      apply: (a) => {
        if (a) cfg.projectRoot = a;
      },
    },
  ];
}

function askSetupStep() {
  console.log("\n" + setupSteps[setupIndex].prompt);
  reprompt();
}

function runFirstRunSetup() {
  return new Promise((resolve) => {
    setupSteps = buildSetupSteps();
    setupIndex = 0;
    awaitingSetup = true;
    setupResolve = resolve;
    console.log("\n" + c.dim("First-run setup — press Enter to keep each [default]. Edit config.json anytime later."));
    askSetupStep();
  });
}

function banner() {
  console.log("\n" + c.dim("── Socratic Mentor ──────────────────────────────────────────"));
  console.log(c.dim(`watching   `) + WATCH_ROOT);
  console.log(c.dim(`context    `) + `session diff (≤${Math.round(cfg.maxDiffBytes / 1000)} KB)   ` + c.dim("model ") + cfg.model + c.dim(" @ effort ") + cfg.effort);
  console.log(c.dim(`type to talk · save a file for feedback · /help for commands`));
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
async function main() {
  const firstRun = !loadGoal(); // a saved goal means we've been set up before

  if (firstRun) await runFirstRunSetup(); // may change model / effort / paths
  resolvePaths();

  if (!fs.existsSync(WATCH_ROOT)) {
    console.error("\n" + c.yellow(`watchPath does not exist: ${WATCH_ROOT}`));
    console.error("Set it in config.json, or re-run and enter a valid folder.");
    process.exit(1);
  }

  banner();
  await ensureContext();
  snapshotAll();
  for (const [k, v] of fileSnapshots) baseline.set(k, v); // session-start snapshot to diff against
  watch();

  if (firstRun) {
    awaitingGoal = true;
    console.log(
      "\n" +
        c.cyan("mentor ▸ ") +
        "Before we start — in a sentence or two, what are you building, and what do you want to get out of it? I'll remember it."
    );
    reprompt();
  } else {
    console.log(c.dim(`loaded project goal (${cfg.goalFile})`));
    greet();
  }
}

main().catch((err) => {
  console.error(c.yellow("startup failed: ") + (err?.message || err));
  process.exit(1);
});
