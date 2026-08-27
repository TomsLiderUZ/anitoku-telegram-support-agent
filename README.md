# ANITOKU — Autonomous Support Agent

O'z-o'zini o'rgatuvchi, 24/7 ishlaydigan Telegram support agenti. Telegram **akkauntiga** (bot emas,
MTProto user session) ulanadi, mavjud yozishmalarni o'qib o'z uslubini shakllantiradi, o'ziga system
prompt va ko'nikmalar (skills) yozadi, so'ng support xabarlariga avtomatik javob beradi.

Boshqaruv — lokal admin panel orqali: `http://127.0.0.1:8787`

---

## Tez boshlash

```bash
npm install
npm run setup      # admin, bilim bazasi, AI kalitlar
npm start          # agentni ishga tushirish
```

Panelga kiring → **Telegram** bo'limida akkauntni ulang → **Trening** bo'limida "Treningni boshlash".

Kirish ma'lumotlari `.env` faylida (`ADMIN_USER` / `ADMIN_PASSWORD`).

---

## Arxitektura

```
Telegram (MTProto user session)
        │  NewMessage event
        ▼
   runtime.js ── debounce (2.5s) · rate-limit · shouldRespond filtri
        ▼
    brain.js ── RAG kontekst + mos ko'nikmalar + suhbat tarixi
        │        └─ tool loop: search_knowledge · escalate_to_human · remember_fact
        ▼
  guardrails.js ── maxfiylik siyosati · sana tozalash · leak filtri
        ▼
Telegram (typing simulation + insoniy kechikish)
```

Yon tizimlar:

| Modul | Vazifa |
|---|---|
| `ai/keyPool.js` | 20 kalit rotatsiyasi, health tracking, provayder aytgan `Retry-After` bo'yicha cooldown |
| `ai/client.js` | Provider → model → kalit bo'yicha fallback zanjiri, tool-calling, JSON rejimi |
| `knowledge/` | SQLite FTS5 (BM25) qidiruv + o'zbek matn normalizatsiyasi (apostrof/kirill folding) |
| `training/selfTrain.js` | Ingest → uslub tahlili → mavzu klasterlash → prompt va skill generatsiyasi → distillatsiya |
| `admin/` | Autentifikatsiya, REST API, SSE log oqimi, SPA panel |

Ma'lumotlar: `data/anitoku.db` (SQLite WAL). Telegram sessiyasi va AI kalitlar **AES-256-GCM** bilan
shifrlanadi (`APP_SECRET` asosida). Generatsiya qilingan ko'nikmalar `data/skills/*.md` ga ham yoziladi.

---

## Admin panel bo'limlari

- **Boshqaruv** — jonli statistika, tizim sog'lig'i, real-vaqt log oqimi
- **Telegram** — akkaunt ulash (api_id → telefon → kod → 2FA), chat ro'yxati
- **AI kalitlar** — ommaviy import, birma-bir sinash, cooldown/nosoz holati
- **Trening** — 7 bosqichli jarayon va uning tarixi
- **Bilim bazasi** — hujjatlar, qidiruv sinovi, qo'lda fakt qo'shish
- **Ko'nikmalar** — avtomatik yozilganlarni ko'rish/tahrirlash, trigger sinovi
- **System prompt** — versiyalar, tahrirlash, runtime prompt ko'rinishi
- **Suhbatlar** — yozishmalarni ko'rish, qo'lda javob berish, operator rejimiga o'tkazish
- **Eskalatsiya** — agent odamga uzatgan murojaatlar
- **Sinov** — Telegramga yubormasdan javob generatsiya qilish
- **Sozlamalar** — 30+ parametr (limitlar, kechikish, RAG, persona, filtrlar)

---

## Telegram akkauntni ulash

### 1-qadam: api_id va api_hash olish (bir marta)

1. <https://my.telegram.org> ga kiring
2. Telefon raqamingizni `+998…` formatida kiriting → Telegram ilovangizga kod keladi → kodni kiriting
3. **API development tools** bo'limini oching
4. Formani to'ldiring: *App title* — `ANITOKU Support`, *Short name* — `anitoku`, *Platform* — `Other`
5. **Create application** → chiqqan **App api_id** va **App api_hash** ni nusxalang

> **Nega QR uchun ham kerak?** `api_id`/`api_hash` *ilovani* (ya'ni shu agentni) Telegram oldida
> tanitadi — akkauntni emas. Shuning uchun hech qanday login usuli ularsiz ishlamaydi.
> Bir marta olasiz, keyin doim ishlaydi.

### 2-qadam: kirish — ikki usuldan biri

**QR kod (tavsiya etiladi)** — panel → **Telegram** → api_id/api_hash → **QR kodni olish**.
Telefoningizdagi Telegram: **Sozlamalar → Qurilmalar → Kompyuter qurilmasini ulash** → kamerani
QR kodga tuting. QR har ~30 soniyada avtomatik yangilanadi. Skan qilgach 2FA parolingiz so'raladi.

**Telefon raqam** — "Telefon raqam bilan" tabiga o'ting → raqamni kiriting → **Kod yuborish** →
Telegramga kelgan 5 xonali kodni kiriting → 2FA parol (agar yoqilgan bo'lsa).

QR kod CSP tufayli **server tomonda** SVG sifatida generatsiya qilinadi — sahifa hech qanday
tashqi skript yuklamaydi.

Sessiya shifrlanib saqlanadi; qayta ishga tushirishda avtomatik tiklanadi. Uzilib qolsa
watchdog har daqiqada qayta ulanishga urinadi.

> **Eslatma:** userbot akkauntlar Telegram tomonidan cheklanishi mumkin. Javob tezligi limitlari
> (`max_replies_per_chat_hour`, `max_replies_global_hour`) va insoniy kechikish shu xavfni kamaytirish
> uchun mavjud — ularni juda baland qilib qo'ymang.

---

## Xavfsizlik qatlamlari

### Kill switch
`agent_paused` va `auto_reply` — agent haqiqiy odamlarga yozadimi-yo'qmi, shuni hal qiladigan
yagona tugma. Ular **ommaviy sozlama saqlashdan ajratilgan**: `/api/settings` ularni rad etadi
(`ignored` maydonida qaytaradi). Faqat `/api/agent/state` orqali o'zgaradi, hodisa jurnaliga
yoziladi, panelda esa jonli rejimga o'tishda tasdiq so'raladi. Yangi o'rnatishda default —
`agent_paused: 1`.

> Bu himoya bir hodisadan keyin qo'shildi: eski holatdagi Sozlamalar formasi saqlanganda
> pauza jimgina bekor bo'lib, agent 8 ta xabar yuborib yubordi.

### Reliz sanasi (uch qatlam)
1. `POLICY.secretTopics` — kiruvchi savol aniqlanadi (uz/ru/en) va promptga qat'iy direktiva qo'shiladi
2. `launch-date-policy` ko'nikmasi — priority 1, har doim faol, trening uni ustiga yoza olmaydi
3. `stripLaunchDates()` — chiquvchi matndan sana namunalari olib tashlanadi: o'zbek, rus
   (`21 мая`, `через 3 недели`) va ingliz oy nomlari, nisbiy muddatlar, yillar. Almashtirish
   javob tilida bo'ladi (`tez orada` / `скоро` / `soon`)

> Diqqat: JavaScriptda `\b` faqat `[A-Za-z0-9_]` bo'yicha ishlaydi, shuning uchun kirill
> namunalarida `\b` ishlatilmaydi — `21 мая` aynan shu sabab bir marta filtrdan o'tib ketgan.

### Trening ma'lumotlari gigiyenasi (`knowledge/redact.js`)
Agent haqiqiy chatlardan o'rganadi, ya'ni u yerdagi har narsa keyinchalik begonaga
javob sifatida chiqishi mumkin. Ikki daraja:
- **Butunlay tashlanadi:** Telegram login kodlari, xizmat akkauntlari (777000), yopiq guruh
  taklif havolalari (`t.me/+…`), parollar, API kalitlar
- **Niqoblanadi:** telefon, karta raqami, email

Chiquvchi xabarlarda ham taklif havolalari va shaxsiy identifikatorlar `POLICY.leakPatterns`
orqali bloklanadi.

### Prompt sifat darvozasi
Rejalashtirilgan trening odam nazoratisiz ishlaydi, shuning uchun yangi prompt faollashishdan
oldin tekshiriladi: uzunlik, `# PERSONA` bo'limi, ichida aniq sana yo'qligi, shaxsiy ma'lumot
so'rash yoki yopiq havola ulashish ko'rsatmasi yo'qligi. O'tmasa — eski versiya faol qoladi.
Versiyalar saqlanadi, panelda solishtirib almashtirish mumkin.

### Ko'p tillilik
- Til kodda aniqlanadi (`detectLanguage`) — o'zbek kirilli rus tilidan `ў/қ/ғ/ҳ` va kalit
  so'zlar bo'yicha ajratiladi
- Javob tili bo'yicha qisqa direktiva **oxirgi pozitsiyaga** qo'yiladi; uzun o'zbekcha prompt
  ichidagi qoidadan ancha ishonchli (modellar avval qozoqchaga o'tib ketgan edi)
- Qidiruvda `SYNONYMS` jadvali ru/en so'rovni o'zbekcha bilim bazasiga bog'laydi
  (`подписка` → `obuna narx`), embedding'siz

---

## Trening qanday ishlaydi

```
seed → ingest → style → topics → prompt → skills → distill
```

- **ingest** — maxfiy trening kanali (`training_channel_id`) postlari va so'nggi chatlar o'qiladi;
  operator javoblari savol-javob juftliklariga ajratiladi
- **style** — xodimning haqiqiy xabarlari LLM bilan tahlil qilinadi (ohang, emoji, jumla uzunligi, xos iboralar)
- **topics** — foydalanuvchi savollari klasterlanadi, har biriga ko'p tilli triggerlar yoziladi
- **prompt** — persona va uslub bo'limi generatsiya qilinadi, versiyalanadi
- **skills** — har bir mavzu uchun ko'nikma yoziladi (qo'lda yozilganlari himoyalangan)
- **distill** — suhbatlardan qayta ishlatiladigan toza faktlar ajratiladi

Avtomatik qayta trening: har 12 soatda (`auto_retrain_cron_hours`, 0 = o'chiq).
CLI: `npm run train`.

---

## Serverga qo'yish

**PM2 (tavsiya etiladi)**
```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

**Docker**
```bash
docker compose up -d
```

**systemd** — `anitoku-agent.service` faylidagi ko'rsatmaga qarang.

Panel `127.0.0.1` ga bog'lanadi. Uzoqdan kirish kerak bo'lsa nginx/caddy orqali TLS bilan
proksilang va `TRUST_PROXY=1` qo'ying — panelni to'g'ridan-to'g'ri internetga chiqarmang.

Monitoring: `GET /health` (autentifikatsiyasiz) — Telegram holati, mavjud kalitlar, uptime.
Sog'lom bo'lmasa `503` qaytaradi.

---

## Sozlamalar (asosiylari)

| Kalit | Standart | Izoh |
|---|---|---|
| `auto_reply` | `1` | Avtomatik javob |
| `agent_paused` | `0` | To'liq pauza |
| `reply_in_groups` | `0` | Guruhlarda faqat mention/reply da javob |
| `debounce_ms` | `2500` | Ketma-ket xabarlarni kutish |
| `min/max_delay_ms` | `1200/4200` | Insoniy kechikish oralig'i |
| `max_replies_per_chat_hour` | `25` | Chat bo'yicha limit |
| `max_replies_global_hour` | `400` | Umumiy limit |
| `rag_top_k` | `6` | Kontekstga olinadigan hujjatlar |
| `primary_provider` | `groq` | Birinchi sinaladigan provayder; qolganlari fallback |
| `quiet_hours` | — | `01:00-07:00` ko'rinishida; bo'sh = 24/7 |
| `escalation_chat_id` | — | Eskalatsiya xabarnomalari boradigan chat |

---

## CLI

```bash
npm run setup          # bootstrap (idempotent)
npm start              # agentni ishga tushirish
npm run dev            # --watch bilan
npm run train          # bir marta trening
npm run health         # sog'liq tekshiruvi (exit 0/1)
npm run reset-admin -- <login> <parol>
```

---

## Xavfsizlik

- Parollar `scrypt` bilan xeshlanadi; sessiyalar SQLite'da, HttpOnly cookie
- Login uchun eksponensial throttling (5 xato → o'sib boruvchi bloklash)
- Same-origin CSRF himoyasi + qat'iy CSP
- Sirlar faqat shifrlangan holda diskda; panelda niqoblangan ko'rinadi (`gsk_abcd…wxyz`)
- `.env` va `data/` git'ga tushmaydi

`APP_SECRET` o'zgarsa saqlangan Telegram sessiyasi va AI kalitlar o'qilmay qoladi — uni saqlab qo'ying.
