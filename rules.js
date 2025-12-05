const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const dataDir = path.join(__dirname, "data");
const rulesFile = path.join(dataDir, "rules.json");

async function ensureRulesFile() {
  try { await fsp.mkdir(dataDir, { recursive: true }); } catch {}
  try { await fsp.access(rulesFile); } catch { await fsp.writeFile(rulesFile, "[]", "utf8"); }
}

async function loadRules() {
  await ensureRulesFile();
  try { const txt = await fsp.readFile(rulesFile, "utf8"); return JSON.parse(txt || "[]"); }
  catch { return []; }
}

async function saveRules(rules) {
  await ensureRulesFile();
  await fsp.writeFile(rulesFile, JSON.stringify(rules || [], null, 2), "utf8");
}

async function addRule(rule) {
  const rules = await loadRules();
  const id = crypto.randomUUID();
  const r = { id, enabled: true, priority: 0, mode: "contains", response: { text: "" }, keywords: [], name: "Regla", ...rule };
  rules.push(r);
  await saveRules(rules);
  return r;
}

async function updateRule(rule) {
  const rules = await loadRules();
  const idx = rules.findIndex((x) => x.id === rule.id);
  if (idx === -1) throw new Error("Regla no encontrada");
  rules[idx] = { ...rules[idx], ...rule };
  await saveRules(rules);
  return rules[idx];
}

async function deleteRule(id) {
  const rules = await loadRules();
  const next = rules.filter((x) => x.id !== id);
  await saveRules(next);
  return { ok: true };
}

function matches(rule, text) {
  if (!rule.enabled) return false;
  const t = String(text || "").toLowerCase();
  const kws = (rule.keywords || []).map((k) => String(k).toLowerCase());
  const mode = rule.mode || "contains";
  // Modo 'any': coincide con cualquier texto (útil para reglas IA catch-all)
  if (mode === "any") return t.length > 0;
  if (mode === "equals") return kws.some((k) => t === k);
  if (mode === "regex") {
    try { return kws.some((k) => new RegExp(k, "i").test(t)); } catch { return false; }
  }
  // contains
  return kws.some((k) => t.includes(k));
}

async function findMatch(text) {
  const rules = await loadRules();
  const enabled = rules.filter((r) => r.enabled);
  enabled.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  // Priorizar reglas específicas (equals/regex/contains) sobre las de modo 'any'
  const specific = enabled.find((r) => (r.mode || "contains") !== "any" && matches(r, text));
  if (specific) return specific;
  const anyRule = enabled.find((r) => (r.mode || "contains") === "any" && matches(r, text));
  return anyRule || null;
}

module.exports = { ensureRulesFile, loadRules, saveRules, addRule, updateRule, deleteRule, findMatch };