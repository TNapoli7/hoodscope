-- HoodScope — optional caching layer (Supabase / Postgres).
-- Only needed when config.api.mode = "cached". The site works fully without this
-- (direct mode calls Blockscout from the browser). Caching helps once you have
-- real traffic: it collapses repeat requests and protects you from rate limits.

create table if not exists response_cache (
  path        text primary key,     -- full Blockscout path + query, e.g. /tokens/0x../holders?items_count=50
  body        jsonb not null,
  fetched_at  timestamptz not null default now()
);

create index if not exists response_cache_fetched_idx on response_cache (fetched_at);

-- Optional: durable holder snapshots for history / alerts (stage 2).
create table if not exists holder_snapshot (
  id          bigserial primary key,
  token       text not null,
  taken_at    timestamptz not null default now(),
  top_json    jsonb not null,       -- [{hash,value,is_contract,label}]
  holders_cnt int
);
create index if not exists holder_snapshot_token_idx on holder_snapshot (token, taken_at desc);

-- Cache housekeeping: drop entries older than 1 day (run via pg_cron if desired).
-- select cron.schedule('hoodscope-cache-gc','*/30 * * * *',
--   $$delete from response_cache where fetched_at < now() - interval '1 day'$$);
