import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const EXPECTED_SHA256 = new Set([
  "df5591e22ddc1a1b762098c0f081b45583c6cff2ece1cf83f0b134e703b6ea90",
]);
// "live" and "options": Terading. "commodities": Comtrading. "push": phones subscribed to trade alerts.
const ALLOWED_IDS = new Set(["live", "options", "commodities", "push"]);

function adminClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (url && legacy) {
    return createClient(url, legacy, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!url || !raw) return null;
  const secret = JSON.parse(raw).default as string | undefined;
  if (!secret) return null;
  return createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.delete("authorization");
        headers.set("apikey", secret);
        return fetch(input, { ...init, headers });
      },
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function bookId(req: Request): string | null {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "live";
  return ALLOWED_IDS.has(id) ? id : null;
}

Deno.serve(async (req: Request) => {
  const presented = await sha256Hex(req.headers.get("x-terading-secret") ?? req.headers.get("x-comtrading-secret") ?? "");
  const accepted = [...EXPECTED_SHA256].some((expected) => sameHash(presented, expected));
  if (!accepted) {
    return Response.json({ ok: false }, { status: 401 });
  }

  const id = bookId(req);
  if (!id) return Response.json({ ok: false, error: "Unknown book id." }, { status: 400 });

  const supabase = adminClient();
  if (!supabase) return Response.json({ ok: false }, { status: 500 });

  if (req.method === "GET") {
    const { data, error } = await supabase.from("paper_book").select("book").eq("id", id).maybeSingle();
    if (error) {
      console.error("paper book read failed", error.code);
      return Response.json({ ok: false }, { status: 500 });
    }
    return Response.json({ ok: true, id, book: data?.book ?? null });
  }

  if (req.method === "PUT") {
    let book: unknown;
    try {
      book = await req.json();
    } catch {
      return Response.json({ ok: false }, { status: 400 });
    }
    const { error } = await supabase.from("paper_book").upsert({
      id,
      book,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error("paper book write failed", error.code);
      return Response.json({ ok: false }, { status: 500 });
    }
    return Response.json({ ok: true, id });
  }

  return Response.json({ ok: false }, { status: 405 });
});
