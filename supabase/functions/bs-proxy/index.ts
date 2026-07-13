// HoodScope — Blockscout caching proxy (Supabase Edge Function, Deno).
// Deploy:  supabase functions deploy bs-proxy --no-verify-jwt
// Then set config.api.mode = "cached" and config.api.supabaseFnUrl to this function's URL.
//
// It forwards ?path=/tokens/0x../holders&<params> to Blockscout, caches the JSON
// in the response_cache table with a short TTL, and returns it with open CORS.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api/v2";
const TTL_SECONDS = 60; // holder/token data refreshes ~1 min; tune per endpoint if you like

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
  "content-type": "application/json",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const inUrl = new URL(req.url);
  const path = inUrl.searchParams.get("path");
  if (!path || !path.startsWith("/")) {
    return new Response(JSON.stringify({ error: "missing path" }), { status: 400, headers: cors });
  }

  // rebuild the Blockscout URL with all params except `path`
  const bs = new URL(BLOCKSCOUT + path);
  for (const [k, v] of inUrl.searchParams) if (k !== "path") bs.searchParams.set(k, v);
  const cacheKey = bs.pathname + bs.search;

  // fresh cache hit?
  const { data: hit } = await supabase
    .from("response_cache").select("body, fetched_at").eq("path", cacheKey).maybeSingle();
  if (hit && (Date.now() - new Date(hit.fetched_at).getTime()) / 1000 < TTL_SECONDS) {
    return new Response(JSON.stringify(hit.body), { headers: { ...cors, "x-cache": "hit" } });
  }

  // miss -> fetch upstream (retry on transient 5xx)
  let body: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(bs, { headers: { accept: "application/json" } });
      if (r.ok) { body = await r.json(); break; }
    } catch (_) { /* retry */ }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  if (body === null) {
    if (hit) return new Response(JSON.stringify(hit.body), { headers: { ...cors, "x-cache": "stale" } });
    return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 502, headers: cors });
  }

  await supabase.from("response_cache").upsert({ path: cacheKey, body, fetched_at: new Date().toISOString() });
  return new Response(JSON.stringify(body), { headers: { ...cors, "x-cache": "miss" } });
});
