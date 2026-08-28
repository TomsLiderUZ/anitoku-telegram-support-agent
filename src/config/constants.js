'use strict';

/**
 * Immutable project facts. These are injected into every system prompt as
 * ground truth, and also seeded into the knowledge base on first boot.
 */
const BRAND = {
  name: 'ANITOKU',
  tagline: "O'zbek tilidagi anime va manga platformasi",
  channel: 'https://t.me/anitoku',
  adminContact: 'https://t.me/anitoku_admin',
  bot: 'https://t.me/anitoku_bot',
  sites: ['https://www.anitoku.uz/', 'https://anitoku.vercel.app/'],
};

/** Private training channel — agent reads its posts to self-train. */
const TRAINING_CHANNEL_ID = '2144081144';

/**
 * Model chains. First entry wins; the rest are fallbacks tried in order when a
 * model is unavailable, rate-limited or rejects the request.
 * All entries below support tool/function calling.
 */
const MODEL_CHAINS = {
  groq: [
    'openai/gpt-oss-120b',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.6-27b',
  ],
  // Ordered by measured Uzbek quality, not by size. nvidia/nemotron was dropped
  // after it emitted its English reasoning trace instead of an answer.
  openrouter: [
    'minimax/minimax-m3:free',
    'z-ai/glm-5.2:free',
    'google/gemma-4-31b-it:free',
  ],
  gemini: ['gemini-3.7-flash', 'gemini-3.1-flash-lite'],
  cerebras: ['llama-3.3-70b', 'llama3.1-8b', 'qwen-3-32b'],
  // Measured on Uzbek support questions: medium gives the best spelling and
  // phrasing at ~2.8s; small is a fast, still-correct fallback. `large` was
  // dropped — it did not answer within 60s, which is useless for live chat.
  mistral: ['mistral-medium-latest', 'mistral-small-latest', 'ministral-8b-latest'],
  together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', 'meta-llama/Llama-Vision-Free'],
  // Hugging Face router. Chosen for multilingual coverage at low cost: Gemma 3
  // covers 140+ languages and Qwen3 119, which is what matters for Uzbek —
  // bigger English-centric models do worse here than these lighter ones.
  huggingface: [
    'google/gemma-3-12b-it',
    'Qwen/Qwen3-4B-Instruct-2507',
    'google/gemma-4-26B-A4B-it',
    'Qwen/Qwen3-32B',
    'meta-llama/Llama-3.1-8B-Instruct',
  ],
};

/**
 * Every provider here speaks the OpenAI chat-completions protocol, so one
 * client serves all of them — adding a provider is configuration, not code.
 *
 * `keyPrefix` enables auto-detection when keys are pasted in bulk. Providers
 * whose keys have no distinctive prefix (Mistral, Together) are selected from
 * the dropdown in the panel instead.
 *
 * Declaration order is the fallback order after the preferred provider: Groq
 * first for latency, then Mistral because its monthly allowance is large enough
 * that the agent should never be left without a working provider.
 */
const PROVIDERS = {
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyPrefix: 'gsk_',
    supportsTools: true,
    signup: 'https://console.groq.com/keys',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyPrefix: null, // no distinctive prefix — pick from the dropdown
    supportsTools: true,
    signup: 'https://console.mistral.ai/api-keys',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPrefix: 'sk-or-',
    supportsTools: true,
    signup: 'https://openrouter.ai/settings/keys',
    extraHeaders: {
      'HTTP-Referer': 'https://www.anitoku.uz/',
      'X-Title': 'ANITOKU Support Agent',
    },
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Google issues two key formats; both must auto-detect.
    keyPrefix: ['AIza', 'AQ.'],
    supportsTools: true,
    signup: 'https://aistudio.google.com/apikey',
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyPrefix: 'csk-',
    supportsTools: true,
    signup: 'https://cloud.cerebras.ai',
  },
  together: {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    keyPrefix: null,
    supportsTools: true,
    signup: 'https://api.together.ai/settings/api-keys',
  },
  huggingface: {
    id: 'huggingface',
    label: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    keyPrefix: 'hf_',
    supportsTools: true,
    signup: 'https://huggingface.co/settings/tokens',
  },
};

/**
 * Hard policy rules. The guardrail layer enforces these BEFORE and AFTER the
 * model runs — they are not merely prompt suggestions.
 */
const POLICY = {
  // Launch date must never be disclosed.
  secretTopics: [
    {
      id: 'launch_date',
      match:
        /(qachon|qacon|kachon|қачон|when|когда|ishga tush|ochil|reliz|release|launch|start bo|chiqad|ochilad|taqdimot\s*(qachon|sana)|sana\s*qachon|запуск|релиз|анонс|презентаци|откро|выйдет|выход|стартует|дата)/i,
      answer:
        "Aniq sanani hozircha oshkor qilmayapmiz 🙂 Lekin ishoning — juda tez orada! Barcha rasmiy e'lonlar birinchi bo'lib @anitoku kanalida chiqadi, kuzatib boring.",
    },
  ],
  // Patterns that must never appear in an outgoing message.
  leakPatterns: [
    /sk-or-v1-[A-Za-z0-9]{16,}/g,
    /gsk_[A-Za-z0-9]{20,}/g,
    /\bAPP_SECRET\b/gi,
    /\bapi[_-]?hash\b/gi,
    /\bsystem\s*prompt\b/gi,
    // Private invite links: retrieval could surface one from an old chat, and
    // handing it to a stranger would breach a closed group.
    /t\.me\/\+[\w-]+/gi,
    /t\.me\/joinchat\/[\w-]+/gi,
    // Personal identifiers picked up from conversation history.
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    /\+998[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g,
    // Telegram user IDs. Retrieval or long-term memory can surface one, and it
    // identifies a real person just as a phone number does.
    /\b(?:telegram|tg|id|айди)\s*[:=]?\s*\d{8,12}\b/gi,
    /\(\s*\d{9,12}\s*\)/g,
  ],
  maxOutgoingChars: 3500,
};

const DEFAULT_SETTINGS = {
  auto_reply: '1',
  reply_in_groups: '1',            // groups are gated by topic relevance, not by mention
  reply_to_private: '1',
  agent_paused: '1',                // safe default: a fresh install never replies until explicitly enabled
  persona_name: 'Toku',
  persona_role: 'ANITOKU rasmiy qo\'llab-quvvatlash xizmati',
  disclose_ai: '0',
  language: 'uz',
  min_delay_ms: '1200',
  max_delay_ms: '4200',
  debounce_ms: '2500',
  typing_simulation: '1',
  keep_online: '1',
  local_model_enabled: '1',      // use the local GGUF model when its files are present
  local_profile: 'auto',         // auto | gpu | cpu-small
  local_context_size: '8192',
  local_purposes: 'memory:summary',  // summaries only: Gemma-on-Vulkan answered a customer in transliterated Russian at 28 s; live replies stay on the cloud
  catchup_enabled: '1',          // answer messages that arrived while the agent was down
  catchup_max_age_hours: '12',
  catchup_max_chats: '15',              // show the account as online while the agent is live
  max_replies_per_chat_hour: '25',
  max_replies_global_hour: '400',
  history_window: '14',
  assistant_history_window: '40',   // founder chats: the assistant keeps far more turns than support does
  founder_private_replies: '0',     // '1' = every assistant reply goes to the founder's private chat, even from groups
  rag_top_k: '6',
  skill_top_k: '3',
  temperature: '0.55',
  max_tokens: '700',
  primary_provider: 'groq',
  escalate_on_low_confidence: '1',
  escalation_chat_id: '',
  ingest_dialog_limit: '60',
  ingest_message_limit: '350',
  training_channel_id: TRAINING_CHANNEL_ID,
  auto_retrain_cron_hours: '12',
  quiet_hours: '',                 // e.g. "01:00-07:00" — empty = 24/7
  blacklist_ids: '',
  whitelist_ids: '',
};

module.exports = { BRAND, TRAINING_CHANNEL_ID, MODEL_CHAINS, PROVIDERS, POLICY, DEFAULT_SETTINGS };
