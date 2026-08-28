'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { settings } = require('../core/db');
const { createLogger } = require('../core/logger');
const vectors = require('../knowledge/vectors');

const log = createLogger('ai:local');

/**
 * Local inference through node-llama-cpp (llama.cpp with CUDA).
 *
 * Two models: a chat model for support replies and an embedding model for
 * semantic retrieval. Both are GGUF files under data/models, loaded lazily on
 * first use so a machine without them (the server) simply reports "not
 * available" and the cloud providers take over.
 *
 * node-llama-cpp is ESM-only; this module is CommonJS, hence dynamic import().
 */

const MODELS_DIR = path.join(config.dataDir, 'models');

/**
 * Two hardware profiles.
 *
 *  gpu       — a desktop with a real GPU: Gemma 3 12B for chat.
 *  cpu-small — a small VPS (2–4 GB RAM, no GPU): Gemma 3 1B (0.8 GB) for chat,
 *              same bge-m3 for embeddings. Total footprint ≈ 2 GB. A 1B model
 *              writes noticeably weaker Uzbek than the cloud providers, so on
 *              this profile it is meant as an offline fallback, not the default
 *              — `local_purposes` decides what it actually serves.
 *
 * Both profiles share the embedding model, so semantic search is identical
 * on the server and on the desktop.
 */
const PROFILES = {
  gpu: {
    chat: { repo: 'bartowski/google_gemma-3-12b-it-GGUF', remote: 'google_gemma-3-12b-it-Q4_K_M.gguf', file: 'gemma-3-12b-it-Q4_K_M.gguf', label: 'Gemma 3 12B (Q4_K_M)', sizeGb: 6.8, contextSize: 8192, minRamGb: 10 },
  },
  'cpu-small': {
    chat: { repo: 'bartowski/google_gemma-3-1b-it-GGUF', remote: 'google_gemma-3-1b-it-Q4_K_M.gguf', file: 'gemma-3-1b-it-Q4_K_M.gguf', label: 'Gemma 3 1B (Q4_K_M)', sizeGb: 0.8, contextSize: 4096, minRamGb: 2 },
  },
};
const EMBED = { repo: 'gpustack/bge-m3-GGUF', remote: 'bge-m3-Q8_0.gguf', file: 'bge-m3-Q8_0.gguf', label: 'bge-m3 (Q8_0)', sizeGb: 0.6 };

/** Pick a profile from the setting, or from what the machine can actually run. */
function profileName() {
  const set = String(settings.get('local_profile', 'auto'));
  if (PROFILES[set]) return set;
  const os = require('node:os');
  const ramGb = os.totalmem() / 1073741824;
  return ramGb >= 12 ? 'gpu' : 'cpu-small';
}

/** Catalog for the active profile — the shape the rest of the module reads. */
function catalog() {
  return { chat: PROFILES[profileName()].chat, embed: EMBED };
}

// Kept as a property for callers that read `local.CATALOG.chat` — it always
// reflects the active profile.
const CATALOG = new Proxy({}, { get: (_, k) => catalog()[k] });

const state = {
  llama: null,
  chatModel: null,
  chatContext: null,
  embedModel: null,
  embedContext: null,
  loading: false,
  error: null,
  gpu: null,
  loadedAt: null,
  calls: 0,
  totalMs: 0,
};

const filePath = (kind) => path.join(MODELS_DIR, catalog()[kind].file);

const downloads = new Map(); // kind -> { bytes, total, startedAt, error }

function fileStatus(kind) {
  const p = filePath(kind);
  const part = p + '.part';
  const dl = downloads.get(kind);
  if (fs.existsSync(p)) return { present: true, bytes: fs.statSync(p).size, downloading: false };
  if (dl && !dl.error) return { present: false, bytes: dl.bytes, total: dl.total, downloading: true };
  if (fs.existsSync(part)) return { present: false, bytes: fs.statSync(part).size, downloading: false, partial: true };
  return { present: false, bytes: 0, downloading: false, error: dl && dl.error };
}

/**
 * Fetch a model file from Hugging Face with a stored `hf_` key, resuming a
 * partial file and reporting progress through `status()`. Runs in the
 * background; the model watcher in index.js loads it when it lands.
 */
async function download(kind) {
  const item = catalog()[kind];
  if (!item) throw new Error(`nomaʼlum model turi: ${kind}`);
  if (fileStatus(kind).present) return { ok: true, already: true };
  if (downloads.get(kind) && !downloads.get(kind).error) return { ok: true, inProgress: true };

  const keyPool = require('./keyPool');
  const cred = keyPool.acquire('huggingface');
  const headers = cred ? { Authorization: `Bearer ${cred.key}` } : {};

  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const dest = filePath(kind);
  const part = dest + '.part';
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have) headers.Range = `bytes=${have}-`;

  const state = { bytes: have, total: 0, startedAt: Date.now(), error: null };
  downloads.set(kind, state);
  log.info('model yuklab olinmoqda', { kind, file: item.file, resumeFrom: have });

  (async () => {
    try {
      const res = await fetch(`https://huggingface.co/${item.repo}/resolve/main/${item.remote}`, { headers, redirect: 'follow' });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      state.total = have + len;
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      for await (const chunk of res.body) {
        out.write(chunk);
        state.bytes += chunk.length;
      }
      await new Promise((r) => out.end(r));
      fs.renameSync(part, dest);
      downloads.delete(kind);
      log.info('model yuklandi', { kind, file: item.file, gb: (state.bytes / 1073741824).toFixed(2) });
    } catch (err) {
      state.error = err.message;
      log.error('model yuklab olinmadi', { kind, error: err.message });
    }
  })();

  return { ok: true, started: true, resumeFrom: have };
}

function available() {
  return settings.bool('local_model_enabled', true) && fileStatus('chat').present && !!state.chatModel;
}

async function lib() {
  return import('node-llama-cpp');
}

/** Load whatever model files are present. Safe to call repeatedly. */
async function load({ chat = true, embed = true } = {}) {
  if (state.loading) return status();
  state.loading = true;
  state.error = null;
  try {
    const { getLlama, LlamaLogLevel } = await lib();
    if (!state.llama) {
      // The prebuilt binding runs a self-test in a child process, and that
      // test cannot cope with spaces in the path. Run the agent from a
      // space-free path (a junction such as C:\anitoku-agent) or the GPU
      // backends will silently fall back to CPU.
      if (/\s/.test(process.cwd())) log.warn('Ish katalogida boʻsh joy bor — GPU binari ishlamasligi mumkin. C:\\anitoku-agent orqali ishga tushiring.', { cwd: process.cwd() });

      // CUDA first, then Vulkan (which the RTX 3060 runs well), never a
      // from-source build: that takes an hour and needs a full toolchain.
      let lastErr = null;
      for (const gpu of ['cuda', 'vulkan', 'auto']) {
        try {
          state.llama = await getLlama({ gpu, build: 'never', logLevel: LlamaLogLevel.error });
          break;
        } catch (err) {
          lastErr = err;
          log.debug(`${gpu} backend mavjud emas`, { error: String(err.message).split('\n')[0].slice(0, 120) });
        }
      }
      if (!state.llama) throw lastErr || new Error('llama.cpp backend topilmadi');
      state.gpu = state.llama.gpu || 'cpu';
      const vram = await state.llama.getVramState().catch(() => null);
      log.info('llama.cpp tayyor', { gpu: state.gpu, vramGb: vram ? Math.round(vram.total / 1e9) : null });
    }

    if (embed && !state.embedModel && fileStatus('embed').present) {
      state.embedModel = await state.llama.loadModel({ modelPath: filePath('embed') });
      state.embedContext = await state.embedModel.createEmbeddingContext();
      vectors.setEmbedder(async (text) => {
        const e = await state.embedContext.getEmbeddingFor(text);
        return Float32Array.from(e.vector);
      }, CATALOG.embed.file);
      log.info('embedding modeli yuklandi', { model: CATALOG.embed.label });
    }

    if (chat && !state.chatModel && fileStatus('chat').present) {
      state.chatModel = await state.llama.loadModel({
        modelPath: filePath('chat'),
        gpuLayers: 'max',
      });
      state.chatContext = await state.chatModel.createContext({
        contextSize: settings.int('local_context_size', CATALOG.chat.contextSize),
        batchSize: 1024,
        flashAttention: true,
      });
      state.loadedAt = Date.now();
      log.info('chat modeli yuklandi', { model: CATALOG.chat.label, gpu: state.gpu });
    }
  } catch (err) {
    state.error = err.message;
    log.error('lokal model yuklanmadi', { error: err.message });
  } finally {
    state.loading = false;
  }
  return status();
}

async function unload() {
  for (const k of ['sequence', 'chatContext', 'chatModel', 'embedContext', 'embedModel']) {
    try {
      if (state[k] && state[k].dispose) await state[k].dispose();
    } catch {
      /* best effort */
    }
    state[k] = null;
  }
  state.loadedAt = null;
  log.info('lokal modellar boʻshatildi');
}

/**
 * OpenAI-shaped messages → one completion.
 * Tools are not offered to the local model: it serves the high-volume support
 * path, where retrieval context is already in the prompt. Founder commands,
 * which need reliable tool calling, stay on the cloud providers.
 */
let queue = Promise.resolve();

async function chat({ messages, maxTokens = 600, temperature = 0.55 }) {
  if (!state.chatModel || !state.chatContext) throw new Error('lokal chat modeli yuklanmagan');

  // One request at a time: a single context sequence cannot be shared.
  const run = async () => {
    const { LlamaChatSession } = await lib();
    const started = Date.now();

    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const last = turns[turns.length - 1];
    const history = turns.slice(0, -1);

    // One sequence for the lifetime of the context, cleared between calls.
    // Taking a fresh sequence per call and disposing it leaked: the context
    // has a single slot, and the fourth request failed with "No sequences left".
    if (!state.sequence) state.sequence = state.chatContext.getSequence();
    const sequence = state.sequence;
    // No clearHistory(): the sequence keeps its evaluated tokens, and the next
    // prompt only re-evaluates from the first token that differs. The support
    // prompt starts with ~3.5k tokens of persona and rules that never change
    // between requests, so that prefix costs nothing after the first call.

    // Gemma's chat template has no system role and the wrapper dropped ours
    // silently — a "start every reply with ZETA" instruction was ignored
    // outright. The instructions are therefore folded into the first user
    // turn, which is how Gemma is meant to receive them.
    const session = new LlamaChatSession({ contextSequence: sequence });
    const withSystem = (userText, isFirst) =>
      isFirst && system ? `${system}\n\n════════\nFOYDALANUVCHI XABARI:\n${userText}` : userText;

    const prompt = last && last.role === 'user' ? String(last.content) : '';
    if (history.length) {
      let firstUserSeen = false;
      session.setChatHistory(
        history.map((m) => {
          if (m.role === 'user') {
            const text = withSystem(String(m.content), !firstUserSeen);
            firstUserSeen = true;
            return { type: 'user', text };
          }
          return { type: 'model', response: [String(m.content)] };
        })
      );
      var finalPrompt = firstUserSeen ? prompt : withSystem(prompt, true);
    } else {
      var finalPrompt = withSystem(prompt, true);
    }
    const text = await session.prompt(finalPrompt, { maxTokens, temperature });
    const ms = Date.now() - started;
    state.calls++;
    state.totalMs += ms;
    return { content: text, toolCalls: [], finishReason: 'stop', usage: {}, latencyMs: ms };
  };

  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

function status() {
  const c = catalog();
  const os = require('node:os');
  return {
    enabled: settings.bool('local_model_enabled', true),
    profile: profileName(),
    profiles: Object.keys(PROFILES),
    ramGb: Math.round(os.totalmem() / 1073741824),
    gpu: state.gpu,
    loading: state.loading,
    error: state.error,
    chat: { ...c.chat, ...fileStatus('chat'), loaded: !!state.chatModel },
    embed: { ...c.embed, ...fileStatus('embed'), loaded: !!state.embedModel },
    vectors: vectors.stats(),
    calls: state.calls,
    avgMs: state.calls ? Math.round(state.totalMs / state.calls) : 0,
    loadedAt: state.loadedAt,
    modelsDir: MODELS_DIR,
  };
}

module.exports = { load, unload, chat, status, available, download, profileName, CATALOG, PROFILES, MODELS_DIR };
