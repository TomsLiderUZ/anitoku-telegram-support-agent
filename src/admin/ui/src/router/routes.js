import { lazy } from "react";
import { matchPath } from "react-router-dom";
import {
  TbLayoutDashboard,
  TbMessages,
  TbTerminal2,
  TbListCheck,
  TbStack2,
  TbBook2,
  TbCpu,
  TbSettings,
} from "react-icons/tb";

/**
 * lazyWithPreload — React.lazy'ning "Suspense throttle"siz varianti.
 *
 * MUAMMO: oddiy lazy bilan modul ALLAQACHON yuklangan bo'lsa ham React
 * birinchi renderda baribir Suspense'ga tushadi, fallback ko'rsatadi va
 * kontent tayyor bo'lsa-da uni ~300ms ushlab turadi (React'ning ichki
 * fallback-throttle mexanizmi). Aynan shu 300ms "layout chiqdi, kontent
 * kechikdi" bo'lib sezilardi.
 *
 * YECHIM: modul yuklanib bo'lgach uni oddiy komponent sifatida
 * TO'G'RIDAN-TO'G'RI render qilamiz — Suspense umuman ishga tushmaydi.
 * Modul hali kelmagan bo'lsagina (birinchi sovuq ochilish) lazy yo'liga
 * tushiladi.
 */
const lazyWithPreload = (importer) => {
  let LoadedComponent = null;
  const LazyComponent = lazy(importer);

  const Component = (props) =>
    LoadedComponent ? <LoadedComponent {...props} /> : <LazyComponent {...props} />;

  Component.preload = () =>
    importer()
      .then((m) => {
        LoadedComponent = m.default ?? m;
      })
      .catch(() => {}); // offline bo'lsa — lazy render paytida o'zi qayta urinadi

  return Component;
};

const DashboardPage = lazyWithPreload(() => import("../pages/dashboard/index"));
const ChatsPage = lazyWithPreload(() => import("../pages/chats/index"));
const AssistantPage = lazyWithPreload(() => import("../pages/assistant/index"));
const TasksPage = lazyWithPreload(() => import("../pages/tasks/index"));
const ProjectsPage = lazyWithPreload(() => import("../pages/projects/index"));
const KnowledgePage = lazyWithPreload(() => import("../pages/knowledge/index"));
const ModelsPage = lazyWithPreload(() => import("../pages/models/index"));
const SettingsPage = lazyWithPreload(() => import("../pages/settings/index"));
const AuthPage = lazyWithPreload(() => import("../pages/auth/index"));
const NotFoundPage = lazyWithPreload(() => import("../pages/notFound/index"));

/** URL'ga mos route konfiguratsiyasini topadi. Layout ham, preload ham
 *  shu yagona manbadan foydalanadi. */
export const findRouteByPath = (pathname) => {
  const effectivePath = pathname === "/" ? "/dashboard" : pathname;

  return (
    routes.find(
      (r) => r.path !== "*" && matchPath({ path: r.path, end: true }, effectivePath)
    ) || routes.find((r) => r.path === "*")
  );
};

/**
 * Berilgan URL'ga mos sahifanigina oldindan yuklaydi.
 *
 * "Hammasini oldindan yuklash" isrofga aylanadi — strategiya: birinchi
 * renderda FAQAT tashrif buyurilgan sahifa kutiladi (index.js),
 * qolganlari foydalanuvchi menyu bandi ustiga borganda (AppLink
 * hover/focus/touch) yuklanadi — bosish paytiga chunk tayyor bo'ladi.
 */
export const preloadRouteByPath = (pathname) => {
  const route = findRouteByPath(pathname);
  return route?.Component?.preload ? route.Component.preload() : Promise.resolve();
};

/**
 * Route maydonlari:
 *  - private:    faqat tizimga kirgan admin ko'ra oladi
 *  - standalone: MainLayout'siz (Sidebar/Navbar/Footer'siz) render
 *  - nav:        menyuda ko'rinadigan band ({ label, icon, group })
 *  - tabbar:     mobil pastki menyuda ham turadimi
 *
 * NEGA MENYU AYNAN SHU YERDA: sahifa, uning sarlavhasi va menyudagi
 * nomi bitta joyda tursa, yangi bo'lim qo'shganda ularning biri esdan
 * chiqib qolmaydi. Sidebar ham, tabbar ham shu ro'yxatdan o'qiydi —
 * ikkalasi hech qachon bir-biridan farq qila olmaydi.
 *
 * GURUHLAR NIYAT BO'YICHA, ob'ekt turi bo'yicha emas:
 *   Kuzatuv   — "nima bo'lyapti?"
 *   Boshqaruv — "men nimadir qilmoqchiman"
 *   Bilim     — "agent nimani biladi"
 *   Tizim     — "asboblarni sozlash"
 */
export const routes = [
  // ─── Kirish ──────────────────────────────────────────────────
  {
    title: "Kirish | ANITOKU",
    description: "ANITOKU agent boshqaruv paneliga kirish.",
    path: "/auth",
    Component: AuthPage,
    private: false,
    standalone: true,
  },

  // ─── Kuzatuv ─────────────────────────────────────────────────
  {
    title: "Boshqaruv paneli | ANITOKU",
    description: "Agentning umumiy holati: javoblar, chaqiruvlar, sarflangan tokenlar va tezlik.",
    path: "/dashboard",
    Component: DashboardPage,
    private: true,
    standalone: false,
    nav: { label: "Boshqaruv paneli", icon: TbLayoutDashboard, group: "Kuzatuv" },
    tabbar: true,
  },
  {
    title: "Suhbatlar | ANITOKU",
    description: "Agent yuritayotgan yozishmalar va javob kutayotgan savollar.",
    path: "/chats",
    Component: ChatsPage,
    private: true,
    standalone: false,
    nav: { label: "Suhbatlar", icon: TbMessages, group: "Kuzatuv" },
    tabbar: true,
  },

  // ─── Boshqaruv ───────────────────────────────────────────────
  {
    title: "Buyruq berish | ANITOKU",
    description: "Agentga to'g'ridan-to'g'ri vazifa berish va javobini ko'rish.",
    path: "/assistant",
    Component: AssistantPage,
    private: true,
    standalone: false,
    nav: { label: "Buyruq berish", icon: TbTerminal2, group: "Boshqaruv" },
    tabbar: true,
  },
  {
    title: "Vazifalar | ANITOKU",
    description: "Fonda ketayotgan ishlar, muntazam takrorlanadigan ratsion va kuzatuvlar.",
    path: "/tasks",
    Component: TasksPage,
    private: true,
    standalone: false,
    nav: { label: "Vazifalar", icon: TbListCheck, group: "Boshqaruv" },
    tabbar: true,
  },
  {
    title: "Loyihalar | ANITOKU",
    description: "Agent yozgan barcha loyihalar — bot, sayt yoki skript, farqi yo'q.",
    path: "/projects",
    Component: ProjectsPage,
    private: true,
    standalone: false,
    nav: { label: "Loyihalar", icon: TbStack2, group: "Boshqaruv" },
    tabbar: true,
  },
  {
    // Bitta loyiha ichi — menyuda alohida band emas, lekin sarlavhasi
    // va preload'i bo'lishi kerak.
    title: "Loyiha | ANITOKU",
    description: "Loyiha fayllari, kodi, jurnali va ishga tushirish boshqaruvi.",
    path: "/projects/:slug",
    Component: ProjectsPage,
    private: true,
    standalone: false,
  },

  // ─── Bilim ───────────────────────────────────────────────────
  {
    title: "Bilim va o'qitish | ANITOKU",
    description: "Agent nimalarni biladi, qanday ko'nikmalarga ega va o'zini qanday o'qitadi.",
    path: "/knowledge",
    Component: KnowledgePage,
    private: true,
    standalone: false,
    nav: { label: "Bilim va o'qitish", icon: TbBook2, group: "Bilim" },
  },

  // ─── Tizim ───────────────────────────────────────────────────
  {
    title: "AI modellar | ANITOKU",
    description: "Bulut provayderlar, kalitlar bandligi va shu kompyuterda ishlaydigan modellar.",
    path: "/models",
    Component: ModelsPage,
    private: true,
    standalone: false,
    nav: { label: "AI modellar", icon: TbCpu, group: "Tizim" },
  },
  {
    title: "Sozlamalar | ANITOKU",
    description: "Telegram ulanishi, agent xulqi va jonli jurnal.",
    path: "/settings",
    Component: SettingsPage,
    private: true,
    standalone: false,
    nav: { label: "Sozlamalar", icon: TbSettings, group: "Tizim" },
  },

  // ─── Sinov sahifasi — FAQAT dev'da ───────────────────────────
  // Production build'da bu route umuman boʻlmaydi, shuning uchun
  // sahifa chunk'i ham chiqmaydi (webpack oʻlik shoxni tashlaydi).
  ...(process.env.NODE_ENV === "development"
    ? [
        {
          title: "Sinov sahifasi | ANITOKU",
          description: "Komponentlarni tekshirish uchun sahifa.",
          path: "/test",
          Component: lazyWithPreload(() => import("../pages/test/index")),
          private: true,
          standalone: false,
        },
      ]
    : []),

  // ─── 404 ─────────────────────────────────────────────────────
  {
    title: "Sahifa topilmadi | ANITOKU",
    description: "Bu manzilda hech narsa yo'q.",
    path: "*",
    Component: NotFoundPage,
    private: false,
    standalone: true,
  },
];

/** Menyu uchun: guruhlangan, tartibi routes bilan bir xil. */
export const navGroups = routes
  .filter((r) => r.nav)
  .reduce((groups, route) => {
    const found = groups.find((g) => g.title === route.nav.group);
    const item = { path: route.path, ...route.nav };
    if (found) found.items.push(item);
    else groups.push({ title: route.nav.group, items: [item] });
    return groups;
  }, []);

/** Mobil tabbar uchun — eng ko'p ochiladigan bandlar. */
export const tabbarItems = routes
  .filter((r) => r.nav && r.tabbar)
  .map((r) => ({ path: r.path, ...r.nav }));
