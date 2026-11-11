/** An opaque browser capability, NOT a verified person or a typed sender name. */
const COOKIE = "ao_message_owner";
export async function messageOwner(
  req: Request,
  create = true,
): Promise<{ hash: string | null; cookie?: string }> {
  let token = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  let cookie: string | undefined;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    if (!create) return { hash: null };
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    cookie = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return {
    hash: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
    ...(cookie ? { cookie } : {}),
  };
}
