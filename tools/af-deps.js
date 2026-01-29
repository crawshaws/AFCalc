// Lightweight cross-file function dependency audit (no deps).
// Usage: node tools/af-deps.js
//
// Notes:
// - Heuristic only (regex-based); expect some false positives/negatives.
// - Treat functions assigned to window.* or AF.* as "externally used".

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../app");
const FILES = ["app.js", "calculator.app.js", "render.app.js", "ui.app.js"].map((f) =>
  path.join(ROOT, f),
);

const read = (p) => fs.readFileSync(p, "utf8");

const reFuncDecl = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
const reCall = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const reExport = /\b(?:window|AF(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*([A-Za-z_$][\w$]*)\s*=/g;
const reAssignAF = /\bAF\.[A-Za-z_$][\w$]*\s*=\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g;

const SKIP_CALL_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "return",
  "typeof",
  "new",
  "class",
  "console",
  "Math",
  "Date",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Set",
  "Map",
  "Promise",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "fetch",
  "alert",
  "confirm",
  "prompt",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
]);

function extractFunctionDecls(src) {
  const out = new Set();
  for (let m; (m = reFuncDecl.exec(src)); ) out.add(m[1]);
  return out;
}

// Strip comments and string literals so we don’t treat e.g. `foo()` in a comment as a call.
function stripNonCode(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let mode = "code"; // code | line_comment | block_comment | s_quote | d_quote | template
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";
    
    if (mode === "code") {
      if (ch === "/" && next === "/") {
        mode = "line_comment";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "block_comment";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "'") {
        mode = "s_quote";
        out += " ";
        i += 1;
        continue;
      }
      if (ch === "\"") {
        mode = "d_quote";
        out += " ";
        i += 1;
        continue;
      }
      if (ch === "`") {
        mode = "template";
        out += " ";
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    
    if (mode === "line_comment") {
      if (ch === "\n") {
        mode = "code";
        out += "\n";
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    
    if (mode === "block_comment") {
      if (ch === "*" && next === "/") {
        mode = "code";
        out += "  ";
        i += 2;
      } else {
        out += ch === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    
    // String modes
    if (mode === "s_quote") {
      if (ch === "\\" && i + 1 < n) {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "'") {
        mode = "code";
        out += " ";
        i += 1;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (mode === "d_quote") {
      if (ch === "\\" && i + 1 < n) {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "\"") {
        mode = "code";
        out += " ";
        i += 1;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (mode === "template") {
      if (ch === "\\" && i + 1 < n) {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "`") {
        mode = "code";
        out += " ";
        i += 1;
        continue;
      }
      // NOTE: We deliberately ignore `${...}` nested expressions here for simplicity.
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
  }
  return out;
}

function extractExports(src) {
  const out = new Set();
  for (let m; (m = reExport.exec(src)); ) out.add(m[1]);
  for (let m; (m = reAssignAF.exec(src)); ) out.add(m[1]);
  return out;
}

function extractCalls(src) {
  const out = new Set();
  const code = stripNonCode(src);
  for (let m; (m = reCall.exec(code)); ) {
    const name = m[1];
    // Skip method calls like console.log( ) by checking previous non-space char
    const idx = m.index;
    let j = idx - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    if (j >= 0 && code[j] === ".") continue;
    if (SKIP_CALL_NAMES.has(name)) continue;
    out.add(name);
  }
  return out;
}

function buildLineStarts(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function indexToLineCol(lineStarts, idx) {
  // binary search for last start <= idx
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = lineStarts[mid];
    if (v <= idx) lo = mid + 1;
    else hi = mid - 1;
  }
  const line = Math.max(1, hi + 1); // 1-based
  const col = idx - lineStarts[Math.max(0, hi)] + 1; // 1-based
  return { line, col };
}

function extractCallSites(src, maxSitesPerFn = 6) {
  const sites = new Map(); // name -> [{line,col}, ...]
  const code = stripNonCode(src);
  const lineStarts = buildLineStarts(code);
  for (let m; (m = reCall.exec(code)); ) {
    const name = m[1];
    // Skip method calls like console.log( ) by checking previous non-space char
    const idx = m.index;
    let j = idx - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    if (j >= 0 && code[j] === ".") continue;
    if (SKIP_CALL_NAMES.has(name)) continue;
    if (!sites.has(name)) sites.set(name, []);
    const arr = sites.get(name);
    if (arr.length >= maxSitesPerFn) continue;
    arr.push(indexToLineCol(lineStarts, idx));
  }
  return sites;
}

function vscodeFileLink(absPath, line, col) {
  const p = absPath.replaceAll("\\", "/");
  // vscode://file expects absolute path; include line/col for editor jump
  return `vscode://file/${encodeURI(p)}:${line}:${col}`;
}

const perFile = new Map();
const globalDefs = new Map(); // fn -> file

for (const f of FILES) {
  const src = read(f);
  const code = stripNonCode(src);
  const defs = extractFunctionDecls(code);
  const exports = extractExports(code);
  const calls = extractCalls(src);
  const callSites = extractCallSites(src);

  perFile.set(f, { src, defs, exports, calls, callSites });
  for (const d of defs) {
    if (!globalDefs.has(d)) globalDefs.set(d, f);
  }
}

function rel(p) {
  return path.relative(ROOT, p).replaceAll("\\", "/");
}

const report = {
  unresolvedCallsByFile: {},
  unusedDefsByFile: {},
  moveCandidatesByDestination: {},
  satelliteCrossFileCalls: {},
};

for (const [f, data] of perFile.entries()) {
  const unresolved = [];
  for (const c of data.calls) {
    if (data.defs.has(c)) continue;
    // If it's defined somewhere else, it might still be OK (if global), but in split-IIFE it usually isn't.
    unresolved.push({ name: c, definedIn: globalDefs.get(c) ? rel(globalDefs.get(c)) : null });
  }
  unresolved.sort((a, b) => a.name.localeCompare(b.name));
  report.unresolvedCallsByFile[rel(f)] = unresolved;

  const unused = [];
  for (const d of data.defs) {
    // used internally?
    const count = (data.src.match(new RegExp(`\\b${d}\\b`, "g")) || []).length;
    const exported = data.exports.has(d);
    // heuristic: only definition occurrence(s) + export counts as "used externally"
    if (!exported && count <= 1) unused.push(d);
  }
  unused.sort();
  report.unusedDefsByFile[rel(f)] = unused;
}

// Satellite-only report:
// For each satellite file (calculator/render/ui), list bare calls not defined locally,
// and show where they are defined (if found).
const SATELLITES = new Set(["calculator.app.js", "render.app.js", "ui.app.js"]);
for (const [abs, data] of perFile.entries()) {
  const file = rel(abs);
  if (!SATELLITES.has(file)) continue;
  const rows = [];
  for (const c of data.calls) {
    if (data.defs.has(c)) continue;
    const defFile = globalDefs.get(c) ? rel(globalDefs.get(c)) : null;
    if (defFile && defFile !== file) {
      const sites = data.callSites.get(c) || [];
      rows.push({ name: c, definedIn: defFile, sites });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  report.satelliteCrossFileCalls[file] = rows;
}

// Build per-function usage (by file) to compute single-caller cross-file move candidates:
// Candidate = defined in A, called from exactly one file B, and B != A.
const fnUsage = new Map(); // fn -> { definedIn, calledIn:Set<string> }
for (const [f, data] of perFile.entries()) {
  for (const c of data.calls) {
    if (!fnUsage.has(c)) {
      fnUsage.set(c, {
        definedIn: globalDefs.get(c) ? rel(globalDefs.get(c)) : null,
        calledIn: new Set(),
      });
    }
    fnUsage.get(c).calledIn.add(rel(f));
  }
}

for (const [fn, meta] of fnUsage.entries()) {
  if (!meta.definedIn) continue;
  if (meta.calledIn.size !== 1) continue;
  const onlyCaller = Array.from(meta.calledIn)[0];
  if (onlyCaller === meta.definedIn) continue;
  if (!report.moveCandidatesByDestination[onlyCaller]) report.moveCandidatesByDestination[onlyCaller] = [];
  report.moveCandidatesByDestination[onlyCaller].push({ name: fn, from: meta.definedIn });
}

for (const dest of Object.keys(report.moveCandidatesByDestination)) {
  report.moveCandidatesByDestination[dest].sort((a, b) => a.name.localeCompare(b.name));
}

// Print a focused summary
console.log("=== AF deps audit (heuristic) ===");
for (const f of Object.keys(report.unresolvedCallsByFile)) {
  const rows = report.unresolvedCallsByFile[f].filter((r) => r.definedIn); // focus on cross-file refs
  if (rows.length === 0) continue;
  console.log(`\n[${f}] cross-file calls (not defined locally):`);
  for (const r of rows.slice(0, 80)) {
    console.log(`- ${r.name}  (defined in ${r.definedIn})`);
  }
  if (rows.length > 80) console.log(`... +${rows.length - 80} more`);
}

console.log("\n=== Single-caller cross-file move candidates (grouped by destination) ===");
const destFiles = Object.keys(report.moveCandidatesByDestination).sort();
if (destFiles.length === 0) {
  console.log("(none)");
} else {
  for (const dest of destFiles) {
    const rows = report.moveCandidatesByDestination[dest];
    console.log(`\n[${dest}] candidates: ${rows.length}`);
    for (const r of rows.slice(0, 80)) {
      console.log(`- ${r.name}  (from ${r.from})`);
    }
    if (rows.length > 80) console.log(`... +${rows.length - 80} more`);
  }
}

console.log("\n=== Satellite cross-file calls (called in satellite, defined elsewhere) ===");
const satFiles = Object.keys(report.satelliteCrossFileCalls).sort();
for (const f of satFiles) {
  const rows = report.satelliteCrossFileCalls[f];
  if (!rows || rows.length === 0) continue;
  console.log(`\n[${f}] missing locals: ${rows.length}`);
  const absCallerPath = path.join(ROOT, f);
  for (const r of rows.slice(0, 120)) {
    const siteText = (r.sites || [])
      .slice(0, 3)
      .map((s) => {
        const loc = `${f}:${s.line}:${s.col}`;
        const href = vscodeFileLink(absCallerPath, s.line, s.col);
        return `[${loc}](${href})`;
      })
      .join(", ");
    const sitesSuffix = siteText ? ` — calls: ${siteText}` : "";
    console.log(`- ${r.name}  (defined in ${r.definedIn})${sitesSuffix}`);
  }
  if (rows.length > 120) console.log(`... +${rows.length - 120} more`);
}

console.log("\n=== Potentially unused function declarations (heuristic) ===");
for (const f of Object.keys(report.unusedDefsByFile)) {
  const rows = report.unusedDefsByFile[f];
  if (rows.length === 0) continue;
  console.log(`\n[${f}] unused defs: ${rows.length}`);
  console.log(rows.slice(0, 80).join(", "));
  if (rows.length > 80) console.log(`... +${rows.length - 80} more`);
}

