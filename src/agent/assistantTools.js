'use strict';
const { db, settings } = require('../core/db');
const { createLogger } = require('../core/logger');
const tg = require('../telegram/client');
const store = require('../knowledge/store');
const memoryFacts = require('./memoryFacts');
const contacts = require('./contacts');
const tasks = require('./tasks');
const botfather = require('./botfather');
const bots = require('./bots');
const telegramOps = require('./telegramOps');
const watches = require('./watches');
const projects = require('./projects');
const coder = require('./coder');
const sites = require('./sites');
const servers = require('./servers');
const shell = require('./shell');
const routines = require('./routines');
const todo = require('./todo');
const { parseWhen, fmtTashkent } = require('./timeparse');
const ingest = require('../knowledge/ingest');

const log = createLogger('assistant:tools');

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const S = (description) => ({ type: 'string', description });
const I = (description) => ({ type: 'integer', description });
const B = (description) => ({ type: 'boolean', description });

/**
 * What the assistant can DO for the founder. Every tool acts on the real
 * account or this machine, so this executor is only ever constructed for a
 * verified founder message — never for a customer.
 */
const definitions = [
  // ── messaging ──────────────────────────────────────────────────────────
  fn('send_message', "Telegramda kimgadir xabar yuborish. `to` — ism, @username, telefon, guruh nomi yoki chat ID. 'menga' = Yosh Ustaning shaxsiy chati. Matnni Yosh Usta aytgan maʼnoda tabiiy va toʻliq jumla qilib yoz. Savol yuborib javobini kutish kerak boʻlsa (\"soʻrab koʻr, javobini menga yoz\") wait_reply=true qil — javob kelganda avtomatik Yosh Ustaning shaxsiy chatiga yetkaziladi.",
    { to: S('Qabul qiluvchi'), text: S('Xabar matni'), wait_reply: B("Javob kelganda Yosh Ustaga shaxsiy chatda xabar berish"), reply_note: S("Kuzatuv izohi, masalan 'yoshi'") }, ['to', 'text']),
  fn('send_private', "Yosh Ustaning SHAXSIY chatiga xabar yozish. Token, parol, kalit, havola, hisobot — guruhda soʻralgan boʻlsa ham maxfiy narsa FAQAT shu vosita orqali beriladi.", { text: S('Matn') }, ['text']),
  fn('delete_message', "Xabarni oʻchirish (ikkala tomondan). message_ids berilmasa — shu chatdagi oʻzimning oxirgi xabarim oʻchadi. 'eski xabarni oʻchir', 'noto‘g‘ri yubording, oʻchir' desa ishlat.", { chat: S('Chat / odam'), message_ids: { type: 'array', items: { type: 'integer' } } }, ['chat']),
  fn('schedule_message', "Kelajakdagi vaqtga xabar rejalashtirish. `when` — Yosh Usta aytgan vaqt ifodasi, oʻzgartirmasdan.", { when: S("'soat 15:00 da', 'ertaga 9 da', '30 daqiqadan keyin'"), to: S('Qabul qiluvchi'), text: S('Xabar') }, ['when', 'to', 'text']),
  fn('schedule_task', "Kelajakda bajariladigan HAR QANDAY koʻrsatmani rejalashtirish. Belgilangan vaqtda yordamchi koʻrsatmani oʻzi bajaradi.", { when: S('vaqt'), instruction: S('Toʻliq koʻrsatma') }, ['when', 'instruction']),
  fn('watch_reply', "Biror chatdan keladigan keyingi javobni kuzatib, kelganda Yosh Ustaning shaxsiy chatiga yetkazish. Savol allaqachon yuborilgan boʻlsa ishlat.", { chat: S('Kimning javobi kutilmoqda'), note: S('Nima haqida') }, ['chat']),
  fn('list_watches', 'Kutilayotgan javoblar (kuzatuvlar) roʻyxati.', {}),
  fn('forward_message', 'Bir chatdagi xabarni boshqa chatga forward qilish.', { from_chat: S(''), message_id: I(''), to: S('') }, ['from_chat', 'message_id', 'to']),
  fn('read_chat', "Chatning soʻnggi xabarlarini oʻqish: 'X bilan nima gaplashdik', 'X javob berdimi', 'guruhda nima boʻlyapti'.", { chat: S(''), limit: I('standart 30') }, ['chat']),
  fn('find_contact', 'Odam yoki guruhni ism/username/telefon boʻyicha topish.', { query: S('') }, ['query']),
  fn('add_alias', "Odamga qoʻshimcha nom oʻrgatish: 'esingda tursin @ogabeey bu Ogʻabek'. Keyin shu nom bilan topiladi.", { user: S('@username yoki ID'), alias: S('nom') }, ['user', 'alias']),

  // ── memory & knowledge ─────────────────────────────────────────────────
  fn('remember', "Faktni doimiy xotiraga saqlash. 'eslab qol', 'yodda tut' desa MAJBURIY.", { fact: S(''), tags: S('vergul bilan, ixtiyoriy') }, ['fact']),
  fn('forget', "Xotiradan faktni oʻchirish.", { query: S('') }, ['query']),
  fn('list_memory', 'Xotiradagi barcha faktlar.', {}),
  fn('add_knowledge', "Mijozlarga javob berishda ishlatiladigan bilim bazasiga fakt qoʻshish.", { title: S(''), content: S('') }, ['content']),
  fn('search_knowledge', 'Bilim bazasidan qidirish.', { query: S('') }, ['query']),

  // ── chats: membership, creation, moderation ───────────────────────────
  fn('join_chat', "Kanal yoki guruhga aʼzo boʻlish: taklif havolasi (t.me/+…, t.me/joinchat/…) yoki @username. Bot 'majburiy obuna' soʻrasa — havolalarini shu bilan ochib aʼzo boʻl, keyin botdagi 'Tekshirish' tugmasini bos.", { link: S('havola yoki @username') }, ['link']),
  fn('leave_chat', 'Guruh yoki kanaldan chiqish (guruh oʻzi qoladi).', { chat: S('') }, ['chat']),
  fn('delete_chat', "Guruh yoki kanalni BUTUNLAY oʻchirish. Yosh Usta 'guruhni oʻchir' desa — chiqish emas, shu.", { chat: S('') }, ['chat']),
  fn('inbox_digest', "Bugun kimlar yozgan va nima boʻlgan — barcha chatlar boʻyicha xulosa. 'bugun kimlar yozdi', 'xatlarni koʻrib chiq', 'nima yangilik' desa ishlat.", { hours: I('standart 24') }),
  fn('create_chat', "Yangi KANAL yoki GURUH yaratish. Yosh Usta 'guruh yarat, meni qoʻsh, admin qil' desa — hammasini SHU BITTA chaqiruvda qil: add_users va admins ga 'me' yoz. Ommaviy boʻlsa username, maxfiy boʻlsa taklif havolasi qaytadi.", { kind: { type: 'string', enum: ['group', 'channel'] }, title: S('nomi'), about: S('tavsif'), public: B('ommaviy (username bilan)'), username: S('ommaviy boʻlsa @username'), add_users: { type: 'array', items: { type: 'string' }, description: "Qoʻshiladiganlar; Yosh Ustaning oʻzi uchun 'me'" }, admins: { type: 'array', items: { type: 'string' }, description: "Admin qilinadiganlar; Yosh Ustaning oʻzi uchun 'me'" } }, ['kind', 'title']),
  fn('chat_info', 'Guruh/kanal/odam haqida maʼlumot: ID, username, aʼzolar soni, tavsif, mening huquqlarim, taklif havolasi.', { chat: S('') }, ['chat']),
  fn('list_members', "Guruh/kanal aʼzolari roʻyxati (ism, @username, ID, roli). Ism boʻyicha qidirish mumkin.", { chat: S(''), query: S('ism boʻyicha filtr'), admins_only: B(''), limit: I('standart 200') }, ['chat']),
  fn('promote_admin', "Odamni guruh/kanalda admin qilish (toʻliq huquqlar). 'menga admin ber' → user = Yosh Usta.", { chat: S(''), user: S(''), rank: S("lavozim nomi, masalan 'Rahbar'") }, ['chat', 'user']),
  fn('demote_admin', 'Adminlikdan olish.', { chat: S(''), user: S('') }, ['chat', 'user']),
  fn('ban_user', "Odamni guruh/kanaldan chiqarib, doimiy bloklash. 'blockla', 'ban qil'.", { chat: S(''), user: S('') }, ['chat', 'user']),
  fn('kick_user', "Odamni guruhdan chiqarib yuborish (qayta kirishi mumkin). 'chiqarib yubor'.", { chat: S(''), user: S('') }, ['chat', 'user']),
  fn('unban_user', 'Blokdan chiqarish.', { chat: S(''), user: S('') }, ['chat', 'user']),
  fn('add_members', "Odamlarni guruh/kanalga qoʻshish.", { chat: S(''), users: { type: 'array', items: { type: 'string' } } }, ['chat', 'users']),
  fn('invite_link', 'Guruh/kanal uchun taklif havolasi olish.', { chat: S('') }, ['chat']),
  fn('edit_chat', 'Guruh/kanal nomi yoki tavsifini oʻzgartirish.', { chat: S(''), title: S(''), about: S('') }, ['chat']),
  fn('pin_message', 'Xabarni qadash.', { chat: S(''), message_id: I('') }, ['chat', 'message_id']),
  fn('my_chats', "Men aʼzo boʻlgan guruh va kanallar roʻyxati.", { kind: { type: 'string', enum: ['group', 'channel'] } }),

  // ── bots via BotFather ─────────────────────────────────────────────────
  fn('create_bot', "BotFather orqali yangi bot yaratish va tokenini olish. Username lotin, kamida 5 belgi, 'bot' bilan tugaydi. AVVAL list_my_bots bilan borlarini tekshir — xuddi shunday bot boʻlsa yangisini yaratma.", { name: S('Koʻrinadigan nomi'), username: S("@username, 'bot' bilan tugaydi"), description: S(''), about: S('') }, ['name', 'username']),
  fn('configure_bot', "FAQAT BotFather'dagi koʻrinish: nom, tavsif, about, menyudagi buyruqlar roʻyxati. KODGA TAʼSIR QILMAYDI — buyruq ishlashi uchun code_task/build_and_run_bot kerak.", { username: S(''), name: S(''), description: S(''), about: S(''), commands: S("Har qatorda 'buyruq - tavsif'") }, ['username']),
  fn('build_and_run_bot', "Bot uchun KOD YOZIB (yoki mavjudini OʻZGARTIRIB) shu kompyuterda ISHGA TUSHIRISH: 'kod yozib run qil', 'buyruq qoʻsh', 'tuzat', 'admin panel qoʻsh'. Bot BotFather'da bor boʻlishi kerak. Spec bermasa oʻzing mantiqiy funksiyalar tanla. Mavjud botga oʻzgartirish — `fix` maydonida. Natijadagi `commands` roʻyxatini hisobotda ayt. Kod chatga YOZILMAYDI.", { username: S('@username'), spec: S('Bot nima qilishi kerak, 3-8 jumla'), name: S(''), fix: S("Mavjud botni tuzatish/kengaytirish: nima kerak") }, ['username']),
  fn('bot_send_message', "BOTNING OʻZI nomidan xabar yuborish. Yosh Usta '@botim menga hello yozsin', 'bot falonchiga xabar bersin' desa — SHU vosita. Bu botga yozish EMAS, bot oʻz nomidan yozadi. 'menga' = Yosh Ustaning oʻzi.", { bot: S('@username'), to: S("Kimga: 'menga', @username yoki chat ID"), text: S('Bot yuboradigan matn') }, ['bot', 'to', 'text']),
  fn('bot_whoami', 'Bot tokeni ishlayotganini va u kimligini tekshirish.', { bot: S('@username') }, ['bot']),
  fn('my_bots', "Agent oʻzi yozgan va boshqarayotgan botlar: holati, tokeni, spec'i.", {}),
  fn('list_my_bots', 'Shu akkauntga tegishli barcha botlar (BotFather /mybots).', {}),
  fn('get_bot_token', "Bot tokenini olish. Yosh Usta soʻrasa BER — u egasi. Guruhda boʻlsang natijani send_private bilan yubor.", { username: S('') }, ['username']),
  fn('revoke_bot_token', "Bot tokenini BEKOR QILIB YANGISINI olish (/revoke). 'tokenni yangila' desa shu. Bir nechta bot boʻlsa har biri uchun alohida chaqir. Yangi token bazaga saqlanadi va bot avtomatik qayta ishga tushadi.", { username: S('') }, ['username']),
  fn('delete_bot', "Botni BotFather orqali butunlay oʻchirish.", { username: S('') }, ['username']),
  fn('stop_bot', 'Boshqariladigan botni toʻxtatish.', { username: S('') }, ['username']),
  fn('start_bot', 'Toʻxtatilgan botni ishga tushirish.', { username: S('') }, ['username']),
  fn('bot_logs', 'Botning soʻnggi log qatorlari.', { username: S(''), lines: I('') }, ['username']),
  fn('talk_to_bot', "Boshqa botga xabar yuborib javobini olish. Bot koʻp qadamli boʻlsa ketma-ket chaqir; tugmalar chiqsa press_button bilan bos; obuna soʻrasa join_chat bilan aʼzo boʻl va 'Tekshirish'ni bos.", { bot: S('@username'), text: S(''), wait_seconds: I('standart 15') }, ['bot', 'text']),
  fn('press_button', "Botning soʻnggi xabaridagi tugmani bosish (inline yoki klaviatura).", { bot: S('@username'), button: S('Tugma matni (qisman ham boʻladi)'), wait_seconds: I('') }, ['bot', 'button']),
  fn('read_bot', 'Bot bilan soʻnggi yozishma va hozirgi tugmalar.', { bot: S(''), limit: I('') }, ['bot']),

  // ── planning ───────────────────────────────────────────────────────────
  fn('plan', "Koʻp bosqichli ish uchun REJA tuzish. Yosh Usta bir xabarda 2 tadan koʻp ish bersa yoki ish uzoq davom etsa — AVVAL shuni chaqir, keyin bosqichma-bosqich bajar. Reja Yosh Ustaga ham koʻrinadi.", { steps: { type: 'array', items: { type: 'string' }, description: 'Bosqichlar, tartib bilan' } }, ['steps']),
  fn('plan_step_done', "Rejadagi bosqichni bajarilgan (yoki toʻsiq/oʻtkazib yuborilgan) deb belgilash. Faqat HAQIQATAN bajarilgach chaqir.", { step: S('Bosqich raqami yoki matnining bir qismi'), status: { type: 'string', enum: ['done', 'blocked', 'skipped'] }, note: S('Natija yoki sabab') }, ['step', 'status']),

  // ── terminal: the universal fallback ──────────────────────────────────
  fn('bash', "Shu kompyuterda SHELL BUYRUQ bajarish. Bu sening universal vositang: alohida vosita YOʻQ boʻlgan HAR QANDAY ishni shu orqali qil (fayl, tarmoq, git, npm, curl, jarayonlar, tizim sozlamalari, hatto 'claude' CLI). POSIX shell — mkdir -p, ls, grep, pipe hammasi ishlaydi. Ish papkasi va `cd` sessiya davomida saqlanadi. Xatoni koʻrsang oʻzing tuzatib qayta urin.", { command: S('Shell buyrugʻi'), session: S("Sessiya nomi, standart 'main'"), timeout_seconds: I('standart 120, koʻpi 600') }, ['command']),
  fn('ssh_connect', "Serverga ulanish maʼlumotlarini saqlash. Yosh Usta IP va parolni chatda bersa (masalan '206.189.157.53 root MyPass') shuni ishlat — matnni oʻzgartirmasdan `spec` ga ber. Bir marta ulangach kalit oʻrnatiladi va parol boshqa kerak boʻlmaydi.", { spec: S("IP/parol/user boʻlgan matn, xohlagan shaklda"), name: S('Serverga qisqa nom, ixtiyoriy') }, ['spec']),
  fn('ssh', "SERVERDA buyruq bajarish. `host` — ssh_connect da bergan nom yoki IP. Serverdagi har qanday ish shu orqali: pm2, docker, nginx, fayl, deploy, log. `cd` sessiya davomida saqlanadi.", { host: S('Server nomi yoki IP'), command: S('Buyruq'), session: S('Sessiya nomi, ixtiyoriy'), timeout_seconds: I('') }, ['host', 'command']),
  fn('list_servers', 'Saqlangan serverlar va terminal sessiyalari.', {}),

  // ── projects, code, servers ───────────────────────────────────────────
  fn('create_project', "Yangi loyiha yaratish (bot, API, sayt, skript — har qanday). GitHubdan koʻchirish kerak boʻlsa `git_url` ber — repo shu loyihaning papkasiga clone qilinadi va SHUNDAN KEYIN uni ishga tushirish, toʻxtatish, jurnalini oʻqish mumkin boʻladi. Rahbar .env bergan boʻlsa — `env` ga oʻsha kalit/qiymatlarni oʻzgartirmasdan qoʻy. Telegram bot uchun kind='telegram-bot'. Bot BotFather roʻyxatida boʻlmasa ham loyiha yaratiladi: ishlashi uchun faqat BOT_TOKEN kerak.",
    { name: S('nomi'), kind: { type: 'string', enum: ['node', 'telegram-bot', 'python', 'static', 'other'] }, spec: S('nima qilishi kerak'), run_cmd: S("ishga tushirish buyrugʻi, masalan 'node index.js'"), bot_username: S('telegram-bot uchun @username'), git_url: S('https://github.com/... — koʻchiriladigan repo'), env: { type: 'object', description: 'Muhit oʻzgaruvchilari: BOT_TOKEN, API kalitlar va h.k.', additionalProperties: { type: 'string' } } }, ['name']),
  fn('build_site', "SAYT / veb-ilova yasash va ISHGA TUSHIRISH. Yosh Usta 'sayt yasa', 'veb sayt qil' desa — SHU vosita. Lokalda oʻz portida ishga tushadi va ochiladigan havola qaytadi. Mavjudini oʻzgartirish uchun `fix` bilan. REJA SOʻRAMA — darhol bajar.", { name: S('Sayt nomi, masalan "anitoku-anime"'), spec: S('Sayt nima qilishi, qanday sahifalar boʻlishi — toʻliq tavsif'), fix: S('Mavjud saytni oʻzgartirish uchun') }, ['name']),
  fn('publish_site', "Saytni SERVERGA joylash va subdomenga ulash. 'serverga joyla', 'subdomenga ula' desa ishlat. pm2, nginx va HTTPS avtomatik sozlanadi. DNS yozuvi hali boʻlmasa ham joylaydi va nima qoʻshish kerakligini aytadi.", { project: S('Loyiha nomi'), domain: S('Subdomen, masalan anime.anitoku.uz') }, ['project', 'domain']),
  fn('secure_site', 'DNS tarqalgach saytga HTTPS sertifikatini ulash.', { domain: S('') }, ['domain']),
  fn('code_task', "KOD YOZISH / OʻZGARTIRISH / TUZATISH — Claude Code kabi ishlaydi: reja tuzadi, fayllarni oʻqiydi, yozadi, terminalda ishga tushirib TEKSHIRADI, xato boʻlsa tuzatadi. `project` bersang oʻsha loyihada, bermasang alohida sinov muhitida (sandbox) ishlaydi. Har qanday dastur: bot, sayt, API, skript. Natija — hisobot, kod chatga yozilmaydi.", { project: S('loyiha nomi — doimiy ish uchun; boʻsh qoldirsa sinov muhiti'), task: S('vazifa, toʻliq va aniq'), name: S('sinov muhiti uchun qisqa nom') }, ['task']),
  fn('list_projects', "Loyihalar. Standart holda faqat ishlab turgan/deploy qilinganlar; hammasi kerak boʻlsa all=true.", { all: B('sinov loyihalarini ham koʻrsatish') }),
  fn('project_files', 'Loyiha fayllari roʻyxati.', { project: S('') }, ['project']),
  fn('read_project_file', 'Loyiha faylini oʻqish.', { project: S(''), path: S('') }, ['project', 'path']),
  fn('write_project_file', 'Loyiha fayliga yozish (kichik fayllar uchun; katta ish — code_task).', { project: S(''), path: S(''), content: S('') }, ['project', 'path', 'content']),
  fn('run_command', "Shu kompyuterda TERMINAL buyrugʻi bajarish (npm install, node script.js, dir/ls, git …). project berilsa oʻsha papkada. Natija (stdout+stderr) qaytadi.", { command: S(''), project: S('ixtiyoriy'), timeout_seconds: I('standart 120') }, ['command']),
  fn('start_project', 'Loyihani doimiy jarayon sifatida ishga tushirish (run_cmd kerak).', { project: S('') }, ['project']),
  fn('stop_project', 'Loyihani toʻxtatish.', { project: S('') }, ['project']),
  fn('restart_project', 'Loyihani qayta ishga tushirish.', { project: S('') }, ['project']),
  fn('project_logs', 'Loyiha jarayonining soʻnggi logi.', { project: S(''), lines: I('') }, ['project']),
  fn('set_project_env', "Loyiha muhit oʻzgaruvchisini oʻrnatish (token, kalit). Qiymat shifrlanib saqlanadi.", { project: S(''), key: S(''), value: S('') }, ['project', 'key', 'value']),
  fn('delete_project', 'Loyihani butunlay oʻchirish (fayllar bilan).', { project: S('') }, ['project']),
  fn('list_servers', 'Ulangan serverlar roʻyxati.', {}),
  fn('add_server', "SSH server qoʻshish. Kalit bilan ulanadi: ssh_public_key ni serverning ~/.ssh/authorized_keys ga qoʻshish kerak.", { name: S(''), host: S('IP yoki domen'), user: S('standart root'), port: I('standart 22') }, ['name', 'host']),
  fn('ssh_public_key', "Agentning ochiq SSH kaliti — serverga qoʻshish uchun.", {}),
  fn('ssh_run', "Serverda buyruq bajarish (SSH). 'serverda X qil', 'serverni tekshir', 'pm2 restart'.", { server: S('nomi yoki host'), command: S(''), timeout_seconds: I('') }, ['server', 'command']),
  fn('upload_to_server', 'Loyihani serverga yuklash (scp).', { server: S(''), project: S(''), remote_path: S("masalan /var/www/app") }, ['server', 'project', 'remote_path']),

  // ── agent itself ───────────────────────────────────────────────────────
  fn('add_routine', "DOIMIY (takrorlanuvchi) vazifa qoʻshish — bir marta aytilsa, abadiy bajariladi. 'har kuni soat 9 da guruhlarni tekshir', 'har dushanba hisobot ber', 'har 2 soatda yangi xabarlarni koʻr'. Fonda oʻzi ishlaydi, boshqa ishlarga xalaqit bermaydi.", { instruction: S('Nima qilish kerak — toʻliq koʻrsatma'), schedule: S("Qachon: 'har kuni soat 9 da', 'har 2 soatda', 'har dushanba 10:00'"), title: S('Qisqa nom') }, ['instruction', 'schedule']),
  fn('list_routines', 'Doimiy vazifalar roʻyxati va keyingi bajarilish vaqti.', {}),
  fn('remove_routine', 'Doimiy vazifani oʻchirish yoki toʻxtatish.', { id: I('Vazifa raqami'), disable_only: B('faqat toʻxtatish, oʻchirmaslik') }, ['id']),
  fn('list_tasks', 'Rejalashtirilgan va bajarilgan vazifalar.', { status: S('pending | done | failed | cancelled | boʻsh') }),
  fn('cancel_task', 'Vazifani bekor qilish.', { id: I('') }, ['id']),
  fn('agent_status', 'Agent holati: Telegram, kalitlar, bilim, vazifalar, javoblar.', {}),
  fn('run_training', "Oʻz-oʻzini trening jarayonini boshlash.", {}),
  fn('set_setting', "Agent sozlamasi. Ruxsat etilgan: reply_in_groups, reply_to_private, typing_simulation, keep_online, quiet_hours, min_delay_ms, max_delay_ms, max_replies_per_chat_hour, temperature, primary_provider, founder_private_replies ('1' = Yosh Ustaga barcha javoblar shaxsiy chatga).", { key: S(''), value: S('') }, ['key', 'value']),
];

/**
 * Which tools to offer for a given request.
 *
 * Sending all ~77 schemas every time pushed requests past provider token
 * limits ("Request too large") and buried the relevant tool among dozens of
 * irrelevant ones. So a core set always goes, and topic groups are added when
 * the message mentions them. `bash` is always present — it is the fallback
 * that makes a missing group survivable.
 */
const GROUPS = {
  core: ['plan', 'plan_step_done', 'send_message', 'send_private', 'read_chat', 'find_contact', 'remember', 'forget', 'list_memory', 'bash', 'agent_status', 'inbox_digest', 'my_chats'],
  messaging: ['schedule_message', 'schedule_task', 'watch_reply', 'list_watches', 'forward_message', 'delete_message', 'add_alias'],
  chats: ['join_chat', 'leave_chat', 'delete_chat', 'create_chat', 'chat_info', 'list_members', 'promote_admin', 'demote_admin', 'ban_user', 'kick_user', 'unban_user', 'add_members', 'invite_link', 'edit_chat', 'pin_message'],
  // A bot is a project like any other, so the two groups overlap on purpose:
  // whichever one the message triggers, the whole build-and-run family is in
  // reach. Without the overlap "botga yangi buyruq qoʻsh" arrived with the bot
  // tools but no way to read the code, and "loyihani tuzat" the other way
  // round — the same job, split in half by a word.
  bots: ['create_bot', 'configure_bot', 'build_and_run_bot', 'bot_send_message', 'bot_whoami', 'my_bots', 'list_my_bots', 'get_bot_token', 'revoke_bot_token', 'delete_bot', 'stop_bot', 'start_bot', 'bot_logs', 'talk_to_bot', 'press_button', 'read_bot', 'code_task', 'project_files', 'read_project_file', 'project_logs', 'list_projects'],
  code: ['build_site', 'publish_site', 'secure_site', 'code_task', 'create_project', 'list_projects', 'project_files', 'read_project_file', 'write_project_file', 'run_command', 'start_project', 'stop_project', 'restart_project', 'project_logs', 'set_project_env', 'delete_project', 'build_and_run_bot'],
  servers: ['publish_site', 'secure_site', 'ssh_connect', 'ssh', 'list_servers', 'upload_to_server', 'add_server', 'ssh_public_key'],
  routines: ['add_routine', 'list_routines', 'remove_routine', 'list_tasks', 'cancel_task'],
  knowledge: ['add_knowledge', 'search_knowledge', 'run_training', 'set_setting'],
};

const TRIGGERS = {
  messaging: /(rejalashtir|eslat|soat|ertaga|keyin|forward|o['‘’ʻ]?chir(ib)?\s*tashla|javob(i|ini)?\s*(kel|kut)|kuzat|esingda tursin|alias|schedule|remind)/i,
  chats: /(guruh|kanal|group|channel|a['‘’ʻ]?zo|azo|admin|blok|ban|kick|chiqar|qo['‘’ʻ]?sh|taklif|invite|obuna|join|link|havola|t\.me|yarat|och\b|ochib)/i,
  bots: /(bot|botfather|token|@\w+bot|majburiy|tugma|button)/i,
  // github / clone / .env — "GitHubdan clone qilib ishlatib qoʻy" va rahbar
  // tashlagan .env bloki shu guruhga tushishi kerak, aks holda create_project
  // va set_project_env umuman yuborilmaydi va buyruq bajarilmay qoladi.
  code: /(kod|code|dastur|loyiha|project|github|gitlab|clone|repo(zitoriy)?|\.git\b|git\s?hub|\.env\b|BOT_TOKEN|API_KEY|yoz\b.*\b(bot|sayt|api|skript)|sayt|api|skript|script|npm|node|python|dеploy|deploy|test|xato.*tuzat|tuzat.*kod)/i,
  servers: /(server|ssh|vps|pm2|nginx|docker|deploy|206\.|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|parol.*server|host)/i,
  routines: /(har\s*kuni|har\s*hafta|har\s*\d+\s*(soat|daqiqa)|doim|doimiy|ratsion|routine|vazifa(lar)?\s*ro['‘’ʻ]?yxat|rejalashtirilgan)/i,
  knowledge: /(bilim|baza|knowledge|trening|o['‘’ʻ]?qit|sozlama|setting)/i,
};

const byName = new Map();

/** Tool schemas relevant to one message. */
function selectTools(text) {
  if (!byName.size) for (const d of definitions) byName.set(d.function.name, d);
  const t = String(text || '');
  const picked = new Set(GROUPS.core);
  for (const [group, re] of Object.entries(TRIGGERS)) {
    if (re.test(t)) for (const n of GROUPS[group]) picked.add(n);
  }
  /**
   * Tanilmagan xabar uchun zaxira to'plam — TOR bo'lishi kerak.
   *
   * Ilgari bu yerga chats + bots + routines qo'shilardi, ya'ni hech qaysi
   * guruhga tushmagan oddiy xabar ("Mirvohidga salom yozib yubor") 54 ta
   * vosita bilan ketardi: ~4 700 token. Tizim prompti va tarix ustiga
   * qo'shilganda so'rov 10 000 tokendan oshib, Groq uni "Request too
   * large" deb rad etardi — o'lchovda bir sutkada 265 marta. Ya'ni eng
   * tez provayder (o'rtacha 104 ms) umuman ishlatilmay, javob sekin
   * zaxiralardan kelardi.
   *
   * Xabar hech qaysi guruhga tushmasa, u deyarli har doim oddiy yozishma
   * yoki savol bo'ladi — buning uchun core + messaging yetadi. Kerakli
   * vosita chetda qolsa, chaqiruvchi to'liq ro'yxat bilan qayta uradi
   * (assistant.js dagi forcedTools yo'li), shuning uchun hech narsa
   * yo'qolmaydi — faqat har bir so'rov arzonlashadi.
   */
  if (picked.size <= GROUPS.core.length + 2) for (const n of GROUPS.messaging) picked.add(n);
  return definitions.filter((d) => picked.has(d.function.name));
}

const SETTABLE = new Set([
  'reply_in_groups', 'reply_to_private', 'typing_simulation', 'keep_online', 'quiet_hours',
  'min_delay_ms', 'max_delay_ms', 'max_replies_per_chat_hour', 'temperature', 'primary_provider', 'founder_private_replies',
]);

/**
 * Is the founder merely asking the assistant ABOUT someone, rather than
 * telling it to contact them? Block-list of read-only questions: everything
 * else is the founder's call.
 */
const isReadOnlyQuestion = (text) => {
  const t = String(text || '').trim();
  const readOnly =
    /(\bkim\b\s*\??$|\bkim\s*(u|bu|ekan|edi)\b|kimligi|nima\s+(gaplash|dedi|yozdi|deyapti|boʻlyapti|bo['‘’ʻ]?lyapti)|bormi\s*\??$|ko['‘’ʻ]?rsat\b|ro['‘’ʻ]?yxat|qaysi\s*\??$|nechta|qachon\s+(yozgan|kelgan)|(yozgan|aytgan|bergan)mi\s*\??|кто\s+(это|он|она)|что\s+(сказал|написал)|who\s+is|what\s+did)/i.test(t);
  const sendVerb =
    /(\byoz\b|yozib|yubor|jo['‘’ʻ]?nat|\bayt\b|aytib|so['‘’ʻ]?ra\b|so['‘’ʻ]?rab|so['‘’ʻ]?rang|xabar|eslat|taklif|chaqir|bildir|tabrikla|javob\s*ber|ogohlantir|reklama|напиши|отправь|скажи|спроси|передай|пригласи|\bsend\b|\bwrite\b|\btell\b|\bask\b|\binvite\b|\bremind\b)/i.test(t);
  return readOnly && !sendVerb;
};

const SELF_REF = /^(me|men|menga|o['‘’ʻ]?zim(ga)?|toms|toms\s*aka|rahbar|мне|себе|my\s*private|shaxsiy|shaxsiy\s*chat(im)?(ga)?|lichka(m)?(ga)?)$/i;

/**
 * "This group", "here", "this chat" — the conversation the instruction was
 * given in. Without this the agent kept asking for a link to a group it was
 * already sitting in, and "write /join to this group" went nowhere.
 */
const HERE_REF = /^(here|shu\s*(guruh|chat|yer)(ga|da)?|bu\s*(guruh|chat)(ga)?|shu\s*yerga|hozirgi\s*(guruh|chat)|current\s*chat|сюда|этот\s*чат)$/i;

/** Tools whose results are secrets — in a group they go to the founder's DM verbatim. */
const SECRET_TOOLS = new Set(['get_bot_token', 'revoke_bot_token', 'my_bots', 'create_bot', 'ssh_public_key', 'invite_link', 'list_members', 'create_chat', 'chat_info']);

function formatSecret(name, r) {
  if (!r || r.ok === false) return null;
  switch (name) {
    case 'get_bot_token':
      return `${r.username}: ${r.token}`;
    case 'revoke_bot_token':
      return `${r.username} — yangi token: ${r.newToken}`;
    case 'create_bot':
      return `@${r.username} yaratildi\nToken: ${r.token}\n${r.link}`;
    case 'my_bots':
      return (r.bots || []).map((b) => `${b.username}: ${b.token || '(token yoʻq)'} — ${b.status}`).join('\n');
    case 'ssh_public_key':
      return r.publicKey;
    case 'invite_link':
      return r.link;
    case 'create_chat':
      return r.chat ? `${r.chat.title}: ${r.chat.link || r.chat.id}` : null;
    case 'chat_info':
      return r.inviteLink ? `${r.title}: ${r.inviteLink}` : null;
    case 'list_members':
      return (r.members || []).slice(0, 200).map((m) => `${m.name || '-'} ${m.username ? '@' + m.username : ''} (${m.id}) ${m.role !== 'member' ? m.role : ''}`.trim()).join('\n');
    default:
      return null;
  }
}

function createExecutor(ctx) {
  const used = [];
  // One checklist per request, so a multi-step job can be tracked and shown.
  const planOwner = `assistant:${ctx.chatId}:${ctx.msgId || Date.now()}`;
  const secrets = []; // { tool, text } — delivered privately when the command came from a group
  const founderDm = ctx.founderDm;

  async function sendTo(to, text, { wait = false, note = null } = {}) {
    let target;
    let name;
    const ref = String(to || '').trim();
    if (SELF_REF.test(ref) && founderDm) {
      target = await tg.resolveEntity(founderDm);
      name = 'Yosh Usta (shaxsiy chat)';
    } else if (HERE_REF.test(ref) && ctx.chatId) {
      target = await tg.resolveEntity(ctx.chatId);
      name = ctx.chatTitle || 'shu chat';
    } else {
      const r = await contacts.resolve(to);
      target = r.entity;
      name = contacts.displayName(r.contact) || to;
    }
    const sent = await tg.client.sendMessage(target, { message: String(text), linkPreview: false });
    const chatId = String(target.id);
    if (sent) ingest.saveMessage(chatId, sent, { isAgent: true });
    log.info('xabar yuborildi', { to: name, chars: String(text).length });
    const out = { ok: true, sentTo: name, chatId, messageId: Number(sent.id) };
    if (wait && founderDm && chatId !== String(founderDm)) {
      out.watchId = watches.create({ chatId, chatName: name, sinceMsg: Number(sent.id), note, notifyChat: founderDm });
      out.note = 'Javob kelganda Yosh Ustaning shaxsiy chatiga yetkaziladi';
    }
    return out;
  }

  /** Resolve a chat reference, understanding 'here' and 'me'. */
  const chatRef = (r) => (HERE_REF.test(String(r || '').trim()) && ctx.chatId ? ctx.chatId : SELF_REF.test(String(r || '').trim()) && founderDm ? founderDm : r);

  const projectOf = (ref) => {
    const p = projects.find(ref);
    if (!p) throw new Error(`Loyiha topilmadi: "${ref}". list_projects bilan tekshiring`);
    return p;
  };

  async function execute(name, args) {
    used.push(name);
    log.debug('tool', { name, args: JSON.stringify(args).slice(0, 300) });
    const result = await run(name, args);
    if (SECRET_TOOLS.has(name)) {
      const text = formatSecret(name, result);
      if (text) secrets.push({ tool: name, text });
    }
    return result;
  }

  async function run(name, args) {
    switch (name) {
      // ── messaging ──────────────────────────────────────────────────────
      case 'send_message': {
        if (isReadOnlyQuestion(ctx.text) && !SELF_REF.test(String(args.to || ''))) {
          log.warn('send_message blocked: founder asked a question, not to send', { to: args.to });
          return { ok: false, error: "Bu savol edi, buyruq emas — hech kimga xabar yuborilmadi. Faqat maʼlumot ber." };
        }
        const wantsWatch = !!args.wait_reply || /(javob(i|ini)?\s*(kelsa|kelganda|kelishi\s*bilan|bo['‘’ʻ]?lsa)|javobini\s*(menga|ayt|yoz)|so['‘’ʻ]?rab\s*(ko['‘’ʻ]?r|ol|ber))/i.test(ctx.text || '');
        return sendTo(args.to, args.text, { wait: wantsWatch, note: args.reply_note || null });
      }
      case 'send_private': {
        if (!founderDm) return { ok: false, error: 'Yosh Ustaning shaxsiy chati aniqlanmadi' };
        const r = await sendTo('me', args.text);
        // Remember that the DM already went out, so the reply routing at the
        // end of the turn does not send the same thing a second time.
        return { ...r, deliveredNow: true };
      }
      case 'delete_message':
        return telegramOps.deleteMessages(chatRef(args.chat), args.message_ids || null);
      case 'watch_reply': {
        const r = await contacts.resolve(args.chat);
        const last = await tg.client.getMessages(r.entity, { limit: 1 });
        const id = watches.create({ chatId: String(r.entity.id), chatName: contacts.displayName(r.contact), sinceMsg: last[0] ? Number(last[0].id) : 0, note: args.note || null, notifyChat: founderDm });
        return { ok: true, watchId: id, watching: contacts.displayName(r.contact) };
      }
      case 'list_watches':
        return { watches: watches.list({ status: 'open' }).map((w) => ({ id: w.id, who: w.chat_name || w.chat_id, note: w.note, since: w.created_at })) };
      case 'schedule_message': {
        const when = parseWhen(args.when);
        if (!when) return { ok: false, error: `Vaqtni tushunmadim: "${args.when}". Masalan: "soat 15:00 da", "ertaga 9 da", "30 daqiqadan keyin"` };
        // Sarlavha keyinchalik rahbarning chatiga chiqadi, shuning uchun
        // ichki yozuv emas, odam o'qiydigan nom bo'lishi kerak: "me" —
        // bu vositaning ichki so'zi, chatda esa "sizga" deb ko'rinadi.
        const toLabel = SELF_REF.test(args.to) ? 'sizga' : `${args.to} ga`;
        const id = tasks.create({ kind: 'send_message', title: `${toLabel} xabar`, payload: { to: SELF_REF.test(args.to) ? founderDm : args.to, text: args.text }, runAt: when.at.getTime(), originChat: ctx.chatId, originMsg: ctx.msgId });
        return { ok: true, taskId: id, runAt: fmtTashkent(when.at), message: `Rejalashtirildi: ${fmtTashkent(when.at)} da ${args.to} ga yuboriladi.` };
      }
      case 'schedule_task': {
        const when = parseWhen(args.when);
        if (!when) return { ok: false, error: `Vaqtni tushunmadim: "${args.when}"` };
        const id = tasks.create({ kind: 'assistant_run', title: String(args.instruction).slice(0, 80), payload: { instruction: args.instruction, chatId: founderDm || ctx.chatId }, runAt: when.at.getTime(), originChat: ctx.chatId, originMsg: ctx.msgId });
        return { ok: true, taskId: id, runAt: fmtTashkent(when.at) };
      }
      case 'forward_message': {
        const from = await contacts.resolve(args.from_chat);
        const to = SELF_REF.test(args.to) ? { entity: await tg.resolveEntity(founderDm), contact: null } : await contacts.resolve(args.to);
        await tg.client.forwardMessages(to.entity, { messages: [Number(args.message_id)], fromPeer: from.entity });
        return { ok: true, forwardedTo: contacts.displayName(to.contact) || 'Yosh Usta' };
      }
      case 'read_chat': {
        const r = await contacts.resolve(args.chat);
        const msgs = await tg.client.getMessages(r.entity, { limit: Math.min(80, Number(args.limit) || 30) });
        return {
          chat: contacts.displayName(r.contact) || args.chat,
          messages: msgs.reverse().filter((m) => m.message).map((m) => ({ id: Number(m.id), from: m.out ? 'men' : (m.sender && (m.sender.firstName || m.sender.username)) || 'nomaʼlum', at: new Date(Number(m.date) * 1000).toISOString().slice(0, 16), text: String(m.message).slice(0, 400) })),
        };
      }
      case 'find_contact': {
        try {
          const r = await contacts.resolve(args.query);
          const c = r.contact || {};
          const shape = (x) => ({ id: x.tg_id, name: contacts.displayName(x), username: x.username || null, kind: x.kind });
          return { found: true, id: String(r.entity.id), name: contacts.displayName(c) || r.entity.firstName || null, username: c.username || r.entity.username || null, kind: c.kind, phone: c.phone || null, confidence: r.confidence, alternatives: (r.alternatives || []).map(shape) };
        } catch (err) {
          const near = contacts.searchCache(args.query, 5).map((c) => ({ id: c.tg_id, name: contacts.displayName(c), username: c.username }));
          return { found: false, error: err.message, suggestions: near };
        }
      }
      case 'add_alias': {
        const r = await contacts.resolve(args.user);
        contacts.addAlias(r.entity.id, args.alias);
        memoryFacts.remember({ fact: `${args.alias} — bu ${r.entity.username ? '@' + r.entity.username : contacts.displayName(r.contact)} (ID ${r.entity.id})`, sourceChat: ctx.chatId, sourceMsg: ctx.msgId });
        return { ok: true, user: contacts.displayName(r.contact), alias: args.alias };
      }

      // ── memory ─────────────────────────────────────────────────────────
      case 'remember':
        return memoryFacts.remember({ fact: args.fact, tags: args.tags || null, sourceChat: ctx.chatId, sourceMsg: ctx.msgId });
      case 'forget':
        return { ok: true, removed: memoryFacts.forget(args.query) };
      case 'list_memory':
        return { facts: memoryFacts.list({ limit: 100 }).map((f) => ({ id: f.id, fact: f.fact, at: f.created_at })) };
      case 'add_knowledge': {
        const id = store.upsert({ source: 'founder', title: args.title || null, content: args.content, tags: 'founder', weight: 2.5 });
        return { ok: !!id, id };
      }
      case 'search_knowledge':
        return { results: store.search(args.query, 5).map((d) => ({ title: d.title, content: String(d.content).slice(0, 500) })) };

      // ── chats ──────────────────────────────────────────────────────────
      case 'join_chat':
        return telegramOps.joinChat(args.link);
      case 'leave_chat':
        return telegramOps.leaveChat(chatRef(args.chat));
      case 'delete_chat':
        return telegramOps.deleteChat(chatRef(args.chat));
      case 'inbox_digest':
        return telegramOps.inboxDigest({ hours: Math.min(168, Number(args.hours) || 24) });
      case 'create_chat':
        try {
          const me = (x) => (SELF_REF.test(String(x)) ? founderDm : x);
          return await telegramOps.createChat({
            kind: args.kind,
            title: args.title,
            about: args.about || '',
            isPublic: !!args.public,
            username: args.username || null,
            members: (args.add_users || []).map(me),
            admins: (args.admins || []).map(me),
          });
        } catch (err) {
          return { ok: false, error: err.message, chat: err.chat || null };
        }
      case 'chat_info':
        return telegramOps.chatInfo(chatRef(args.chat));
      case 'list_members':
        return telegramOps.listMembers(chatRef(args.chat), { query: args.query || '', admins: !!args.admins_only, limit: Number(args.limit) || 200 });
      case 'promote_admin':
        return telegramOps.promoteAdmin(chatRef(args.chat), SELF_REF.test(args.user) ? founderDm : args.user, { rank: args.rank || 'admin' });
      case 'demote_admin':
        return telegramOps.demoteAdmin(chatRef(args.chat), args.user);
      case 'ban_user':
        return telegramOps.removeUser(chatRef(args.chat), args.user, { ban: true });
      case 'kick_user':
        return telegramOps.removeUser(chatRef(args.chat), args.user, { ban: false });
      case 'unban_user':
        return telegramOps.unbanUser(chatRef(args.chat), args.user);
      case 'add_members':
        return telegramOps.addMembers(chatRef(args.chat), (args.users || []).map((u) => (SELF_REF.test(u) ? founderDm : u)));
      case 'invite_link':
        return { ok: true, link: await telegramOps.inviteLink(chatRef(args.chat)) };
      case 'edit_chat':
        return telegramOps.editChat(chatRef(args.chat), { title: args.title || null, about: args.about ?? null });
      case 'pin_message':
        return telegramOps.pinMessage(chatRef(args.chat), args.message_id);
      case 'my_chats':
        return { chats: await telegramOps.myChats({ kind: args.kind || null }) };

      // ── bots ───────────────────────────────────────────────────────────
      case 'create_bot': {
        const r = await botfather.createBot({ name: args.name, username: args.username, description: args.description || null, about: args.about || null });
        if (r.ok && r.token) await bots.ensureProject(r.username, { name: r.name }).catch(() => {});
        return r;
      }
      case 'configure_bot':
        return botfather.configureBot({ username: args.username, name: args.name || null, description: args.description || null, about: args.about || null, commands: args.commands || null });
      case 'build_and_run_bot':
        return bots.build({ username: args.username, name: args.name || null, spec: args.spec || null, fix: args.fix || null });

      case 'bot_send_message': {
        // Who should receive it — resolved through the same rules as our own
        // messages, so "menga" reaches Yosh Usta and a name reaches that person.
        let chatId;
        const ref = String(args.to || '').trim();
        if (SELF_REF.test(ref) && founderDm) chatId = founderDm;
        else if (HERE_REF.test(ref) && ctx.chatId) chatId = ctx.chatId;
        else if (/^-?\d{5,}$/.test(ref)) chatId = ref;
        else {
          const r = await contacts.resolve(ref);
          chatId = String(r.entity.id);
        }
        return bots.sendAs(args.bot, chatId, args.text);
      }

      case 'bot_whoami':
        return bots.whoAmI(args.bot);

      case 'my_bots':
        return {
          bots: await Promise.all(
            bots.list().map(async (b) => ({
              username: '@' + b.username,
              name: b.name,
              status: b.status,
              token: await bots.tokenFor(b.username, { fetchIfMissing: false }),
              commands: bots.detectCommands(require('node:path').join(projects.dirOf(b.slug), 'index.js')),
              spec: String(b.spec || '').slice(0, 200),
              lastError: b.last_error,
            }))
          ),
        };
      case 'list_my_bots':
        return botfather.listMyBots();
      case 'get_bot_token': {
        const u = String(args.username || '').replace(/^@/, '');
        const cached = await bots.tokenFor(u, { fetchIfMissing: false });
        if (cached) return { ok: true, username: '@' + u, token: cached, source: 'baza' };
        const t = await botfather.getToken(u);
        await bots.ensureProject(u).catch(() => {});
        return { ...t, source: 'BotFather' };
      }
      case 'revoke_bot_token': {
        const u = String(args.username || '').replace(/^@/, '');
        const r = await botfather.revokeToken(u);
        const p = bots.find(u);
        if (p) projects.setEnv(p.slug, { BOT_TOKEN: r.token });
        let restarted = false;
        if (p && p.alive) {
          try {
            await projects.restart(p.slug);
            restarted = true;
          } catch (err) {
            log.warn('bot yangi token bilan qayta ishga tushmadi', { username: u, error: err.message });
          }
        }
        return { ok: true, username: '@' + u, newToken: r.token, restarted };
      }
      case 'delete_bot': {
        const r = await botfather.deleteBot(args.username);
        if (r.ok) bots.remove(args.username);
        return r;
      }
      case 'stop_bot':
        return bots.stop(args.username);
      case 'start_bot':
        return bots.start(args.username);
      case 'bot_logs':
        return { logs: bots.logs(args.username, Math.min(200, Number(args.lines) || 60)) || '(log boʻsh)' };
      case 'talk_to_bot': {
        const r = await botfather.talk(args.bot, args.text, { waitMs: Math.min(60, Number(args.wait_seconds) || 15) * 1000 });
        return { ok: true, replies: r.replies, text: r.text || '(bot javob bermadi)', buttons: r.buttons.map((b) => b.text), links: r.buttons.filter((b) => b.url).map((b) => ({ text: b.text, url: b.url })) };
      }
      case 'press_button':
        return botfather.pressButton(args.bot, args.button, { waitMs: Math.min(60, Number(args.wait_seconds) || 15) * 1000 });
      case 'read_bot':
        return botfather.readBot(args.bot, Math.min(20, Number(args.limit) || 5));

      // ── projects ───────────────────────────────────────────────────────
      case 'create_project': {
        const kind = args.kind || 'node';
        const env = { ...(args.env && typeof args.env === 'object' ? args.env : {}) };
        const notes = [];

        if (kind === 'telegram-bot') {
          env.ADMIN_IDS = env.ADMIN_IDS || String(settings.get('founder_ids', ''));
          /**
           * BotFather'dan token olish — IXTIYORIY qadam.
           *
           * Ilgari bu yerda xato tashlanardi va butun loyiha yaratilmasdan
           * qolardi. Sabab noto'g'ri edi: bot BotFather ro'yxatida yo'qligi
           * uni ishga tushirib bo'lmasligini bildirmaydi. Bot ishlashi
           * uchun faqat TOKEN kerak, uni kim yaratgani muhim emas —
           * BotFather egaligi faqat menyu/nom o'zgartirish uchun kerak.
           *
           * Shuning uchun token topilmasa, loyiha baribir yaratiladi va
           * tokenni keyin berish mumkinligi aytiladi.
           */
          if (!env.BOT_TOKEN && args.bot_username) {
            const u = String(args.bot_username).replace(/^@/, '');
            try {
              let tok = await bots.tokenFor(u, { fetchIfMissing: false });
              if (!tok) tok = (await botfather.getToken(u)).token;
              env.BOT_TOKEN = tok;
            } catch (err) {
              notes.push(`@${u} BotFather roʻyxatida yoʻq — tokenni oʻzingiz bersangiz bot baribir ishlaydi (set_project_env bilan BOT_TOKEN).`);
            }
          }
        }

        const p = projects.create({
          name: args.name,
          kind,
          spec: args.spec || null,
          runCmd: args.run_cmd || (kind === 'node' || kind === 'telegram-bot' ? 'node index.js' : null),
          env: Object.keys(env).length ? env : null,
        });

        // Git ombordan ko'chirish — loyiha yaratilgandan keyin, uning papkasiga.
        let cloned = null;
        if (args.git_url) {
          try {
            cloned = projects.cloneInto(p.slug, args.git_url);
            notes.push(`clone qilindi: ${cloned.files.length} ta element${cloned.hasPackageJson ? ' (package.json bor — npm install kerak)' : ''}`);
          } catch (err) {
            notes.push(`clone boʻlmadi: ${err.message}`);
          }
        }

        const fresh = projects.record(p.slug);
        return {
          ok: true,
          project: { slug: fresh.slug, name: fresh.name, kind: fresh.kind, dir: fresh.dir, run_cmd: fresh.run_cmd, envKeys: fresh.envKeys, files: fresh.files },
          cloned: cloned ? cloned.files.slice(0, 20) : null,
          notes: notes.length ? notes : undefined,
        };
      }
      // ── planning ───────────────────────────────────────────────────────
      case 'plan': {
        const items = todo.setList(planOwner, args.steps);
        return { ok: true, steps: items.length, plan: todo.summary(planOwner).text };
      }
      case 'plan_step_done': {
        const r = todo.update(planOwner, args.step, args.status || 'done', args.note || null);
        const s = todo.summary(planOwner);
        return { ...r, remaining: s ? s.total - s.done : 0, complete: s ? s.complete : true, plan: s ? s.text : null };
      }

      // ── terminal ───────────────────────────────────────────────────────
      case 'bash':
        return shell.run(args.command, {
          sessionId: `tg-${args.session || 'main'}`,
          target: 'local',
          timeoutMs: Math.min(600, Number(args.timeout_seconds) || 120) * 1000,
        });

      case 'ssh_connect': {
        const spec = shell.parseHostSpec(args.spec);
        if (!spec) return { ok: false, error: 'Matndan IP yoki domen topilmadi' };
        // Models sometimes pass the tool's own name here; the host is a far
        // better label than "ssh_connect" when it shows up in later commands.
        const given = String(args.name || '').trim();
        const name = given && !/^(ssh|ssh_connect|server|host)$/i.test(given) ? given : spec.host;
        shell.saveHost({ name, ...spec });
        const probe = await shell.run('hostname && uname -a 2>/dev/null || ver', { sessionId: `tg-ssh-${name}`, target: 'remote', host: name, timeoutMs: 45_000 });
        if (!probe.ok) return { ok: false, host: name, error: probe.output, hint: spec.password ? 'Parol notoʻgʻri boʻlishi mumkin' : 'Parol berilmagan' };
        return { ok: true, host: name, user: spec.user, connectedTo: probe.output.split('\n')[0], note: 'Kalit oʻrnatildi — bundan keyin parolsiz ishlaydi' };
      }

      case 'ssh': {
        const known = shell.getHost(args.host);
        if (!known) return { ok: false, error: `"${args.host}" serveri saqlanmagan. Avval ssh_connect bilan IP va parolni bering.` };
        return shell.run(args.command, {
          sessionId: `tg-ssh-${known.name}${args.session ? ':' + args.session : ''}`,
          target: 'remote',
          host: known.name,
          timeoutMs: Math.min(600, Number(args.timeout_seconds) || 120) * 1000,
        });
      }

      case 'list_servers':
        return { servers: shell.listHosts(), sessions: shell.listSessions(), publicKey: shell.publicKey() };

      case 'build_site':
        return sites.build({ name: args.name, spec: args.spec || null, fix: args.fix || null });

      case 'publish_site':
        return sites.publish({ project: args.project, domain: args.domain });

      case 'secure_site':
        return sites.secure(args.domain);

      case 'code_task': {
        const founderIds = String(settings.get('founder_ids', '')).split(/[,\s]+/).filter(Boolean);
        const extraContext = `Owner: @${settings.get('founder_username', 'itz_toms')}, Telegram ID ${founderIds.join(', ')}.`;
        // No project named → a sandbox run. Experiments must not clutter the
        // project list, which is exactly what the founder complained about.
        if (!args.project) {
          const r = await coder.runTask({ task: args.task, sandboxName: args.name || null, extraContext });
          return { ...r, mode: 'sandbox', note: 'Sinov muhitida bajarildi — doimiy loyiha emas' };
        }
        const p = projectOf(args.project);
        const wasRunning = p.alive;
        const r = await coder.runTask({ project: p, task: args.task, extraContext });
        let restarted = null;
        if (wasRunning || (!p.alive && p.run_cmd && r.ok && p.kind !== 'static')) {
          try {
            await projects.restart(p.slug);
            restarted = true;
          } catch (err) {
            restarted = err.message;
          }
        }
        return { ...r, mode: 'project', restarted, logsTail: restarted === true ? await new Promise((res) => setTimeout(() => res(projects.logs(p.slug, 15)), 3000)) : undefined };
      }

      case 'list_projects':
        return {
          projects: projects.list({ all: !!args.all }).map((p) => ({ slug: p.slug, name: p.name, kind: p.kind, status: p.alive ? 'running' : p.status, deployed: !!p.deployed, run_cmd: p.run_cmd, files: p.files, lastError: p.last_error })),
          bots: bots.list().map((b) => ({ username: '@' + b.username, status: b.status })),
        };
      case 'project_files':
        return { files: projects.listFiles(projectOf(args.project).slug) };
      case 'read_project_file':
        return { content: projects.readFile(projectOf(args.project).slug, args.path) };
      case 'write_project_file':
        return projects.writeFile(projectOf(args.project).slug, args.path, args.content);
      case 'run_command':
        return projects.runCommand(args.command, { slug: args.project ? projectOf(args.project).slug : null, timeoutMs: Math.min(600, Number(args.timeout_seconds) || 120) * 1000 });
      case 'start_project':
        return projects.start(projectOf(args.project).slug);
      case 'stop_project':
        return projects.stop(projectOf(args.project).slug);
      case 'restart_project':
        return projects.restart(projectOf(args.project).slug);
      case 'project_logs':
        return { logs: projects.logs(projectOf(args.project).slug, Math.min(300, Number(args.lines) || 80)) || '(log boʻsh)' };
      case 'set_project_env':
        return { ok: true, keys: projects.setEnv(projectOf(args.project).slug, { [String(args.key)]: String(args.value) }) };
      case 'delete_project':
        return projects.remove(projectOf(args.project).slug);

      // ── servers ────────────────────────────────────────────────────────
      case 'list_servers':
        return { servers: servers.list() };
      case 'add_server':
        return { ok: true, server: servers.add({ name: args.name, host: args.host, user: args.user || 'root', port: Number(args.port) || 22 }), publicKey: servers.publicKey() };
      case 'ssh_public_key':
        return { publicKey: servers.publicKey(), note: "Serverda: echo '<kalit>' >> ~/.ssh/authorized_keys" };
      case 'ssh_run':
        return servers.run(args.server, args.command, { timeoutMs: Math.min(600, Number(args.timeout_seconds) || 120) * 1000 });
      case 'upload_to_server':
        return servers.upload(args.server, projectOf(args.project).dir, args.remote_path);

      // ── agent ──────────────────────────────────────────────────────────
      case 'add_routine': {
        const r = routines.create({ title: args.title || null, instruction: args.instruction, schedule: args.schedule, chatId: founderDm || ctx.chatId });
        return { ok: true, id: r.id, schedule: routines.describe(r), nextRun: fmtTashkent(r.next_run), title: r.title };
      }
      case 'list_routines':
        return {
          routines: routines.list().map((r) => ({ id: r.id, title: r.title, schedule: routines.describe(r), enabled: !!r.enabled, nextRun: fmtTashkent(r.next_run), runs: r.runs, instruction: String(r.instruction).slice(0, 160) })),
        };
      case 'remove_routine':
        return args.disable_only ? { ok: routines.setEnabled(args.id, false), disabled: true } : { ok: routines.remove(args.id), removed: true };

      case 'list_tasks':
        return { tasks: tasks.list({ status: args.status || null, limit: 40 }).map((t) => ({ id: t.id, kind: t.kind, title: t.title, status: t.status, runAt: fmtTashkent(t.run_at), error: t.error || undefined })) };
      case 'cancel_task':
        return { ok: tasks.cancel(args.id) };
      case 'agent_status': {
        const keyPool = require('../ai/keyPool');
        const runtime = require('./runtime');
        const h = keyPool.health();
        const snap = runtime.snapshot();
        return {
          telegram: tg.status,
          keys: Object.fromEntries(Object.entries(h).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, `${v.available}/${v.total}`])),
          knowledge: store.stats().documents,
          memoryFacts: memoryFacts.list({ limit: 1000 }).length,
          pendingTasks: tasks.list({ status: 'pending' }).length,
          openWatches: watches.list({ status: 'open' }).length,
          projects: projects.list().length,
          replies24h: snap.replies24h,
          paused: snap.paused,
        };
      }
      case 'run_training': {
        const selfTrain = require('../training/selfTrain');
        if (selfTrain.state.running) return { ok: false, error: 'trening allaqachon ishlamoqda' };
        selfTrain.run().catch(() => {});
        return { ok: true, message: 'Trening boshlandi, bir necha daqiqa davom etadi.' };
      }
      case 'set_setting': {
        if (!SETTABLE.has(args.key)) return { ok: false, error: `"${args.key}" ni bu yerdan oʻzgartirib boʻlmaydi` };
        settings.set(args.key, String(args.value));
        return { ok: true, key: args.key, value: String(args.value) };
      }
      default:
        return { error: `nomaʼlum vosita: ${name}` };
    }
  }

  return { execute, used, secrets };
}

module.exports = { definitions, createExecutor, isReadOnlyQuestion, selectTools, SELF_REF };
