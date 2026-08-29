import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles/index.css";
import App from "./router";
import ErrorBoundary from "./components/ErrorBoundary";
import { findRouteByPath, preloadRouteByPath } from "./router/routes";
import { TokenManager } from "./api/tokenManager";
import NProgress from "./utils/progress";
import { registerServiceWorker } from "./utils/registerServiceWorker";

// ThemeManager import bo'lishi bilan (konstruktorda) localStorage'dagi
// rejimni o'qib, birinchi renderdan OLDIN animatsiyasiz qo'llaydi —
// sahifa avval bir rejimda chizilib keyin ikkinchisiga "sakramaydi".
import "@theme";

/**
 * Panel Express serverning /ui manzilidan beriladi, shuning uchun
 * router uchun ildiz "/" emas, "/ui". Bu qiymat package.json dagi
 * `homepage` bilan bir xil bo'lishi SHART — CRA aynan shundan
 * PUBLIC_URL yasaydi va assetlar manzilini shunga qarab yozadi.
 */
const BASENAME = process.env.PUBLIC_URL || "";

/** Brauzer manzilidan basename'ni olib tashlaydi — route qidiruvi
 *  router ichidagi ("/dashboard") ko'rinishda bo'lishi kerak. */
const toRouterPath = (pathname) => {
  if (BASENAME && pathname.startsWith(BASENAME)) {
    return pathname.slice(BASENAME.length) || "/";
  }
  return pathname;
};

// Sahifa ochilishi/reload boshlandi — chiziq darhol ko'rinadi va
// birinchi sahifa chizilganda (PageTransition) yakunlanadi.
NProgress.start();

const root = ReactDOM.createRoot(document.getElementById("root"));

const renderApp = () =>
  root.render(
    // Eng yuqori darajadagi ErrorBoundary — layout yoki router'ning
    // o'zida xato bo'lsa ham oq ekran o'rniga fallback chiqadi.
    // Route ichidagi xatolarni renderRoutes'dagi ichki boundary ushlaydi.
    <ErrorBoundary>
      <BrowserRouter
        basename={BASENAME}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  );

/**
 * BU YERDA OFFLINE TEKSHIRUVI YO'Q — ataylab.
 *
 * Internetsiz sahifa ochilsa React umuman ishga tushmaydi: navigatsiya
 * so'rovini Service Worker (public/sw.js) ushlab, o'zining offline
 * ekranini qaytaradi. index.html `no-cache` bilan beriladi, ya'ni
 * brauzer keshidan ham kelmaydi.
 *
 * Aloqa ilova ochiq turganda uzilsa: pastda OfflineBanner ko'rinadi
 * (sahifa yopilmaydi — kiritilayotgan ma'lumot yo'qolmasin), hali
 * yuklanmagan sahifa ochilsa ErrorBoundary "Sahifa yuklanmadi"
 * fallback'ini beradi.
 */

// Birinchi renderda qaysi sahifa kerakligini OLDINDAN aniqlaymiz:
// himoyalangan sahifaga belgisiz kirilgan bo'lsa foydalanuvchi baribir
// /auth ga tushadi — o'shaning chunk'ini yuklaymiz (aks holda avval
// keraksiz chunk yuklanib, keyin auth uchun yana kutilardi).
const requestedPath = toRouterPath(window.location.pathname);
const requestedRoute = findRouteByPath(requestedPath);
const initialPath =
  requestedRoute?.private && !TokenManager.hasAccessToken() ? "/auth" : requestedPath;

// Birinchi render FAQAT shu sahifaning chunk'i tayyor bo'lgach (yoki
// maks 2s) — bu paytda index.html'dagi boot-loader ko'rinib turadi.
// Natijada layout va sahifa kontenti BITTA renderda birga chiqadi.
Promise.race([
  preloadRouteByPath(initialPath),
  new Promise((resolve) => setTimeout(resolve, 2000)),
]).then(renderApp);

// Offline rejim — internetsiz ochilganda tushunarli ekran ko'rsatish
registerServiceWorker();
