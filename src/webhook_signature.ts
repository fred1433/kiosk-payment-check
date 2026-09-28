// HMAC-SHA256 webhook signatures with WebCrypto (works in Deno and in Supabase Edge Functions).
// Header shape `t=<unix seconds>,v1=<hex>` over `${t}.${rawBody}` is a common convention; the
// real provider's scheme is listed as "to confirm" in docs/discovery-note.md.

const enc = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signWebhook(secret: string, rawBody: string, unixSeconds: number): Promise<string> {
  return `t=${unixSeconds},v1=${await hmacHex(secret, `${unixSeconds}.${rawBody}`)}`;
}

export type SignatureCheck = "ok" | "missing" | "malformed" | "stale" | "mismatch";

export async function verifyWebhook(
  secret: string,
  rawBody: string,
  header: string | null,
  nowUnixSeconds: number,
  toleranceSeconds = 300,
): Promise<SignatureCheck> {
  if (!header) return "missing";
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return "malformed";
  if (Math.abs(nowUnixSeconds - t) > toleranceSeconds) return "stale";
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return timingSafeEqual(expected, parts.v1) ? "ok" : "mismatch";
}
