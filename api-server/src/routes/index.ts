import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import healthRouter from "./health";
import animeRouter from "./anime";
import proxyRouter from "./proxy";

const router: IRouter = Router();

// ── Endpoint hiding middleware ──────────────────────────────────────────────
//
// Returns 404 for sensitive endpoints when the request doesn't carry our
// client-identity header (X-Anistream-Client: 1).
//
// Why: the stream/audio-options/skip-times endpoints return data that's
// only useful to OUR frontend. Anyone reading the network tab can see the
// URL pattern, but they shouldn't be able to replay requests without also
// reading our bundled JS to find the header. This is "security through
// obscurity" on top of the existing embed-proxy token system — it makes
// the endpoints LOOK like they don't exist to casual scrapers.
//
// The header value is a static string baked at build time — it's NOT a
// secret. The real protection for stream URLs is still the embed-proxy
// token system (server-side opaque tokens with 4h TTL + XOR obfuscation
// in the iframe shell HTML).
//
// Affected endpoints:
//   /api/anime/:id/stream/:epNum         — stream URL (token-wrapped)
//   /api/anime/:id/audio-options/:epNum  — per-server audio availability
//   /api/anime/:id/skip-times/:epNum     — AniSkip intro/outro timestamps
//
// NOT affected (public catalog data, no need to hide):
//   /api/home, /api/upcoming, /api/browse, /api/anime/search
//   /api/anime/:id/details, /logo, /seasons, /episodes
//
// The frontend's customFetch() automatically adds this header to every
// request — see anistream/src/lib/custom-fetch.ts.
const CLIENT_HEADER = "x-anistream-client";
const CLIENT_VALUE  = "1";

// Path patterns that require the client header. Matched as regex against
// req.path so we don't have to enumerate every variant (with/without query
// string, with/without trailing slash).
const SENSITIVE_PATTERNS = [
  /^\/anime\/\d+\/stream\/\d+/,
  /^\/anime\/\d+\/audio-options\/\d+/,
  /^\/anime\/\d+\/skip-times\/\d+/,
];

router.use((req: Request, res: Response, next: NextFunction) => {
  // Only check /api routes (this router is mounted at /api)
  const path = req.path;
  const isSensitive = SENSITIVE_PATTERNS.some((re) => re.test(path));
  if (!isSensitive) return next();

  // Check for the client header
  const headerValue = req.get(CLIENT_HEADER);
  if (headerValue !== CLIENT_VALUE) {
    // Pretend the endpoint doesn't exist — return 404, not 403.
    // A 403 would confirm the endpoint exists; a 404 leaves it ambiguous.
    return res.status(404).json({ error: "Not found" });
  }

  return next();
});

router.use(healthRouter);
router.use(animeRouter);
router.use("/proxy", proxyRouter);

export default router;
