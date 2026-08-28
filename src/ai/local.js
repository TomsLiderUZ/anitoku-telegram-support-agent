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

const CATALOG = {
  chat: {
    file: 'gemma-3-12b-it-Q4_K_M.gguf',
    label: 'Gemma 3 12B (Q4_K_M)',
    sizeGb: 6.8,
    contextSize: 8192,
  },
  embed: {
    file: 'bge-m3-Q8_0.gguf',
    label: 'bge-m3 (Q8_0)',
    sizeGb: 0.6,
  },
};

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

const filePath = (kind) => path.join(MODELS_DIR, CATALOG[kind].file);

function fileStatus(kind) {
  const p = filePath(kind);
  const part = p + '.part';
  if (fs.existsSync(p)) return { present: true, bytes: fs.statSync(p).size, downloading: false };
  if (fs.existsSync(part)) return { present: false, bytes: fs.statSync(part).size, downloading: true };
  return { present: false, bytes: 0, downloading: false };
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
  return {
    enabled: settings.bool('local_model_enabled', true),
    gpu: state.gpu,
    loading: state.loading,
    error: state.error,
    chat: { ...CATALOG.chat, ...fileStatus('chat'), loaded: !!state.chatModel },
    embed: { ...CATALOG.embed, ...fileStatus('embed'), loaded: !!state.embedModel },
    vectors: vectors.stats(),
    calls: state.calls,
    avgMs: state.calls ? Math.round(state.totalMs / state.calls) : 0,
    loadedAt: state.loadedAt,
    modelsDir: MODELS_DIR,
  };
}

module.exports = { load, unload, chat, status, available, CATALOG, MODELS_DIR };
