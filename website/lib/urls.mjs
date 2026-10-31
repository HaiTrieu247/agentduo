// Routes, output files and the public origin. Every link the site writes is root-relative ("/docs/cli/"), so a page
// works on any host at the origin root, and 404.html works at any depth of a missing path. Only canonical, social and
// sitemap URLs are absolute, and only when a public origin is configured.
import site from "../site.config.mjs";

export const LOCALES = site.locales;
export const DEFAULT_LOCALE = site.defaultLocale;

/** "" for the default language, "/vi" for Vietnamese. */
export function localePrefix(locale) {
  if (!LOCALES.includes(locale)) throw new Error(`unknown locale '${locale}'`);
  return locale === DEFAULT_LOCALE ? "" : `/${locale}`;
}

/** The route of a page path ("/", "/docs/cli/", "/404.html") in a language. */
export function localizedRoute(path, locale) {
  if (!path.startsWith("/")) throw new Error(`a route starts with '/': ${path}`);
  return `${localePrefix(locale)}${path}`;
}

/** The file a route is written to, relative to dist: "/" → index.html, "/vi/docs/" → vi/docs/index.html. */
export function outputFile(route) {
  const rel = route.replace(/^\//, "");
  if (rel === "" || rel.endsWith("/")) return `${rel}index.html`;
  if (/\.[a-z0-9]+$/i.test(rel)) return rel;
  throw new Error(`a route ends with '/' or a file name: ${route}`);
}

/** The route of an asset under dist/assets. */
export const assetRoute = (name) => `/assets/${name}`;

const LOOPBACK_HOSTS = /^(localhost|.*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|::1?)$/i;

export class OriginError extends Error {
  name = "OriginError";
}

/**
 * Checks one candidate origin: http(s), no credentials, no path below the root, no query or fragment, and not a
 * loopback host. Returns the normalized origin ("https://example.org").
 */
export function validateOrigin(value, from) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OriginError(`${from} is not a URL: '${value}'`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new OriginError(`${from} must start with https:// or http://: '${value}'`);
  if (url.username || url.password) throw new OriginError(`${from} must not contain a user name or password`);
  if (url.search || url.hash || value.includes("?") || value.includes("#")) throw new OriginError(`${from} must not have a query or fragment: '${value}'`);
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new OriginError(`${from} must be an origin without a path ('${value}'); the site is built for the root of its host`);
  }
  if (LOOPBACK_HOSTS.test(url.hostname)) throw new OriginError(`${from} names a local address ('${url.hostname}'), not a public site`);
  return url.origin;
}

/**
 * The public origin: SITE_URL, else Netlify's URL (set during its builds). DEPLOY_PRIME_URL and the preview server
 * are never used. With neither, the origin is null: the build leaves out absolute SEO URLs and the sitemap, and says so.
 */
export function resolveOrigin(env = process.env) {
  for (const key of ["SITE_URL", "URL"]) {
    const value = env[key]?.trim();
    if (value) return { origin: validateOrigin(value.replace(/\/+$/, ""), key), source: key };
  }
  return { origin: null, source: null };
}

/** An absolute URL on the public origin, or null without one. */
export function absoluteUrl(origin, route) {
  return origin ? `${origin}${route}` : null;
}
