// Shared client-side fetch wrapper.
//
// Adds a custom header (X-Anistream-Client) to every request so the backend
// can distinguish "real frontend calls" from "random scraper hitting our API
// directly". The backend middleware returns 404 for sensitive endpoints
// (stream, audio-options, skip-times) when the header is missing — so the
// endpoints look like they don't exist to anyone reading the network tab
// and trying to replay requests.
//
// The header value is a static string baked at build time — it's NOT a secret,
// just a "are you our frontend?" signal. The real protection for stream URLs
// is still the embed-proxy token system (server-side opaque tokens with 4h TTL).
//
// All pages should use this wrapper instead of raw fetch() for /api/ calls.

export class ApiError extends Error {
  status: number;
  statusText: string;
  data: unknown;
  constructor(response: Response, data: unknown, info: { method: string; url: string }) {
    super(`${info.method} ${info.url} → ${response.status} ${response.statusText}`);
    this.status = response.status;
    this.statusText = response.statusText;
    this.data = data;
  }
}

// Static client-identity header — checked by the backend's endpoint-hiding
// middleware on /api/anime/:id/stream, /audio-options, /skip-times.
// Not a secret — just a "yes, this is our app" signal that's hard for a
// scraper to guess without reading the bundled JS.
const CLIENT_HEADER = "x-anistream-client";
const CLIENT_VALUE = "1";

export async function customFetch<T = unknown>(
  input: RequestInfo | URL,
  options: RequestInit & { responseType?: "json" | "text" | "blob" | "auto" } = {},
): Promise<T> {
  const { responseType = "auto", ...init } = options;

  // Merge the client header into the request headers.
  // Don't overwrite existing headers — just add ours.
  const headers = new Headers(init.headers);
  headers.set(CLIENT_HEADER, CLIENT_VALUE);

  const response = await fetch(input, { ...init, headers });
  if (!response.ok) {
    let data: unknown;
    try { data = await response.json(); } catch { data = await response.text(); }
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    throw new ApiError(response, data, { method: init.method ?? "GET", url });
  }
  if (response.status === 204 || response.status === 205) return undefined as T;
  if (responseType === "text") return response.text() as T;
  if (responseType === "blob") return response.blob() as T;
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json") || ct.includes("+json")) return response.json() as T;
  return response.json() as T;
}

// Convenience helper for raw fetch() calls that also need the client header.
// Use this when you want to use fetch() directly (e.g., in react-query
// queryFn) but still need the header for sensitive endpoints.
export function withClientHeader(headers: HeadersInit = {}): Headers {
  const h = new Headers(headers);
  h.set(CLIENT_HEADER, CLIENT_VALUE);
  return h;
}
