import { useEffect, useLayoutEffect, useRef } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";

import MainLayout from "../layouts/index";
import { renderRoutes } from "./renderRoutes";
import { TokenManager } from "../api/tokenManager";
import NProgress from "../utils/progress";
import OfflineBanner from "../components/OfflineBanner";

/**
 * API qatlami (axios interceptor) sessiya tugaganda "auth:logout"
 * hodisasini yuboradi — bu komponent uni tinglab, foydalanuvchini
 * login sahifasiga yo'naltiradi. (Interceptor React tashqarisida
 * ishlagani uchun navigate'ni o'zi chaqira olmaydi.)
 */
function AuthLogoutListener() {
  const navigate = useNavigate();

  useEffect(() => {
    const handleLogout = () => {
      TokenManager.clearTokens();
      navigate("/auth", { replace: true });
    };

    window.addEventListener("auth:logout", handleLogout);
    return () => window.removeEventListener("auth:logout", handleLogout);
  }, [navigate]);

  return null;
}

/**
 * RouteProgress — sahifadan sahifaga o'tishda yuklanish chizig'i.
 *
 * start() bu yerda (useLayoutEffect — yangi sahifa chizilishidan OLDIN),
 * done() esa PageTransition ichida (sahifa haqiqatan chizilganda) bo'ladi.
 * Shunda chunk allaqachon tayyor bo'lsa bar tez o'tib ketadi, sekin
 * yuklansa esa kontent chiqquncha ko'rinib turadi — ya'ni progress
 * haqiqiy holatni aks ettiradi.
 *
 * Birinchi renderda start() chaqirilmaydi, chunki uni index.js allaqachon
 * sahifa ochilishi bilanoq boshlab yuborgan.
 */
function RouteProgress() {
  const { pathname } = useLocation();
  const isFirstRender = useRef(true);

  useLayoutEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    NProgress.start();
  }, [pathname]);

  return null;
}

function AppRouter() {
  return (
    <>
      <AuthLogoutListener />
      <RouteProgress />
      <OfflineBanner />

      <Routes>
        {/* 1. MainLayout ichidagi sahifalar (Navbar, Sidebar, Footer bilan) */}
        <Route path="/" element={<MainLayout />}>
          {/* AuthGate kirmaganlarni o'zi /auth ga qaytaradi */}
          <Route index element={<Navigate to="/dashboard" replace />} />
          {renderRoutes(false)}
        </Route>

        {/* 2. Layout'siz (standalone) sahifalar: /auth, 404 */}
        {renderRoutes(true)}
      </Routes>
    </>
  );
}

export default AppRouter;
