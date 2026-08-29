import { Suspense, useEffect } from "react";
import { Route, useLocation, Navigate } from "react-router-dom";
import NProgress from "../utils/progress";
import { routes } from "./routes";
import SEO from "../components/SEO";
import ErrorBoundary from "../components/ErrorBoundary";
import { TokenManager } from "../api/tokenManager";
import { releaseScroll } from "../utils/scrollLock";

if ("scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}

/**
 * Suspense fallback — lazy chunk yuklanayotgan payt faqat NProgress
 * ko'rsatiladi; kontent kelgach fade + tepaga siljish animatsiyasi
 * bilan chiqadi (.page-transition).
 */
const RouteFallback = () => {
  useEffect(() => {
    NProgress.start();
    return () => {
      NProgress.done();
    };
  }, []);

  return null;
};

/**
 * PageTransition — har safar key o'zgarganda qayta mount bo'ladi va
 * CSS animatsiya (globals.css dagi .page-transition) qaytadan ishlaydi.
 * JS state + requestAnimationFrame ishlatilmaydi — bu kechikish va
 * qotishlarga sabab bo'lardi (qo'shimcha render + frame kutish).
 *
 * Shu bilan birga bu — sahifa HAQIQATAN chizilganining yagona ishonchli
 * belgisi: shu sababli NProgress ayni shu yerda yakunlanadi (birinchi
 * yuklashda ham, keyingi sahifalarga o'tishda ham).
 */
const PageTransition = ({ children }) => {
  useEffect(() => {
    NProgress.done();
  }, []);

  return <div className="page-transition">{children}</div>;
};

/**
 * AuthGate — private route himoyasi.
 *
 * MUHIM (kechikish bo'lmasligi uchun): bu gate HECH QACHON tarmoqni
 * kutmaydi va render'ni bloklamaydi. Token muddati tugagan bo'lsa ham
 * sahifa DARHOL ochiladi — chunki birinchi API so'rovda axios
 * interceptor 401 ni ushlab, o'zi refresh qiladi va so'rovni qaytadan
 * yuboradi; refresh ham o'xshamasa "auth:logout" hodisasi orqali
 * foydalanuvchi /auth ga yo'naltiriladi. Bu yerda faqat token umuman
 * BOR-YO'QLIGI sinxron (cookie'dan, ~0ms) tekshiriladi.
 */
const AuthGate = ({ isPrivate, children }) => {
  const { pathname } = useLocation();

  if (isPrivate && !TokenManager.hasAccessToken()) {
    return <Navigate to="/auth" replace state={{ from: pathname }} />;
  }

  // Tizimga kirgan admin /auth sahifasiga qaytmasligi kerak.
  // IZCHILLIK: yuqoridagi bilan bir xil mezon — `hasAccessToken()`.
  // Avval bu yerda `isAuthenticated()` (exp ni ham tekshiradi) edi, ya'ni
  // muddati o'tgan token bilan admin /auth da qolib ketardi, /dashboard
  // da esa kirita olardi. Endi ikkalasi ham "token bor-yo'qligi" ga
  // qaraydi; muddati o'tgan bo'lsa interceptor uni fonda yangilaydi.
  if (!isPrivate && pathname === "/auth" && TokenManager.hasAccessToken()) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
};

const RouteWrapper = ({ title, description, isPrivate, Component }) => {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    // Zaxira: ochiq oyna yoki varaq qoldirgan qulf sahifani surilishdan
    // to'sib qo'ygan bo'lsa, boshqa sahifaga o'tish uni tozalaydi.
    // Qulfsiz sahifada bu hech narsani o'zgartirmaydi.
    releaseScroll();
  }, [pathname]);

  return (
    <AuthGate isPrivate={isPrivate}>
      <SEO title={title} description={description} />
      {/* key={pathname} — route almashganda boundary ham, ichidagi
          sahifa ham qayta mount bo'ladi: eski xato holati tozalanadi
          va fade-in animatsiya qaytadan ishlaydi */}
      <ErrorBoundary key={pathname}>
        <Suspense fallback={<RouteFallback />}>
          <PageTransition>
            <Component />
          </PageTransition>
        </Suspense>
      </ErrorBoundary>
    </AuthGate>
  );
};

// standalone: false — MainLayout ichida, true — layout'siz render qilinadi
export const renderRoutes = (standalone = false) => {
  return routes
    .filter((route) => Boolean(route.standalone) === standalone)
    .map(({ path, Component, title, description, private: isPrivate }) => (
      <Route
        key={path}
        path={path.replace(/^\//, "")}
        element={
          <RouteWrapper
            title={title}
            description={description}
            isPrivate={isPrivate}
            Component={Component}
          />
        }
      />
    ));
};
