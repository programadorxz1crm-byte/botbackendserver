/* PawaCell WhatsApp API (Express + Baileys)
 * Endpoints:
 * - GET /status
 * - GET /session/qr
 * - POST /session/pairing { phone }
 * - POST /messages/text { to, text }
 * - POST /messages/media (multipart/form-data: file) { to, type, caption }
 * - POST /messages/contact { to, name, phone }
 * - POST /messages/location { to, lat, lng, name }
 * Integraciones:
 * - N8N_WEBHOOK_URL (env) recibe eventos entrantes
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const QRCode = require("qrcode");
const { WebSocketServer } = require("ws");
require("dotenv").config();
const fs = require("fs");
const fsp = require("fs/promises");
const { setAIConfig, getAIConfig, generateAIReply } = require("./ai");
const { ensureRulesFile, loadRules, addRule, updateRule, deleteRule, findMatch } = require("./rules");
const crypto = require("crypto");
const XLSX = require("xlsx");

// ==== Opciones de estabilidad para Baileys (configurables vía .env) ====
const WA_MARK_ONLINE = String(process.env.WA_MARK_ONLINE || "false").toLowerCase() === "true";
const WA_DEFAULT_QUERY_TIMEOUT_MS = +(process.env.WA_DEFAULT_QUERY_TIMEOUT_MS || 45000);
const WA_CONNECT_TIMEOUT_MS = +(process.env.WA_CONNECT_TIMEOUT_MS || 45000);
const WA_RETRY_REQUEST_DELAY_MS = +(process.env.WA_RETRY_REQUEST_DELAY_MS || 2000);

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidDecode,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
// Servir archivos subidos desde data/uploads
// Nota: se define uploadsDir más abajo y ensureDataDir lo crea.
// Para evitar orden, declaramos un middleware que se configurará cuando uploadsDir exista.
let __uploadsStaticConfigured = false;

const upload = multer({ storage: multer.memoryStorage() });
let uploadDisk = null;

let sock = null;
let lastQR = null;
let lastPairingCode = null;
let isReady = false;
let lastIncomingJid = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let pendingPairingNotify = null;

// Seguridad opcional para endpoints puente
const BRIDGE_KEY = process.env.BRIDGE_KEY || null;
function checkBridge(req) {
  if (!BRIDGE_KEY) return true; // sin clave, libre
  const key = req.headers["x-bridge-key"] || req.query.key || req.body?.key;
  return key === BRIDGE_KEY;
}

const clients = new Set();
const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`PawaCell API listening on port ${server.address().port}`);
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.send(JSON.stringify({ type: "status", ready: isReady }));
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of clients) {
    try { c.send(msg); } catch {}
  }
}

function toJid(num) {
  if (!num) throw new Error("Número destino requerido");
  const s = String(num).trim();
  if (s.includes("@")) return s;
  // Asumimos E.164 (incluye código de país), p. ej. 5215512345678
  return s + "@s.whatsapp.net";
}

// Extrae texto usable desde distintos tipos de mensajes de WhatsApp
function extractTextFromMessage(msg) {
  const m = msg?.message || {};
  const body =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentMessage?.title ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.listResponseMessage?.description ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    "";
  return String(body || "").trim();
}

// Calcula duración típica de "escribiendo" según longitud del texto
function calcTypingDuration(text) {
  const base = 800; // ms
  const perChar = 30; // ms por carácter
  const max = 3000; // ms
  const len = String(text || "").length;
  return Math.min(max, base + len * perChar);
}

// Simula que el bot está escribiendo (presence composing -> paused)
async function simulateTyping(jid, ms = 1200) {
  try {
    if (!sock || !isReady || !jid) return;
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);
    await new Promise((r) => setTimeout(r, ms));
    await sock.sendPresenceUpdate("paused", jid);
  } catch (e) {
    console.warn("typing simulate failed:", e.message);
  }
}

// Simula que el bot está grabando audio (presence recording -> paused)
async function simulateRecording(jid, ms = 1200) {
  try {
    if (!sock || !isReady || !jid) return;
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("recording", jid);
    await new Promise((r) => setTimeout(r, ms));
    await sock.sendPresenceUpdate("paused", jid);
  } catch (e) {
    console.warn("recording simulate failed:", e.message);
  }
}

// ==== IA: Configuración y Memoria ====
const dataDir = path.join(__dirname, "data");
const memoryFile = path.join(dataDir, "memory.json");
const uploadsDir = path.join(dataDir, "uploads");
const contactsFile = path.join(dataDir, "contacts.json");
const campaignsFile = path.join(dataDir, "campaigns.json");
async function ensureDataDir() {
  try { await fsp.mkdir(dataDir, { recursive: true }); } catch {}
  try { await fsp.access(memoryFile); } catch { await fsp.writeFile(memoryFile, "[]", "utf8"); }
  try { await fsp.mkdir(uploadsDir, { recursive: true }); } catch {}
  try { await fsp.access(contactsFile); } catch { await fsp.writeFile(contactsFile, "[]", "utf8"); }
  try { await fsp.access(campaignsFile); } catch { await fsp.writeFile(campaignsFile, "[]", "utf8"); }
  // Configurar estático y disk storage una sola vez
  if (!__uploadsStaticConfigured) {
    app.use("/files", express.static(uploadsDir));
    uploadDisk = multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => {
          const safeName = `${Date.now()}-${String(file.originalname || "file").replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          cb(null, safeName);
        },
      }),
    });
    __uploadsStaticConfigured = true;
  }
}
async function loadMemory() {
  try { const txt = await fsp.readFile(memoryFile, "utf8"); return JSON.parse(txt || "[]"); }
  catch { return []; }
}
async function addMemory(text) {
  const arr = await loadMemory();
  arr.push({ text: String(text), ts: Date.now() });
  await fsp.writeFile(memoryFile, JSON.stringify(arr, null, 2), "utf8");
  return arr;
}

// ========= Contactos y Campañas (persistencia y utilidades) =========
async function loadJson(file, fallback = []) {
  try { const txt = await fsp.readFile(file, "utf8"); return JSON.parse(txt || "[]"); }
  catch { return Array.isArray(fallback) ? fallback : []; }
}
async function saveJson(file, data) {
  await ensureDataDir();
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function loadContacts() { return await loadJson(contactsFile, []); }
async function saveContacts(list) { await saveJson(contactsFile, Array.isArray(list) ? list : []); }
async function addContacts(list) {
  const current = await loadContacts();
  const map = new Map(current.map((c) => [String(c.phone), c]));
  for (const raw of Array.isArray(list) ? list : []) {
    const phone = normalizePhone(raw.phone || raw.numero || raw.telefono || raw.mobile || "");
    if (!phone) continue;
    const name = String(raw.name || raw.nombre || raw.alias || "").trim();
    map.set(phone, { phone, name });
  }
  const merged = Array.from(map.values());
  await saveContacts(merged);
  return merged;
}

async function removeContact(phone) {
  const p = normalizePhone(phone);
  const current = await loadContacts();
  const filtered = current.filter((c) => c.phone !== p);
  await saveContacts(filtered);
  return { ok: true, count: filtered.length };
}

async function loadCampaigns() { return await loadJson(campaignsFile, []); }
async function saveCampaigns(list) { await saveJson(campaignsFile, Array.isArray(list) ? list : []); }
async function addCampaign(c) {
  const items = await loadCampaigns();
  const id = crypto.randomUUID();
  const recipients = Array.isArray(c.recipients) ? c.recipients : [];
  const useContacts = !!c.useContacts;
  let finalRecipients = recipients;
  if (useContacts) {
    const contacts = await loadContacts();
    finalRecipients = contacts.map((x) => x.phone);
  }
  const normalized = finalRecipients
    .map((p) => normalizePhone(p))
    .filter(Boolean);
  if (!normalized.length) {
    throw new Error("Sin destinatarios: agrega contactos o ingresa números manuales y desactiva 'Usar contactos'.");
  }
  const item = {
    id,
    name: String(c.name || `Campaña ${new Date().toLocaleString()}`),
    text: String(c.text || ""),
    type: String(c.type || ""),
    urls: Array.isArray(c.urls) ? c.urls.map(String) : (c.url ? [String(c.url)] : []),
    caption: String(c.caption || ""),
    recipients: normalized,
    scheduleAt: c.scheduleAt ? String(c.scheduleAt) : null,
    createdAt: Date.now(),
    status: c.scheduleAt ? "scheduled" : "queued",
    stats: { total: normalized.length, sent: 0, failed: 0, lastError: null },
  };
  items.push(item);
  await saveCampaigns(items);
  return item;
}

async function removeCampaign(id) {
  const items = await loadCampaigns();
  const filtered = items.filter((x) => x.id !== String(id));
  await saveCampaigns(filtered);
  return { ok: true, count: filtered.length };
}

function msUntil(tsIso) {
  try { const t = new Date(tsIso).getTime(); return t - Date.now(); } catch { return 0; }
}

let campaignScheduler = null;
function startCampaignScheduler() {
  if (campaignScheduler) return;
  campaignScheduler = setInterval(async () => {
    try {
      const items = await loadCampaigns();
      let changed = false;
      for (const item of items) {
        if (item.status === "scheduled" && item.scheduleAt && msUntil(item.scheduleAt) <= 0) {
          item.status = "starting";
          changed = true;
          runCampaign(item).catch((e) => {
            item.status = "failed";
            item.stats.lastError = e?.message || String(e);
            saveCampaigns(items).catch(() => {});
          });
        }
      }
      if (changed) await saveCampaigns(items);
    } catch (e) {
      console.warn("campaign scheduler error:", e.message);
    }
  }, 5000);
}

async function sendBroadcast({ recipients, text, type, urls, caption, delayMs = 800 }) {
  const s = await startSocket();
  const list = (Array.isArray(recipients) ? recipients : []).map((p) => normalizePhone(p)).filter(Boolean);
  for (const phone of list) {
    const jid = toJid(phone);
    try {
      if (text) {
        try { await simulateTyping(jid, calcTypingDuration(text)); } catch {}
        await s.sendMessage(jid, { text: String(text) });
      }
      const arr = Array.isArray(urls) ? urls : [];
      for (const u of arr) {
        const { buf, mime } = await downloadBuffer(String(u));
        const payload = { caption: caption || undefined };
        if (type === "image") payload.image = buf;
        else if (type === "video") payload.video = buf;
        else if (type === "audio") payload.audio = buf;
        else { payload.document = buf; payload.mimetype = mime; }
        await s.sendMessage(jid, payload);
      }
    } catch (e) {
      console.warn("broadcast send failed:", e.message);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, Number(delayMs || 0))));
  }
}

async function runCampaign(item) {
  try {
    item.status = "running";
    const recipients = item.recipients || [];
    const s = await startSocket();
    for (const phone of recipients) {
      const jid = toJid(phone);
      try {
        if (item.text) {
          try { await simulateTyping(jid, calcTypingDuration(item.text)); } catch {}
          await s.sendMessage(jid, { text: String(item.text) });
        }
        const arr = Array.isArray(item.urls) ? item.urls : [];
        for (const u of arr) {
          const { buf, mime } = await downloadBuffer(String(u));
          const payload = { caption: item.caption || undefined };
          if (item.type === "image") payload.image = buf;
          else if (item.type === "video") payload.video = buf;
          else if (item.type === "audio") payload.audio = buf;
          else { payload.document = buf; payload.mimetype = mime; }
          await s.sendMessage(jid, payload);
        }
        item.stats.sent += 1;
      } catch (e) {
        item.stats.failed += 1;
        item.stats.lastError = e?.message || String(e);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    item.status = "completed";
    item.completedAt = Date.now();
    const items = await loadCampaigns();
    const idx = items.findIndex((x) => x.id === item.id);
    if (idx >= 0) items[idx] = item; else items.push(item);
    await saveCampaigns(items);
  } catch (e) {
    item.status = "failed";
    item.stats.lastError = e?.message || String(e);
    const items = await loadCampaigns();
    const idx = items.findIndex((x) => x.id === item.id);
    if (idx >= 0) items[idx] = item; else items.push(item);
    await saveCampaigns(items);
  }
}

async function initAI() {
  await ensureDataDir();
  let systemPrompt = process.env.SYSTEM_PROMPT || "";
  const promptFile = process.env.SYSTEM_PROMPT_FILE ? path.join(__dirname, String(process.env.SYSTEM_PROMPT_FILE)) : null;
  if (!systemPrompt && promptFile) {
    try { systemPrompt = await fsp.readFile(promptFile, "utf8"); } catch {}
  }
  setAIConfig({
    provider: process.env.LLM_PROVIDER || "openai",
    systemPrompt,
    temperature: +(process.env.LLM_TEMPERATURE || 0.7),
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
    googleApiKey: process.env.GOOGLE_API_KEY || "",
    geminiModel: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  });
}
initAI();

async function startSocket() {
  if (sock) return sock;
  const authDir = path.join(__dirname, "auth");
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["PawaCell", "Chrome", "1.0"],
    syncFullHistory: false,
    markOnlineOnConnect: WA_MARK_ONLINE,
    defaultQueryTimeoutMs: WA_DEFAULT_QUERY_TIMEOUT_MS,
    connectTimeoutMs: WA_CONNECT_TIMEOUT_MS,
    retryRequestDelay: WA_RETRY_REQUEST_DELAY_MS,
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    const { qr, connection, pairingCode } = u;
    if (qr) {
      lastQR = qr;
      broadcast({ type: "qr", data: qr });
    }
    if (pairingCode) {
      lastPairingCode = pairingCode;
      broadcast({ type: "pairing_code", data: pairingCode });
      // Notificación al administrador por WhatsApp
      const adminPhone = process.env.ADMIN_NOTIFY_PHONE;
      if (adminPhone) {
        const adminJid = toJid(adminPhone);
        const text = `Código de emparejamiento generado: ${pairingCode}`;
        try {
          if (isReady) {
            await sock.sendMessage(adminJid, { text });
          } else {
            // Guardar para enviar tras conexión
            pendingPairingNotify = { adminJid, text };
          }
        } catch (e) {
          console.warn("admin notify failed:", e.message);
        }
      }
    }
    if (connection === "connecting") {
      isReady = false;
      broadcast({ type: "status", ready: false, phase: "connecting" });
      console.log("WhatsApp conectando...");
    }
    if (connection === "open") {
      isReady = true;
      broadcast({ type: "status", ready: true });
      lastQR = null; lastPairingCode = null;
      console.log("WhatsApp conectado");
      // reset backoff
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectAttempts = 0;
      // Si hay notificación pendiente de pairing, enviarla ahora
      if (pendingPairingNotify) {
        try {
          await sock.sendMessage(pendingPairingNotify.adminJid, { text: pendingPairingNotify.text });
        } catch (e) {
          console.warn("pending admin notify failed:", e.message);
        }
        pendingPairingNotify = null;
      }
    }
    if (connection === "close") {
      isReady = false;
      broadcast({ type: "status", ready: false, phase: "closed" });
      const statusCode = u?.lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("Conexión cerrada", statusCode, shouldReconnect ? "reintentando" : "sesión cerrada");
      if (shouldReconnect) scheduleReconnect();
      else {
        // sesión inválida: requiere reinicio manual (logout)
        sock = null;
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key?.fromMe) return;
    const from = msg.key.remoteJid;
    const body = extractTextFromMessage(msg);
    const payload = {
      from,
      body,
      ts: Date.now(),
    };
    broadcast({ type: "incoming", payload });
    // Guardar el último remitente para bridge sin 'to'
    lastIncomingJid = from;
    const webhook = process.env.N8N_WEBHOOK_URL;
    try {
      if (webhook) {
        await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
    } catch (e) {
      console.warn("n8n webhook failed:", e.message);
    }

    // Reglas por palabras clave
    try {
      await ensureRulesFile();
      const rule = await findMatch(body);
      if (rule) {
        // Enviar respuesta por regla y saltar IA
        const resp = rule.response || {};
        const isAI = String(resp.type || "").toLowerCase() === "ai";
        if (isAI) {
          try {
            const mem = await loadMemory();
            // Usar SIEMPRE el prompt global configurado en la app (IA_CONFIG.systemPrompt)
            // No sobrescribir con texto de la regla para mantener consistencia.
            const reply = await generateAIReply({ userText: body, memoryArray: mem });
            if (reply) {
              try { await simulateTyping(from, calcTypingDuration(reply)); } catch {}
              await sock.sendMessage(from, { text: reply });
            }
          } catch (e) {
            console.warn("AI rule reply failed:", e.message);
            // Fallback para no dejar la conversación en silencio si la IA falla
            try {
              await sock.sendMessage(from, { text: "IA no disponible: " + String(e.message || "error") });
            } catch {}
          }
          return; // terminado por regla IA
        }
        if (resp.text) {
          try { await simulateTyping(from, calcTypingDuration(resp.text)); } catch {}
          await sock.sendMessage(from, { text: String(resp.text) });
        }
        const atts = Array.isArray(resp.attachments) ? resp.attachments : [];
        for (const a of atts) {
          const type = String(a.type || "document");
          const url = String(a.url || "");
          if (!url) continue;
          try {
            const r = await downloadBuffer(url);
            const payload = { caption: a.caption || undefined };
            if (type === "image") payload.image = r.buf;
            else if (type === "video") payload.video = r.buf;
            else if (type === "audio") payload.audio = r.buf;
            else { payload.document = r.buf; payload.mimetype = r.mime; }
            try { await simulateTyping(from, 1000); } catch {}
            await sock.sendMessage(from, payload);
          } catch (e) { console.warn("attach send failed:", e.message); }
        }
        return; // no IA si hubo regla
      }
    } catch (e) {
      console.warn("rules check failed:", e.message);
    }

    // Autorrespuesta IA opcional
    try {
      const auto = String(process.env.AUTOREPLY_ENABLED || "false").toLowerCase() === "true";
      if (auto && isReady && body) {
        const mem = await loadMemory();
        const reply = await generateAIReply({ userText: body, memoryArray: mem });
        if (reply) {
          try { await simulateTyping(from, calcTypingDuration(reply)); } catch {}
          await sock.sendMessage(from, { text: reply });
        }
      }
    } catch (e) {
      console.warn("AI autoreply failed:", e.message);
    }
  });

  return sock;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const base = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts)); // 1s,2s,4s... máx 30s
  // Pequeño jitter para evitar reconexiones simultáneas exactas
  const delay = Math.max(1000, Math.round(base * (0.9 + Math.random() * 0.2)));
  reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      sock = null;
      await startSocket();
    } catch (e) {
      console.warn("Reconnect failed:", e.message);
      scheduleReconnect();
    }
  }, delay);
}

async function isRegistered() {
  try {
    const authDir = path.join(__dirname, "auth");
    const credsPath = path.join(authDir, "creds.json");
    const txt = await fsp.readFile(credsPath, "utf8");
    const c = JSON.parse(txt);
    return !!c?.registered;
  } catch {
    return false;
  }
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

async function logoutSession() {
  try {
    const authDir = path.join(__dirname, "auth");
    await fsp.rm(authDir, { recursive: true, force: true });
  } catch {}
  lastQR = null;
  lastPairingCode = null;
  isReady = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  sock = null;
}

// Health
app.get("/status", async (req, res) => {
  try {
    const registered = await isRegistered();
    res.json({ ok: true, ready: isReady, qrAvailable: !!lastQR, pairingAvailable: !!lastPairingCode, registered });
  } catch (e) {
    res.json({ ok: true, ready: isReady, qrAvailable: !!lastQR, pairingAvailable: !!lastPairingCode, registered: false });
  }
});

// QR actual (data-uri PNG)
app.get("/session/qr", async (req, res) => {
  await startSocket();
  if (!lastQR) return res.status(404).json({ error: "No hay QR disponible" });
  try {
    const dataUrl = await QRCode.toDataURL(lastQR);
    res.json({ dataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Solicitar código de emparejamiento (multi-device)
app.post("/session/pairing", async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone requerido (E.164)" });
  try {
    const num = normalizePhone(phone);
    if (!num) return res.status(400).json({ error: "phone inválido, usa E.164 (sin + ni espacios)" });
    const registered = await isRegistered();
    if (registered) return res.status(409).json({ error: "Sesión ya vinculada. Usa /session/logout para reiniciar." });
    const s = await startSocket();
    const code = await s.requestPairingCode(num);
    lastPairingCode = code;
    broadcast({ type: "pairing_code", data: code });
    res.json({ pairingCode: code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Obtener último código de emparejamiento
app.get("/session/pairing/code", async (req, res) => {
  await startSocket();
  if (!lastPairingCode) return res.status(404).json({ error: "No hay código disponible" });
  res.json({ pairingCode: lastPairingCode });
});

// Cerrar sesión y limpiar credenciales
app.post("/session/logout", async (req, res) => {
  try {
    await logoutSession();
    // iniciar nueva sesión para mostrar QR/código fresco
    await startSocket();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Enviar texto
app.post("/messages/text", async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "to y text requeridos" });
    const s = await startSocket();
    const jid = toJid(to);
    await s.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Enviar media (imagen, video, audio, documento/pdf)
app.post("/messages/media", upload.single("file"), async (req, res) => {
  try {
    const { to, type, caption } = req.body || {};
    const file = req.file;
    if (!to || !type || !file) return res.status(400).json({ error: "to, type y file requeridos" });
    const s = await startSocket();
    const jid = toJid(to);
    const payload = { caption };
    const mime = file.mimetype || "application/octet-stream";
    const buf = file.buffer;

    if (type === "image") payload.image = buf;
    else if (type === "video") payload.video = buf;
    else if (type === "audio") payload.audio = buf;
    else {
      payload.document = buf;
      payload.mimetype = mime;
      payload.fileName = file.originalname || "file";
    }

    await s.sendMessage(jid, payload);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Subir archivo al backend y guardarlo en /data/uploads
// FormData: file
app.post("/files/upload", async (req, res, next) => {
  try {
    await ensureDataDir();
    return uploadDisk.single("file")(req, res, async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      const f = req.file;
      if (!f) return res.status(400).json({ error: "file requerido" });
      const url = `${req.protocol}://${req.get("host")}/files/${encodeURIComponent(f.filename)}`;
      res.json({ ok: true, file: { filename: f.filename, originalName: f.originalname || "file", size: f.size || 0, mime: f.mimetype || "application/octet-stream", url } });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Simular presencia: escribiendo o grabando por N milisegundos
// Body: { to, state: 'typing'|'recording'|'online'|'offline'|'paused', durationMs }
app.post("/presence/simulate", async (req, res) => {
  try {
    const { to, state, durationMs } = req.body || {};
    if (!to || !state) return res.status(400).json({ error: "to y state requeridos" });
    const ms = Math.max(0, Number(durationMs ?? 1200));
    const s = await startSocket();
    const jid = toJid(to);
    if (state === "typing") {
      await simulateTyping(jid, ms);
    } else if (state === "recording") {
      await simulateRecording(jid, ms);
    } else if (state === "online") {
      await s.sendPresenceUpdate("available", jid);
    } else if (state === "offline") {
      await s.sendPresenceUpdate("unavailable", jid);
    } else if (state === "paused") {
      await s.sendPresenceUpdate("paused", jid);
    } else {
      return res.status(400).json({ error: "state inválido" });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Enviar contacto (vCard simple)
app.post("/messages/contact", async (req, res) => {
  try {
    const { to, name, phone } = req.body || {};
    if (!to || !name || !phone) return res.status(400).json({ error: "to, name, phone requeridos" });
    const s = await startSocket();
    const jid = toJid(to);
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${name}`,
      `TEL;type=CELL;type=VOICE;waid=${phone}:${phone}`,
      "END:VCARD",
    ].join("\n");
    await s.sendMessage(jid, { contacts: { displayName: name, contacts: [{ vcard }] } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Enviar ubicación
app.post("/messages/location", async (req, res) => {
  try {
    const { to, lat, lng, name } = req.body || {};
    if (!to || lat == null || lng == null) return res.status(400).json({ error: "to, lat, lng requeridos" });
    const s = await startSocket();
    const jid = toJid(to);
    await s.sendMessage(jid, { location: { degreesLatitude: +lat, degreesLongitude: +lng, name } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ruta de prueba para Tasker/AutoResponderWA (HTTP simple)
app.post("/trigger", async (req, res) => {
  // Puedes usar esta ruta para que Tasker dispare eventos o n8n te llame
  res.json({ ok: true, received: req.body || {} });
});

// =====================
// Endpoints puente (Tasker / AutoResponderWA)
// =====================

// Helper: descarga media desde URL
async function downloadBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Descarga falló: ${r.status}`);
  const ct = r.headers.get("content-type") || "application/octet-stream";
  const ab = await r.arrayBuffer();
  return { buf: Buffer.from(ab), mime: ct };
}

// Texto: acepta GET y POST
app.all("/bridge/:client/send-text", async (req, res) => {
  try {
    if (!checkBridge(req)) return res.status(401).json({ error: "Clave inválida" });
    const to = req.method === "GET" ? req.query.to : req.body?.to;
    const text = req.method === "GET" ? req.query.text : req.body?.text;
    if (!text) return res.status(400).json({ error: "text requerido" });
    const s = await startSocket();
    const jid = to ? toJid(to) : lastIncomingJid;
    if (!jid) return res.status(400).json({ error: "Sin destinatario: falta 'to' y no hay último remitente" });
    await s.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Media vía URL: acepta GET y POST
// Params: to, type (image|video|audio|document), url, caption
app.all("/bridge/:client/send-media", async (req, res) => {
  try {
    if (!checkBridge(req)) return res.status(401).json({ error: "Clave inválida" });
    const q = req.method === "GET" ? req.query : req.body || {};
    const { to, type, url, caption } = q;
    let urls = q.urls || null;
    if (typeof urls === "string") {
      try { urls = JSON.parse(urls); } catch { urls = urls.split(",").map((s) => s.trim()).filter(Boolean); }
    }
    const list = Array.isArray(urls) && urls.length ? urls : (url ? [url] : []);
    if (!type || !list.length) return res.status(400).json({ error: "type y url(s) requeridos" });
    const s = await startSocket();
    const jid = to ? toJid(to) : lastIncomingJid;
    if (!jid) return res.status(400).json({ error: "Sin destinatario: falta 'to' y no hay último remitente" });
    for (const u of list) {
      const { buf, mime } = await downloadBuffer(String(u));
      const payload = { caption };
      if (type === "image") payload.image = buf;
      else if (type === "video") payload.video = buf;
      else if (type === "audio") payload.audio = buf;
      else { payload.document = buf; payload.mimetype = mime; }
      await s.sendMessage(jid, payload);
    }
    res.json({ ok: true, count: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ping de verificación
app.get("/bridge/:client/ping", (req, res) => {
  if (!checkBridge(req)) return res.status(401).json({ error: "Clave inválida" });
  res.json({ ok: true, client: req.params.client, ready: isReady });
});

// =====================
// Endpoints de contactos
// =====================
app.get("/contacts", async (req, res) => {
  try {
    const list = await loadContacts();
    res.json({ ok: true, items: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/contacts/add", async (req, res) => {
  try {
    const body = req.body || {};
    let items = [];
    if (Array.isArray(body.items)) items = body.items;
    else if (body.phone) items = [body];
    const merged = await addContacts(items);
    res.json({ ok: true, count: merged.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Subida directa de Excel/CSV
app.post("/contacts/upload", async (req, res) => {
  try {
    await ensureDataDir();
    return uploadDisk.single("file")(req, res, async (err) => {
      if (err) return res.status(500).json({ error: err.message });
      const f = req.file;
      if (!f) return res.status(400).json({ error: "file requerido" });
      const filePath = path.join(uploadsDir, f.filename);
      try {
        const workbook = XLSX.readFile(filePath);
        const sheetNames = workbook.SheetNames || [];
        const sheet = workbook.Sheets[sheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet || {}, { defval: "" });
        const merged = await addContacts(rows);
        res.json({ ok: true, imported: rows.length, count: merged.length });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/contacts/:phone", async (req, res) => {
  try { const r = await removeContact(req.params.phone); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/contacts/clear", async (req, res) => {
  try { await saveContacts([]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================
// Endpoints de campañas y difusiones
// =====================
app.get("/campaigns", async (req, res) => {
  try { const items = await loadCampaigns(); res.json({ ok: true, items }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/campaigns/create", async (req, res) => {
  try {
    const item = await addCampaign(req.body || {});
    res.json({ ok: true, campaign: item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/campaigns/start/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    const items = await loadCampaigns();
    const item = items.find((x) => x.id === id);
    if (!item) return res.status(404).json({ error: "Campaña no encontrada" });
    item.status = "starting";
    item.scheduleAt = null;
    await saveCampaigns(items);
    runCampaign(item).catch((e) => console.warn("runCampaign error:", e.message));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/campaigns/:id", async (req, res) => {
  try { const r = await removeCampaign(req.params.id); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/campaigns/clear", async (req, res) => {
  try { await saveCampaigns([]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Difusión inmediata sin crear campaña
app.post("/broadcast/send", async (req, res) => {
  try {
    const { recipients, text, type, urls, caption, delayMs } = req.body || {};
    if (!Array.isArray(recipients) || (!text && !type)) {
      return res.status(400).json({ error: "recipients requerido y text o type" });
    }
    await sendBroadcast({ recipients, text, type, urls, caption, delayMs });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Programar una difusión como campaña (usa scheduleAt con zona horaria ISO)
app.post("/broadcast/schedule", async (req, res) => {
  try {
    const { recipients, text, type, urls, caption, scheduleAt } = req.body || {};
    if (!Array.isArray(recipients) || (!text && !type) || !scheduleAt) {
      return res.status(400).json({ error: "recipients, scheduleAt y text o type requeridos" });
    }
    const item = await addCampaign({
      name: `Difusión programada ${new Date().toLocaleString()}`,
      recipients,
      useContacts: false,
      text,
      type,
      urls,
      caption,
      scheduleAt,
    });
    res.json({ ok: true, campaign: item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================
// Endpoints de reglas (palabras clave)
// =====================
app.get("/rules", async (req, res) => {
  try { const rules = await loadRules(); res.json({ ok: true, items: rules }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/rules/add", async (req, res) => {
  try {
    const r = await addRule(req.body || {});
    res.json({ ok: true, rule: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/rules/update", async (req, res) => {
  try {
    const r = await updateRule(req.body || {});
    res.json({ ok: true, rule: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/rules/:id", async (req, res) => {
  try { const r = await deleteRule(req.params.id); res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/rules/test", async (req, res) => {
  try {
    const { text } = req.body || {};
    const r = await findMatch(text || "");
    res.json({ ok: true, match: r || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================
// Endpoints IA
// =====================
app.get("/ai/config", (req, res) => {
  res.json({ ok: true, config: getAIConfig() });
});

app.post("/ai/config", async (req, res) => {
  try {
    const {
      provider,
      systemPrompt,
      temperature,
      // OpenAI
      openaiApiKey,
      openaiModel,
      // Gemini
      googleApiKey,
      geminiModel,
      // Ollama
      ollamaHost,
      ollamaModel,
    } = req.body || {};
    setAIConfig({
      provider,
      systemPrompt,
      temperature,
      openaiApiKey,
      openaiModel,
      googleApiKey,
      geminiModel,
      ollamaHost,
      ollamaModel,
    });
    res.json({ ok: true, config: getAIConfig() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Añadir memoria
app.post("/ai/memory/add", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: "text requerido" });
    const arr = await addMemory(text);
    res.json({ ok: true, count: arr.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ver memoria
app.get("/ai/memory", async (req, res) => {
  try {
    const arr = await loadMemory();
    res.json({ ok: true, items: arr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generar y enviar respuesta IA
app.post("/ai/reply", async (req, res) => {
  try {
    const { to, text, prompt } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: "to y text requeridos" });
    const mem = await loadMemory();
    const reply = await generateAIReply({ userText: text, memoryArray: mem, promptOverride: prompt });
    const s = await startSocket();
    const jid = toJid(to);
    await s.sendMessage(jid, { text: reply || "" });
    res.json({ ok: true, sent: !!reply, reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Iniciar programador de campañas
startCampaignScheduler();

// Notas: Esta API usa WhatsApp Web (Baileys) y puede violar términos de WhatsApp.
// Para producción, considera WhatsApp Business API oficial.