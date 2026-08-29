import { Navigate, Outlet, useLocation } from "react-router-dom";
import styles from "./index.module.scss";
import Navbar from "../components/navbar/index";
import Sidebar from "../components/sidebar/index";
import Tabbar from "../components/tabbar/index";
import Footer from "../components/footer/index";
import { findRouteByPath } from "../router/routes";
import { TokenManager } from "../api/tokenManager";

function MainLayout() {
  const { pathname } = useLocation();
  const route = findRouteByPath(pathname);

  // MUHIM: himoya aynan SHU YERDA — layout render qilinishidan OLDIN.
  // Tekshiruv faqat ichkarida bo'lsa React Router avval layoutni
  // (Sidebar/Navbar) chizib, keyin ichkaridagi Navigate'ni bajaradi —
  // natijada kirmagan foydalanuvchiga admin karkasi bir lahza ko'rinib
  // ketardi.
  if (route?.private && !TokenManager.hasAccessToken()) {
    return <Navigate to="/auth" replace state={{ from: pathname }} />;
  }

  return (
    <div className={styles.wrapper}>
      {/* CHAP: SIDEBAR — mobilda yashiriladi, o'rniga pastdagi Tabbar */}
      <Sidebar />

      {/* O'NG: ASOSIY USTUN */}
      <div className={styles.container}>
        <Navbar />

        {/*
          Sahifa kontenti. `layout-inner` — navbar bilan BITTA vertikal
          o'q (panel.css dagi izohga qarang), shuning uchun bu yerda
          alohida padding YOZILMAYDI.
        */}
        <main className={styles.content}>
          <div className={`layout-inner ${styles.inner}`}>
            <Outlet />
          </div>
        </main>

        <Footer />
      </div>

      {/* Mobil pastki menyu — faqat tor ekranda ko'rinadi */}
      <Tabbar />
    </div>
  );
}

export default MainLayout;
