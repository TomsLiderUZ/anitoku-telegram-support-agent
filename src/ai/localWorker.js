'use strict';
/**
 * Local chat inference in its own process.
 *
 * llama.cpp is native code: when the Vulkan backend hits an unsupported
 * operation it aborts the whole process, and on 2026-08-28 that took the
 * Telegram agent down with it. Running the model here means a crash costs one
 * local answer (the cloud providers take over) instead of the account going
 * silent. Talks to the parent over IPC: {id, messages, maxTokens, temperature}
 * in, {id, ok, content, latencyMs} out.
 */
const path = require('node:path');

const cfg = JSON.parse(process.argv[2] || '{}');
const send = (m) => process.send && process.send(m);

let llama = null;
let model = null;
let context = null;
let sequence = null;
let LlamaChatSession = null;
let queue = Promise.resolve();

async function init() {
  const lib = await import('node-llama-cpp');
  LlamaChatSession = lib.LlamaChatSession;
  let lastErr = null;
  // "cpu" must become the boolean `false` that node-llama-cpp expects —
  // passing the string silently selects a GPU backend instead, which is how a
  // CPU-only run kept ending in the Vulkan assertion dialog.
  for (const want of cfg.gpuOrder || ['vulkan', 'auto']) {
    const gpu = want === 'cpu' || want === false || want === 'false' ? false : want;
    try {
      llama = await lib.getLlama({ gpu, build: 'never', logLevel: lib.LlamaLogLevel.error });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!llama) throw lastErr || new Error('llama.cpp backend topilmadi');
  model = await llama.loadModel({ modelPath: cfg.modelPath, gpuLayers: 'max' });

  // How much context fits depends on what else is already on the card — the
  // embedding model, a browser, a game. Rather than refusing to start, step
  // down until it fits; a smaller window still answers.
  const wanted = cfg.contextSize || 8192;
  const ladder = [wanted, 6144, 4096, 3072, 2048, 1024].filter((n, i, a) => n <= wanted && a.indexOf(n) === i);
  let lastError = null;
  for (const size of ladder) {
    try {
      context = await model.createContext({ contextSize: size, batchSize: Math.min(512, size), flashAttention: false });
      sequence = context.getSequence();
      send({ type: 'ready', gpu: llama.gpu || 'cpu', contextSize: size, requested: wanted });
      return;
    } catch (err) {
      lastError = err;
      if (!/VRAM|memory|too large/i.test(err.message)) throw err;
    }
  }
  throw lastError || new Error('kontekst yaratib boʻlmadi');
}

async function chat({ messages, maxTokens = 600, temperature = 0.55 }) {
  const started = Date.now();
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const last = turns[turns.length - 1];
  const history = turns.slice(0, -1);

  // A fresh KV state per request. Reusing evaluated tokens across unrelated
  // chats is what preceded the Vulkan abort; a few hundred ms of prompt
  // evaluation is the price of not crashing.
  await sequence.clearHistory();
  const session = new LlamaChatSession({ contextSequence: sequence });

  // Gemma's template has no system role: fold instructions into the first
  // user turn, which is how the model is meant to receive them.
  const withSystem = (userText, isFirst) => (isFirst && system ? `${system}\n\n════════\nFOYDALANUVCHI XABARI:\n${userText}` : userText);
  const prompt = last && last.role === 'user' ? String(last.content) : '';
  let finalPrompt;
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
    finalPrompt = firstUserSeen ? prompt : withSystem(prompt, true);
  } else {
    finalPrompt = withSystem(prompt, true);
  }
  const text = await session.prompt(finalPrompt, { maxTokens, temperature });
  return { content: text, latencyMs: Date.now() - started };
}

process.on('message', (msg) => {
  if (!msg || msg.type !== 'chat') return;
  const run = () =>
    chat(msg)
      .then((r) => send({ type: 'result', id: msg.id, ok: true, ...r }))
      .catch((err) => send({ type: 'result', id: msg.id, ok: false, error: err.message }));
  queue = queue.then(run, run);
});

process.on('disconnect', () => process.exit(0));

init().catch((err) => {
  send({ type: 'fatal', error: err.message });
  process.exit(1);
});

module.exports = { modelName: path.basename(cfg.modelPath || '') };
