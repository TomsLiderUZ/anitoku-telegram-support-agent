import { Link } from "react-router-dom";
import { preloadRouteByPath } from "../router/routes";

/**
 * AppLink — react-router Link'ining prefetch'li varianti.
 *
 * Foydalanuvchi link ustiga borishi (hover), unga fokus qilishi yoki
 * telefonda barmog'ini tekkizishi bilan mo'ljal sahifaning chunk'i
 * fonda yuklab qo'yiladi. Bosish sodir bo'lganda sahifa allaqachon
 * tayyor bo'ladi — Suspense fallback ham, React'ning 300ms
 * fallback-throttle kechikishi ham ishga tushmaydi.
 *
 * ICHKI NAVIGATSIYA UCHUN DOIM SHU KOMPONENTNI ISHLATING (Link o'rniga):
 *   <AppLink to="/films">Filmlar</AppLink>
 */
const AppLink = ({ to, onMouseEnter, onFocus, onTouchStart, ...rest }) => {
  const prefetch = () => {
    const pathname = typeof to === "string" ? to : to?.pathname;
    if (pathname) preloadRouteByPath(pathname);
  };

  return (
    <Link
      to={to}
      onMouseEnter={(e) => {
        prefetch();
        onMouseEnter?.(e);
      }}
      onFocus={(e) => {
        prefetch();
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        prefetch();
        onTouchStart?.(e);
      }}
      {...rest}
    />
  );
};

export default AppLink;
