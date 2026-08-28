# ANITOKU — Autonomous Support Agent

O'z-o'zini o'rgatuvchi, 24/7 ishlaydigan Telegram agenti. Telegram **akkauntiga** (bot emas,
MTProto user session) ulanadi va ikki rejimda ishlaydi:

- **Support** — mijozlarga o'zbek, rus va ingliz tillarida javob beradi
- **Yordamchi** — asoschi (@itz_toms) buyruqlarini bajaradi: xabar yuboradi, rejalashtiradi,
  eslab qoladi, chatlarni o'qiydi, BotFather orqali bot yaratadi

Boshqaruv — lokal admin panel: `http://127.0.0.1:8787`

---

## Ishga tushirish

```bash
npm install
npm run setup
npm start
```

### Windows: yo'lda bo'sh joy bo'lsa

`node-llama-cpp` GPU binari **bo'sh joyli yo'ldan** (`All Codes`, `My Productions`) ishlamaydi —
o'z-o'zini tekshirish jarayoni yiqiladi va CPU'ga tushib qoladi. Bo'sh joysiz junction yarating
va agentni undan ishga tushiring:

```
mklink /J C:\anitoku-agent "C:\ItzToms\All Codes\My Productions\.anitoku\agent\support"
cd C:\anitoku-agent
node src/index.js
```

Kod, `.env` va `data/` bir xil — junction shunchaki boshqa nom.

---

## Arxitektura

```
Telegram xabari
   │
   ├─ asoschi (@itz_toms)? ──► YORDAMCHI rejimi
   │                            assistant.js → vositalar → vazifa navbati
   │                            (Groq / Mistral — ishonchli tool calling)
   │
   └─ mijoz ────────────────► SUPPORT rejimi
                                guruh filtri → bilim qidiruvi (FTS5 + semantik)
                                → ko'nikmalar → LLM (lokal Gemma 3 yoki cloud)
                                → filtrlar → javob
```

| Modul | Vazifa |
|---|---|
| `agent/assistant.js` | Asoschi buyruqlari: prompt, vosita tsikli, "bajardim" deb yolg'on gapirishga qarshi majburiy vosita chaqiruvi |
| `agent/assistantTools.js` | 18 vosita: `send_message`, `schedule_*`, `remember`, `read_chat`, `create_bot`, `talk_to_bot`… |
| `agent/tasks.js` | SQLite'da vazifa navbati; har 20 s tekshiradi; qayta ishga tushganda davom etadi |
| `agent/memoryFacts.js` | Global xotira — "eslab qol" deterministik saqlanadi, hamma chatda va support javobida ishlaydi |
| `agent/contacts.js` | Ism / @username / telefon / guruh nomi → Telegram entity |
| `agent/timeparse.js` | "soat 15 da", "ertaga 9 da", "30 daqiqadan keyin", "завтра в 10" → vaqt |
| `agent/botfather.js` | BotFather bilan suhbat: bot yaratish, sozlash, token olish |
| `ai/local.js` | node-llama-cpp: Gemma 3 12B (chat) + bge-m3 (embedding), GPU (CUDA → Vulkan) |
| `knowledge/vectors.js` | SQLite ichida vektor indeks; ko'p tilli semantik qidiruv |
| `ai/client.js` | 7 cloud provayder + lokal; kalit rotatsiyasi; model auto-discovery |

---

## Yordamchi rejimi

Faqat `founder_ids` / `founder_username` sozlamasidagi akkaunt uchun. Boshqa hech kim — hatto
o'zini asoschi deb da'vo qilsa ham — bu rejimga tusha olmaydi.

Misollar (Telegramda yoki panel → **Buyruq berish**):

```
Eslab qol: Ma'rufabegim — ovoz aktrisasi, 2 yillik tajriba
Ma'rufaga "ovoz namunangizni kutyapmiz" deb yoz
Ertaga soat 10 da MEZOS ga eslat: shartnoma
UZ_OSUNG_TEAM guruhida oxirgi 10 ta xabar nima?
anitoku_helper_bot nomli bot yarat, tokenini ber
@somebot ga /start yubor va nima deganini ayt
Bilim bazangga qo'sh: platformada 10 ballik reyting bor
```

Xavfsizlik qulflari:
- `send_message` faqat asoschi matnida **yuborish buyrug'i** bo'lsa ishlaydi ("X kim?" degan savolga hech kimga yozilmaydi)
- Model vosita chaqirmasdan "yubordim" desa — `tool_choice: required` bilan qayta ishga tushiriladi
- "eslab qol" / "unut" modeldan mustaqil, kod darajasida bajariladi

Asoschi eskalatsiya xabariga **buyruq** bilan javob bersa ("ha, kanalim havolasini ber") —
yordamchi shu buyruqdan foydalanuvchiga yuboriladigan haqiqiy javobni tuzadi.

---

## Lokal model

Apparat: RTX 3060 12 GB → Gemma 3 12B Q4_K_M (6.8 GB) + bge-m3 (0.6 GB) VRAM'ga sig'adi.

- Fayllar: `data/models/*.gguf` (HF'dan `hf_` token bilan yuklanadi)
- `local_purposes` — lokal model qaysi chaqiruvlarga xizmat qiladi (standart: support javoblari va xotira xulosasi). Asoschi buyruqlari cloud'da qoladi — tool calling ishonchliligi uchun
- Fayl yo'q bo'lsa (masalan serverda) — cloud avtomatik

Ma'lum cheklov: CUDA prebuilt binari CUDA 13.3 drayveri bilan mos kelmadi; **Vulkan** ishlatiladi
(RTX 3060 da yetarli). Panel → **Lokal model** bo'limida holat, yuklash/bo'shatish, qayta indekslash.

---

## Support xavfsizligi

- Reliz sanasi hech qachon oshkor qilinmaydi: prompt + doimiy ko'nikma + chiquvchi filtr (uz/ru/en sanalar)
- Trening ma'lumotlarida login kodlari, taklif havolalari, telefon/karta niqoblanadi
- Chiquvchi xabarlarda API kalitlar, Telegram ID'lar, yopiq havolalar bloklanadi
- Unvonlar ("rahbar", "asoschi") faqat tasdiqlangan asoschiga
- Kill switch (`agent_paused`) ommaviy sozlama saqlashdan ajratilgan
- Kalit yo'q bo'lsa — sukut; hech qachon tayyor shablon javob emas

---

## Serverga qo'yish

Server (2 CPU, 3.8 GB, GPU yo'q) — lokal modelsiz, cloud kalitlar bilan. `pm2`:

```bash
pm2 start ecosystem.config.js && pm2 save
```

`ecosystem.config.js` da Node 22 yo'li aniq ko'rsatilgan (`node:sqlite` uchun); tizim Node 20
boshqa loyihaga tegmaydi.

⚠️ Server va lokal **bir vaqtda** ishlamasin — bir xil Telegram sessiyasi `AUTH_KEY_DUPLICATED`
bilan bekor qilinadi. Birini to'xtating.

---

## CLI

```bash
npm start / npm run dev
npm run train
npm run health
npm run reset-admin -- <login> <parol>
```
