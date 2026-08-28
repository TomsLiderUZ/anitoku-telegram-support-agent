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
  chatModel: false, // true once the worker reports ready
  worker: null,
  crashedAt: null,
  stopping: false,
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
  return settings.bool('local_model_enabled', true) && fileStatus('chat').present && state.chatModel === true && !!state.worker;
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

    // After a crash the worker waits out its cooldown; the minute-ticker in
    // index.js must not shortcut that by calling load() again.
    const coolingDown = state.crashedAt && Date.now() - state.crashedAt < WORKER_RESTART_DELAY_MS;
    if (chat && !state.worker && !coolingDown && !state.gaveUp && fileStatus('chat').present) {
      // Let the embedding model settle in VRAM first: when both load at once
      // the worker sees less free memory, offloads only part of the KV cache
      // and llama.cpp aborts ("cache_k … cannot run the operation").
      if (state.embedModel && !state.crashedAt) await new Promise((r) => setTimeout(r, 15_000));
      await startWorker();
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
  stopWorker('unload');
  for (const k of ['embedContext', 'embedModel']) {
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

// ── chat model: isolated worker process ─────────────────────────────────────
//
// llama.cpp aborted the whole agent once ("pre-allocated tensor … cannot run
// the operation") — a native crash that no try/catch can catch. The chat
// model therefore lives in a child process (see localWorker.js). If it dies,
// in-flight requests fail over to the cloud and the worker is restarted after
// a pause; the account never goes silent because of it.

const WORKER_RESTART_DELAY_MS = 5 * 60_000;
const pending = new Map(); // id -> { resolve, reject, timer }
let nextId = 1;

function startWorker() {
  const { fork } = require('node:child_process');
  // The stored setting once read 50005000500050000000 (a mangled panel save);
  // llama.cpp tried to allocate a KV cache for it and aborted. Clamp hard.
  const wanted = settings.int('local_context_size', CATALOG.chat.contextSize);
  const contextSize = Number.isFinite(wanted) && wanted >= 1024 && wanted <= 32768 ? wanted : CATALOG.chat.contextSize;
  if (contextSize !== wanted) {
    log.warn('local_context_size yaroqsiz — standart qiymat ishlatildi', { stored: String(wanted), used: contextSize });
    settings.set('local_context_size', String(contextSize));
  }
  // node-llama-cpp locates its prebuilt binary relative to the module file and
  // self-tests it in a subprocess that cannot cope with spaces in the path.
  // __dirname here is the real (space-containing) path even when the agent was
  // started through the junction, so the worker must be addressed through the
  // junction too — otherwise it silently loads on CPU and aborts 90 s later.
  const junctionScript = 'C:\\anitoku-agent\\src\\ai\\localWorker.js';
  const script = /\s/.test(__dirname) && fs.existsSync(junctionScript) ? junctionScript : path.join(__dirname, 'localWorker.js');
  const child = fork(script, [JSON.stringify({ modelPath: filePath('chat').replace(/^.*?[\\/]data[\\/]/, fs.existsSync('C:\\anitoku-agent\\data') && /\s/.test(__dirname) ? 'C:\\anitoku-agent\\data\\' : filePath('chat').match(/^.*?[\\/]data[\\/]/)[0]), contextSize, gpuOrder: ['vulkan', 'auto'] })], {
    // The binding's self-test cannot cope with spaces in the path; the
    // junction C:anitoku-agent is the documented space-free entry point.
    cwd: /\s/.test(process.cwd()) && fs.existsSync('C:\\anitoku-agent') ? 'C:\\anitoku-agent' : process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  state.worker = child;
  state.chatModel = false;
  state.crashedAt = null;
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });

  return new Promise((resolve) => {
    const readyTimer = setTimeout(() => {
      log.warn('lokal chat modeli 5 daqiqada yuklanmadi');
      resolve(false);
    }, 5 * 60_000);

    child.on('message', (m) => {
      if (!m) return;
      if (m.type === 'ready') {
        clearTimeout(readyTimer);
        state.chatModel = true;
        state.gpu = m.gpu;
        state.loadedAt = Date.now();
        log.info('chat modeli yuklandi (alohida jarayon)', { model: CATALOG.chat.label, gpu: m.gpu, pid: child.pid });
        resolve(true);
      } else if (m.type === 'fatal') {
        clearTimeout(readyTimer);
        state.error = m.error;
        log.error('lokal chat modeli yuklanmadi', { error: m.error });
        resolve(false);
      } else if (m.type === 'result') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve({ content: m.content, toolCalls: [], finishReason: 'stop', usage: {}, latencyMs: m.latencyMs });
        else p.reject(new Error(m.error || 'lokal model xatosi'));
      }
    });

    child.on('exit', (code, signal) => {
      clearTimeout(readyTimer);
      const wasReady = state.chatModel === true;
      state.worker = null;
      state.chatModel = false;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('lokal model jarayoni yiqildi'));
        pending.delete(id);
      }
      if (state.stopping) {
        state.stopping = false;
        resolve(false);
        return;
      }
      state.crashedAt = Date.now();
      state.crashes = (state.crashes || 0) + 1;
      if (state.crashes >= 3) {
        // Three aborts in one run: stop burning 25 GB of RAM every five
        // minutes. Cloud models carry the load until the next restart.
        state.gaveUp = true;
        log.error('lokal chat modeli 3 marta yiqildi — bu sessiyada oʻchirildi, bulut modellar ishlaydi');
      }
      state.error = `jarayon yiqildi (${code ?? signal}) ${stderr.split('\n').filter(Boolean).slice(-1)[0] || ''}`.trim();
      log.error('lokal chat modeli jarayoni yiqildi — agent ishlashda davom etadi, bulut modellar javob beradi', { code, signal, tail: stderr.slice(-300) });
      const { recordEvent } = require('../core/db');
      recordEvent('local', 'Local model worker crashed', { code, signal, wasReady }, 'error');
      setTimeout(() => {
        if (!state.worker && !state.gaveUp && settings.bool('local_model_enabled', true) && fileStatus('chat').present) startWorker().catch(() => {});
      }, WORKER_RESTART_DELAY_MS);
      resolve(false);
    });
  });
}

function stopWorker(reason) {
  const w = state.worker;
  if (!w) return;
  state.stopping = true;
  try {
    w.kill();
  } catch {
    /* gone */
  }
  state.worker = null;
  state.chatModel = false;
  log.info('lokal chat modeli jarayoni toʻxtatildi', { reason });
}

/**
 * OpenAI-shaped messages → one completion from the worker.
 * Tools are not offered to the local model: it serves the high-volume support
 * path, where retrieval context is already in the prompt. Founder commands,
 * which need reliable tool calling, stay on the cloud providers.
 */
function chat({ messages, maxTokens = 600, temperature = 0.55, timeoutMs = 120_000 }) {
  if (!state.worker || state.chatModel !== true) return Promise.reject(new Error('lokal chat modeli yuklanmagan'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('lokal model javob bermadi (timeout)'));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => {
        state.calls++;
        state.totalMs += r.latencyMs;
        resolve(r);
      },
      reject,
      timer,
    });
    state.worker.send({ type: 'chat', id, messages, maxTokens, temperature });
  });
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
    chat: { ...c.chat, ...fileStatus('chat'), loaded: state.chatModel === true, workerPid: state.worker ? state.worker.pid : null, crashedAt: state.crashedAt || null },
    embed: { ...c.embed, ...fileStatus('embed'), loaded: !!state.embedModel },
    vectors: vectors.stats(),
    calls: state.calls,
    avgMs: state.calls ? Math.round(state.totalMs / state.calls) : 0,
    loadedAt: state.loadedAt,
    modelsDir: MODELS_DIR,
  };
}

module.exports = { load, unload, chat, status, available, download, profileName, CATALOG, PROFILES, MODELS_DIR };
