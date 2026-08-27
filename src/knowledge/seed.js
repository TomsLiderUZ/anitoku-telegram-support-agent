'use strict';
const store = require('./store');
const { createLogger } = require('../core/logger');
const { BRAND } = require('../config/constants');

const log = createLogger('knowledge:seed');

/** Ground-truth facts about the platform. Highest weight — always win retrieval. */
const FACTS = [
  {
    title: 'ANITOKU nima',
    tags: 'platforma,umumiy,anitoku',
    content:
      "ANITOKU — O'zbekistondagi anime va manga muxlislari uchun yaratilgan yagona ekotizim. Asosiy vazifasi: anime va manga kontentini o'zbek tiliga yuqori sifatda, aniq grammatik va uslubiy qoidalarga rioya qilgan holda lokalizatsiya qilish, hamda barcha muxlislarni bitta qulay platformada jamlash.",
  },
  {
    title: 'ANITOKU imkoniyatlari',
    tags: 'imkoniyat,funksiya,feature',
    content:
      "ANITOKU imkoniyatlari: manga mutolaasi (o'zbek tilida, qulay o'quvchi interfeysi); anime tomosha qilish va kontent kuzatuvi (premyeralar, tizerlar, so'nggi yangiliklar); aqlli va tezkor qidiruv tizimi; har bir anime uchun maxsus sahifa; 10 ballik reyting tizimi; profil bezaklari, ramkalar va customization; missiyalar va yutuqlar tizimi; do'kon orqali eksklyuziv bezaklar xaridi; doimiy yangilanib boruvchi anime yangiliklari; katta community; interaktiv AI botlar (masalan Rimuru Tempest obrazida muloqot); kross-platforma — veb-sayt va mobil ilova.",
  },
  {
    title: 'ANITOKU rasmiy havolalar',
    tags: 'link,havola,sayt,kanal,bot,kontakt',
    content: `Rasmiy sayt: ${BRAND.sites[0]} (zaxira: ${BRAND.sites[1]}). Rasmiy Telegram kanal: ${BRAND.channel}. Rasmiy bot: ${BRAND.bot}. Admin bilan bog'lanish: ${BRAND.adminContact}.`,
  },
  {
    title: 'ANITOKU ishga tushish sanasi (MAXFIY)',
    tags: 'sana,reliz,launch,qachon,maxfiy',
    content:
      "Platformaning aniq ishga tushish sanasi hozircha OSHKOR QILINMAYDI. Foydalanuvchiga faqat \"juda tez orada\" deb javob beriladi va rasmiy e'lonlarni @anitoku kanalidan kuzatib borish tavsiya etiladi. Hech qanday taxminiy sana, oy yoki yil aytilmaydi.",
    weight: 2.5,
  },
  {
    title: 'ANITOKU holati',
    tags: 'holat,status,test',
    content:
      "ANITOKU hozircha to'liq ishga tushmagan — tayyorgarlik va yakuniy sinov bosqichida. Sayt va imkoniyatlar bosqichma-bosqich ochib boriladi. Barcha yangiliklar rasmiy kanalda e'lon qilinadi.",
  },
  {
    title: 'ANITOKU jamoasiga qo\'shilish',
    tags: 'ish,vakansiya,jamoa,dubbing,tarjima',
    content:
      "ANITOKU jamoasiga quyidagi yo'nalishlarda a'zolar qabul qilinadi: ovoz aktyor(ka)lari (qizlar va o'g'il bolalar), montajyorlar, dayberlar, tarjimonlar. Ariza uchun admin bilan bog'lanish kerak: " +
      BRAND.adminContact + ". Namuna ish (ovoz yozuvi yoki tarjima parchasi) yuborish jarayonni tezlashtiradi.",
  },
  {
    title: 'ANITOKU narxi va to\'lov',
    tags: 'narx,pul,tolov,bepul,premium',
    content:
      "ANITOKU'dan foydalanish asosan bepul bo'ladi. Do'kon orqali eksklyuziv profil bezaklari va ramkalar xarid qilish imkoniyati mavjud. To'lov tizimlari va tariflar haqidagi to'liq ma'lumot rasmiy taqdimotda e'lon qilinadi.",
  },
  {
    title: 'ANITOKU mobil ilova',
    tags: 'ilova,app,android,ios,mobil',
    content:
      "ANITOKU kross-platforma loyihasi: kontentdan ham veb-sayt, ham mobil ilova orqali bir xil qulaylikda foydalanish mumkin bo'ladi. Ilovaning chiqish sanasi va yuklab olish havolalari rasmiy kanalda e'lon qilinadi.",
  },
  {
    title: 'ANITOKU AI botlari',
    tags: 'ai,bot,rimuru,sunyiy intellekt',
    content:
      "ANITOKU interfeysi va Telegram orqali sevimli anime qahramonlari obrazida muloqot qila oladigan interaktiv AI botlar taklif etadi (masalan, Rimuru Tempest). Bu botlar personaj xarakterini saqlagan holda o'zbek tilida suhbatlashadi.",
  },
];

/** Verbatim official channel posts — used both as knowledge and as style examples. */
const CHANNEL_POSTS = [
  {
    date: '2025-07-08',
    title: "AniToku jamoasiga qo'shiling (e'lon)",
    content:
      "🎙 AniToku Jamoasiga Qo'shiling! 🔔\n\nAnime sevuvchilar uchun eng zo'r o'zbekcha platforma – AniToku jamoasi kengaymoqda! Bizga quyidagi yo'nalishlarda ishchilar kerak:\n🔈 Ovoz aktyor(ka)lari – Qizlar va o'g'il bolalar\n🚩 Montajyorlar\n📣 Dayberlar\n🌐 Tarjimonlar\n\n💥 Endi faqat tomoshabin bo'lib qolmang — AniToku bilan birga anime dunyosini yaratuvchisiga aylaning!\n📱 Telegram kanal: @anitoku\n✉️ Admin: @anitoku_admin\n🌐 Sayt: https://www.anitoku.uz/\n🤖 Bot: @anitoku_bot",
  },
  {
    date: '2026-01-28',
    title: "Rasmiy taqdimot kuni e'loni",
    content:
      "🔥 ANITOKU — RASMIY TAQDIMOT KUNI!\n\nANITOKU platformasi bo'yicha eng muhim va kutilgan yangiliklar e'lon qilinadi. Taqdimotda: platformaning ishga tushish sanasi, yangi imkoniyatlar va funksiyalar, qulayliklar va asosiy afzalliklar, foydalanuvchilar uchun yaratilgan yechimlar. Barcha ma'lumotlar rasmiy ijtimoiy sahifalarda e'lon qilinadi.",
  },
  {
    date: '2026-05-20',
    title: 'Taqdimot bir kunga qoldirildi',
    content:
      "🚨 Muhim xabar: Texnik sabablarga ko'ra ANITOKU platformasining rasmiy taqdimoti bir kunga kechiktirildi. Kutilmagan noqulaylik uchun uzr so'raymiz.",
  },
  {
    date: '2026-05-21',
    title: 'ANITOKU platformasi imkoniyatlari taqdimoti',
    content:
      "🔥 ANITOKU — Anime olamini yangi darajaga olib chiqadigan platforma!\n\n💥 Qulay va zamonaviy interfeys orqali sevimli animelaringizni tez, oson va yuqori sifatda tomosha qiling!\n\n🔍 Aqlli va tezkor qidiruv tizimi\n🔔 Har bir anime uchun maxsus sahifalar\n⭐️ 10 ballik reyting tizimi orqali animelarni baholash\n🎮 Toza, chiroyli va mobil uchun mukammal moslashgan dizayn\n👑 Profil bezaklari, ramkalar va noyob customization tizimi\n🔥 Anime ko'rish orqali missiyalar bajarish va yutuqlar qo'lga kiritish\n🛒 Do'kon orqali eksklyuziv profil bezaklarini xarid qilish\n🖥 Doimiy yangilanib boruvchi anime yangiliklari\n🌐 Barcha anime muxlislarini birlashtiruvchi katta community\n⚡️ Shaffof dizayn, sodda boshqaruv va maksimal qulaylik — barchasi ANITOKU'da!",
  },
];

/** Baseline FAQ so the agent is useful on its very first message, pre-training. */
const FAQ = [
  ['ANITOKU qachon ishga tushadi?', "Aniq sanani hozircha oshkor qilmayapmiz 🙂 Lekin juda tez orada! Barcha rasmiy e'lonlar birinchi bo'lib @anitoku kanalida chiqadi — kuzatib boring."],
  ['ANITOKU nima?', "ANITOKU — anime va mangani o'zbek tilida yuqori sifatda taqdim etuvchi platforma. Manga o'qish, anime kuzatish, yangiliklar, reyting, profil customization va AI botlar — barchasi bitta joyda."],
  ['Saytingiz bormi?', "Ha, rasmiy saytimiz: https://www.anitoku.uz/ — rasmiy kanal esa @anitoku."],
  ['Mobil ilova bormi?', "Ha, ANITOKU kross-platforma loyihasi — veb-sayt va mobil ilova rejalashtirilgan. Ilova haqidagi to'liq ma'lumot rasmiy kanalda e'lon qilinadi."],
  ['Bepulmi?', "Asosiy imkoniyatlar bepul bo'ladi. Do'konda esa eksklyuziv profil bezaklari va ramkalar bo'ladi."],
  ["Jamoaga qanday qo'shilaman?", "Ovoz aktyorligi, montaj, dayberlik yoki tarjima yo'nalishida qo'shilishingiz mumkin. @anitoku_admin ga yozing va imkoni bo'lsa namuna ishingizni yuboring."],
  ['Anime qo\'shishni so\'rasam bo\'ladimi?', "Albatta! Anime yoki manga taklifingizni yozib qoldiring — jamoamiz ro'yxatga oladi va imkoniyatga qarab qo'shadi."],
  ['Sayt ochilmayapti / xato bermoqda', "Iltimos, muammoni aniqroq yozing: qaysi qurilma, brauzer va qanday xabar chiqmoqda? Iloji bo'lsa skrinshot yuboring — tezroq hal qilamiz."],
];

function run({ force = false } = {}) {
  let added = 0;
  for (const f of FACTS) {
    if (store.upsert({ source: 'seed', title: f.title, content: f.content, tags: f.tags, weight: f.weight || 2.0 })) added++;
  }
  for (const p of CHANNEL_POSTS) {
    if (store.upsert({ source: 'seed', sourceRef: `official:${p.date}`, title: p.title, content: p.content, tags: 'kanal,post,rasmiy', weight: 1.6 })) added++;
  }
  for (const [q, a] of FAQ) {
    if (store.addQA({ question: q, answer: a, source: 'seed', score: 2.0 })) added++;
  }
  log.info('Knowledge seeded', { added, force });
  return { added, ...store.stats() };
}

module.exports = { run, FACTS, CHANNEL_POSTS, FAQ };
