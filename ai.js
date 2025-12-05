const fs = require("fs");

let AI_CONFIG = {
  provider: process.env.LLM_PROVIDER || "openai", // openai | gemini | ollama
  systemPrompt: process.env.SYSTEM_PROMPT || "",
  temperature: +(process.env.LLM_TEMPERATURE || 0.7),
  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  // Google Gemini
  googleApiKey: process.env.GOOGLE_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  // Ollama (local server)
  ollamaHost: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
};

function setAIConfig(upd) {
  const next = { ...AI_CONFIG, ...upd };
  // Asegurar tipos válidos y evitar objetos en systemPrompt
  next.systemPrompt = String(next.systemPrompt ?? "");
  // Normalizar temperatura
  const t = Number(next.temperature);
  next.temperature = Number.isFinite(t) ? t : (AI_CONFIG.temperature ?? 0.7);
  // Normalizar host de Ollama (sin slash final)
  if (typeof next.ollamaHost === "string") {
    next.ollamaHost = next.ollamaHost.replace(/\/$/, "");
  }
  AI_CONFIG = next;
}

function getAIConfig() {
  const copy = { ...AI_CONFIG };
  copy.systemPrompt = String(copy.systemPrompt || "");
  copy.openaiApiKey = copy.openaiApiKey ? "set" : "";
  copy.googleApiKey = copy.googleApiKey ? "set" : "";
  return copy;
}

function getMemoryText(memoryArray) {
  if (!Array.isArray(memoryArray) || memoryArray.length === 0) return "";
  return (
    "\n\nCONOCIMIENTO RELEVANTE (memoria):\n" +
    memoryArray.map((m, i) => `- ${m.text}`).join("\n") +
    "\n\n"
  );
}

async function generateAIReply({ userText, memoryArray = [], promptOverride }) {
  const base = AI_CONFIG.systemPrompt || "Eres PawaCell, un asistente por WhatsApp.";
  const sys = (promptOverride ? String(promptOverride) : base) + getMemoryText(memoryArray);
  const temp = AI_CONFIG.temperature ?? 0.7;

  if (AI_CONFIG.provider === "openai") {
    if (!AI_CONFIG.openaiApiKey) throw new Error("OPENAI_API_KEY no configurado");
    const OpenAI = require("openai");
    const client = new OpenAI({ apiKey: AI_CONFIG.openaiApiKey });
    const resp = await client.chat.completions.create({
      model: AI_CONFIG.openaiModel,
      temperature: temp,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: String(userText || "") },
      ],
    });
    return resp.choices?.[0]?.message?.content || "";
  }

  if (AI_CONFIG.provider === "gemini") {
    if (!AI_CONFIG.googleApiKey) throw new Error("GOOGLE_API_KEY no configurado");
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(AI_CONFIG.googleApiKey);
    const model = genAI.getGenerativeModel({ model: AI_CONFIG.geminiModel });
    const prompt = sys + "\n\nUsuario: " + String(userText || "");
    const r = await model.generateContent(prompt);
    return r?.response?.text?.() || r?.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }

  if (AI_CONFIG.provider === "ollama") {
    const host = (AI_CONFIG.ollamaHost || "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = AI_CONFIG.ollamaModel || "llama3.1:8b";
    const prompt = sys + "\n\nUsuario: " + String(userText || "");
    const { Ollama } = require("ollama");
    const client = new Ollama({ host });
    const r = await client.generate({ model, prompt, options: { temperature: temp } });
    return r?.response || r?.message?.content || "";
  }

  throw new Error("Proveedor LLM inválido");
}

module.exports = { setAIConfig, getAIConfig, generateAIReply };