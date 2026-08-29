/**
 * craco.config.js  — loyiha root da bo'ladi
 *
 * O'rnatish:
 *   npm install @craco/craco --save-dev
 *
 * package.json scripts ni o'zgartiring:
 *   "start": "craco start"
 *   "build": "craco build"
 *   "test":  "craco test"
 *
 * Bu config:
 *   assets/icons/*.svg fayllarni raw SVG string sifatida import qiladi.
 *   Boshqa SVG lar (components/ va hokazo) oddiy CRA xatti-harakati bilan ishlaydi.
 */

module.exports = {
  /**
   * Dev-serverda ham statik assetlar (font, rasm, ikonka, favicon)
   * brauzer memory/disk cache'idan kelsin — har reload'da 304
   * revalidatsiya so'rovlari bo'lmasin. JS/CSS bundle'lariga ATAYLAB
   * tegmaymiz: ular kod o'zgarganda darhol yangilanishi kerak.
   * (Production'da bu vazifani vercel.json headerlari bajaradi.)
   */
  devServer: (devServerConfig) => {
    const prevSetup = devServerConfig.setupMiddlewares;

    devServerConfig.setupMiddlewares = (middlewares, devServer) => {
      middlewares.unshift({
        name: "static-asset-cache-headers",
        middleware: (req, res, next) => {
          if (/\.(ttf|otf|woff2?|png|jpe?g|gif|webp|avif|svg|ico)(\?.*)?$/i.test(req.url)) {
            // MUHIM: shunchaki res.setHeader() yetarli emas — keyinroq
            // ishlaydigan express.static (public/ papka) o'zining
            // "max-age=0" qiymatini USTIDAN yozib yuboradi. writeHead'ni
            // o'rab, headerni javob jo'natilishidan OLDIN — eng oxirida —
            // qo'yamiz, shunda bizning qiymat har doim g'olib bo'ladi.
            const originalWriteHead = res.writeHead;
            res.writeHead = function (...args) {
              res.setHeader("Cache-Control", "public, max-age=86400");
              return originalWriteHead.apply(this, args);
            };
          }
          next();
        },
      });

      return prevSetup ? prevSetup(middlewares, devServer) : middlewares;
    };

    return devServerConfig;
  },

  webpack: {
    configure: (webpackConfig) => {
      // CRA ning mavjud SVG rule ni topib, faqat icons/ papkasidan chiqaramiz
      const fileLoaderRule = webpackConfig.module.rules
        .flatMap((r) => r.oneOf ?? [])
        .find((r) => r.test && r.test.toString().includes('svg'));

      if (fileLoaderRule) {
        // icons/ papkasini exclude qilamiz — u raw-loader orqali yuklanadi
        fileLoaderRule.exclude = [
          ...(fileLoaderRule.exclude ? [fileLoaderRule.exclude] : []),
          /src[\\/]assets[\\/]icons/,
        ];
      }

      // icons/ papkasi uchun raw-loader qo'shamiz
      webpackConfig.module.rules.push({
        test: /\.svg$/,
        include: /src[\\/]assets[\\/]icons/,
        use: 'raw-loader',
        type: 'javascript/auto',
      });

      return webpackConfig;
    },
  },
};