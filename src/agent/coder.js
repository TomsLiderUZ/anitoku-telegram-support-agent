'use strict';
const { createLogger } = require('../core/logger');
const { recordEvent } = require('../core/db');
const ai = require('../ai/client');
const projects = require('./projects');

const log = createLogger('coder');

/**
 * A coding agent in the style of Claude Code, scoped to one project.
 *
 * Given a task ("add an admin panel, make @itz_toms the admin"), it explores
 * the files, edits or writes them, runs commands (install, syntax check, tests)
 * and reports. The founder never sees code in the chat — only the outcome.
 */

const MAX_ROUNDS = 40;
const CODER_PLAN = [
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'gemini', model: 'gemini-3.7-flash' },
  { provider: 'groq', model: 'qwen/qwen3.8-27b' },
  { provider: 'mistral', model: 'mistral-medium-latest' },
  { provider: 'openrouter', model: 'z-ai/glm-5.2:free' },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
];

const TOOLS = [
  { type: 'function', function: { name: 'list_files', description: 'Loyihadagi fayllar roʻyxati.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: 'Faylni oʻqish.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Faylni toʻliq yozish (yangi yoki mavjudni almashtirish).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Fayldagi aniq bir parchani almashtirish. `search` faylda aynan bir marta uchrashi shart.', parameters: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'search', 'replace'] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Fayl yoki papkani oʻchirish.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Loyiha papkasida shell buyrugʻi (npm install, node --check, node test.js …). 120 s limit.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'set_run_command', description: 'Loyihani doimiy ishga tushiradigan buyruqni belgilash (masalan "node index.js").', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'finish', description: 'Ish tugadi. Qisqa hisobot: nima qilindi, qanday tekshirildi, qoldi-mi biror narsa.', parameters: { type: 'object', properties: { summary: { type: 'string' }, success: { type: 'boolean' } }, required: ['summary', 'success'] } } },
];

function systemPrompt(p) {
  return `Sen tajribali dasturchi-agentsan (Claude Code kabi ishlaysan). Loyiha: "${p.name}" (slug: ${p.slug}, turi: ${p.kind}). Papka: ${p.dir}. Ishga tushirish buyrugʻi: ${p.run_cmd || 'belgilanmagan'}.
${p.spec ? `Loyiha tavsifi: ${p.spec}` : ''}
Muhit oʻzgaruvchilari (qiymatlari yashirin, process.env orqali mavjud): ${p.envKeys && p.envKeys.length ? p.envKeys.join(', ') : 'yoʻq'}.
Platforma: ${process.platform}, Node ${process.versions.node}. Mashinada npm bor.

ISH TARTIBI:
1. Avval list_files va kerakli fayllarni read_file bilan oʻqi — koʻr-koʻrona yozma.
2. Kichik oʻzgarish — edit_file; yangi fayl yoki katta qayta yozish — write_file.
3. Har oʻzgarishdan keyin tekshir: node --check <fayl>, kerak boʻlsa npm install, test buyrugʻi. Xato chiqsa — tuzat, yana tekshir.
4. Mavjud funksiyalarni buzma va olib tashlama: vazifa "X qoʻsh" boʻlsa, eski buyruqlar/funksiyalar saqlanadi.
5. Telegram bot boʻlsa: token faqat process.env.BOT_TOKEN; kodga token yozma. Admin ID lar process.env.ADMIN_IDS (vergul bilan) yoki koddagi const ADMIN_IDS massivida — vazifada berilgan ID ni yoz.
6. Tugagach finish(summary, success). Hisobot oʻzbekcha, 2-5 jumla, kodsiz.
Ortiqcha gap yoʻq — faqat vositalar va yakuniy hisobot.`;
}

/**
 * Run one coding task inside a project.
 * @returns {{ok:boolean, summary:string, changed:string[], commands:string[], rounds:number}}
 */
async function runTask({ project, task, extraContext = null, onStep = null }) {
  const p = typeof project === 'string' ? projects.find(project) : project;
  if (!p) throw new Error(`loyiha topilmadi: ${project}`);
  const slug = p.slug;
  const changed = new Set();
  const commands = [];
  const messages = [
    { role: 'system', content: systemPrompt(p) },
    { role: 'user', content: `VAZIFA: ${task}${extraContext ? `\n\nQoʻshimcha kontekst:\n${extraContext}` : ''}` },
  ];

  let summary = '';
  let success = false;
  let rounds = 0;
  for (; rounds < MAX_ROUNDS; rounds++) {
    const out = await ai.chat({ messages, tools: TOOLS, toolChoice: 'auto', preferred: CODER_PLAN, preferredOnly: true, purpose: 'coder', maxTokens: 6000, temperature: 0.15, timeoutMs: 150_000 });
    const calls = out.toolCalls || [];
    if (!calls.length) {
      // Prose without a finish call: accept it as the report if work happened.
      summary = String(out.content || '').trim();
      if (!summary && changed.size) summary = `Oʻzgartirilgan fayllar: ${[...changed].join(', ')}`;
      success = changed.size > 0;
      break;
    }
    messages.push({ role: 'assistant', content: out.content || '', tool_calls: calls });
    let finished = false;
    for (const c of calls) {
      let args = {};
      try {
        args = typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function.arguments || {};
      } catch {
        args = {};
      }
      let result;
      try {
        result = await execute(slug, c.function.name, args, { changed, commands });
        if (c.function.name === 'finish') {
          finished = true;
          summary = String(args.summary || '');
          success = args.success !== false;
        }
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      if (onStep) onStep({ tool: c.function.name, args, result });
      messages.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(result).slice(0, 14_000) });
    }
    if (finished) break;
  }

  recordEvent('coder', 'Coding task finished', { slug, success, changed: [...changed], rounds });
  log.info('kod vazifasi tugadi', { slug, success, changed: changed.size, commands: commands.length, rounds });
  return { ok: success, summary: summary || '(hisobot yoʻq)', changed: [...changed], commands, rounds };
}

async function execute(slug, name, args, { changed, commands }) {
  switch (name) {
    case 'list_files':
      return { files: projects.listFiles(slug) };
    case 'read_file':
      return { path: args.path, content: projects.readFile(slug, args.path) };
    case 'write_file':
      changed.add(args.path);
      return projects.writeFile(slug, args.path, args.content);
    case 'edit_file':
      changed.add(args.path);
      return projects.editFile(slug, args.path, String(args.search ?? ''), String(args.replace ?? ''));
    case 'delete_file':
      changed.add(args.path);
      return projects.deleteFile(slug, args.path);
    case 'run_command': {
      commands.push(args.command);
      return projects.runCommand(args.command, { slug, timeoutMs: Math.min(600, Number(args.timeout_seconds) || 120) * 1000 });
    }
    case 'set_run_command':
      projects.update(slug, { runCmd: String(args.command) });
      return { ok: true, run_cmd: args.command };
    case 'finish':
      return { ok: true };
    default:
      return { ok: false, error: `nomaʼlum vosita ${name}` };
  }
}

module.exports = { runTask, TOOLS };
