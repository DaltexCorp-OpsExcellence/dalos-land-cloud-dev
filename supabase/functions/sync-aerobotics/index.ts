// sync-aerobotics — pulls Aerobotics farms/orchards + TrueFruit measurements & size forecasts
// into the aero_* tables, then re-links orchards to Land Cloud blocks (aero_rematch).
// Auth: either the cron header x-sync-key (== Vault 'aero_sync_key') or a signed-in user for
// whom farm_can_approve() is true ("Sync now" in Data Health). Deployed with verify_jwt=false
// because the cron call carries no user JWT; both paths are checked here.
// Incremental: daily runs fetch TrueFruit visits from 60 days before the newest stored visit (a full
// history since 2024 on the first run or with ?full=1); size/count/date stored for every visit; the
// detail call (size split, blemish, colour, sample GPS) runs for each orchard's latest visit when it is
// missing or Aerobotics re-processed it; forecast size splits only for the first week of runs not yet
// stored. One sync at a time (409 if another started < 15 min ago). Sync-run log kept 180 days.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const API = "https://api.aerobotics.com/farming";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = Deno.env.get("SUPABASE_URL")!;
  const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // ── auth ──
  let trigger = "";
  const key = req.headers.get("x-sync-key");
  if (key) {
    const { data } = await svc.rpc("aero_get_secret", { p_name: "aero_sync_key" });
    if (!data || data !== key) return json({ error: "bad sync key" }, 401);
    trigger = "cron";
  } else {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
    const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } }, auth: { persistSession: false },
    });
    const { data: ok, error } = await user.rpc("farm_can_approve");
    if (error || ok !== true) return json({ error: "admins only" }, 403);
    const { data: u } = await user.auth.getUser();
    trigger = "manual:" + (u?.user?.email || "user");
  }

  // one sync at a time
  const since15 = new Date(Date.now() - 15 * 60000).toISOString();
  const { data: busy } = await svc.from("aero_sync_runs").select("id").is("finished_at", null).gt("started_at", since15).limit(1);
  if (busy && busy.length) return json({ ok: false, error: "A sync is already running — try again in a few minutes." }, 409);
  const full = new URL(req.url).searchParams.get("full") === "1";
  const { data: run, error: runErr } = await svc.from("aero_sync_runs").insert({ trigger: trigger + (full ? " (full)" : "") }).select("id").single();
  if (runErr || !run) return json({ ok: false, error: "could not start the sync log: " + (runErr?.message || "no row") }, 500);
  const runId = run.id;
  const stats: Record<string, unknown> = {};
  let calls = 0;

  try {
    const { data: tok } = await svc.rpc("aero_get_secret", { p_name: "aerobotics_api_token" });
    if (!tok) throw new Error("Vault secret aerobotics_api_token missing");
    const H = { Authorization: "Bearer " + tok, Accept: "application/json" };
    const get = async (path: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        calls++;
        const r = await fetch(path.startsWith("http") ? path : API + path, { headers: H });
        if (r.ok) return await r.json();
        if (r.status === 404) return null;
        if (r.status < 500 && r.status !== 429) throw new Error(`Aerobotics ${r.status} on ${path}`);
        await new Promise((s) => setTimeout(s, 800 * (attempt + 1)));
      }
      throw new Error("Aerobotics unavailable: " + path);
    };
    const all = async (path: string) => {
      const out: any[] = [];
      let next: string | null = API + path + (path.includes("?") ? "&" : "?") + "limit=1000";
      while (next) { const p = await get(next); if (!p) throw new Error("Aerobotics list page missing: " + next); out.push(...(p.results || [])); next = p.next; }
      return out;
    };
    const upsert = async (table: string, rows: any[], onConflict: string) => {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await svc.from(table).upsert(rows.slice(i, i + 500), { onConflict });
        if (error) throw new Error(`${table}: ${error.message}`);
      }
    };
    const now = new Date().toISOString();
    // PostgREST caps a read at 1,000 rows — page every read of our own tables
    const readAll = async (mk: () => any) => {
      const out: any[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await mk().range(from, from + 999);
        if (error) throw new Error(error.message);
        out.push(...(data || [])); if (!data || data.length < 1000) break;
      }
      return out;
    };

    // 1. farms + orchards
    const farms = await all("/farms/");
    await upsert("aero_farms", farms.map((f) => ({
      id: f.id, name: f.name, total_hectares: f.total_hectares, orchard_count: f.orchard_count, synced_at: now,
    })), "id");
    const orchards = await all("/orchards/");
    const { count: prevActive } = await svc.from("aero_orchards").select("id", { count: "exact", head: true }).eq("active", true);
    if (prevActive && orchards.length < prevActive * 0.8)
      throw new Error(`Aerobotics returned ${orchards.length} orchards vs ${prevActive} active before — stopping so nothing is wrongly deactivated`);
    await upsert("aero_orchards", orchards.map((o) => ({
      id: o.id, farm_id: o.farm_id, name: (o.name || "").trim(), crop_type: o.crop_type_name, cultivar: o.cultivar_name,
      cultivar_id: o.cultivar_id, hectares: o.hectares, polygon: o.polygon, external_id: o.external_id,
      active: true, synced_at: now,
    })), "id");
    // anything not seen in this sync is no longer in Aerobotics
    { const { error } = await svc.from("aero_orchards").update({ active: false }).lt("synced_at", now).eq("active", true);
      if (error) throw new Error("deactivate: " + error.message); }
    stats.farms = farms.length; stats.orchards = orchards.length;

    // 2. TrueFruit measurements. NOTE: without a date filter the API returns only the latest
    //    processing batch (82 rows) — always pass measurement_date__gte to get the full history.
    //    List-level fields (size, count, date) are stored for EVERY visit; the detail call
    //    (size split, blemish, colour, sample GPS) only for each orchard's latest visit.
    const { data: newest } = await svc.from("aero_fruit_measurements").select("measurement_date").order("measurement_date", { ascending: false }).limit(1);
    const fromDate = (!full && newest && newest[0])
      ? new Date(new Date(newest[0].measurement_date + "T00:00:00Z").getTime() - 60 * 864e5).toISOString().slice(0, 10)
      : "2024-01-01";
    const SINCE = "measurement_date__gte=" + fromDate;
    stats.measurements_from = fromDate;
    const sizeList = await all("/truefruit/size/measurements/?" + SINCE);
    const sizeBy = new Map(sizeList.map((m) => [m.orchard_id + "|" + m.measurement_date, m]));
    const gradeRaw = await all("/truefruit/grade/measurements/?" + SINCE);
    const gMap = new Map<string, any>();            // API repeats some (orchard, date) rows — keep latest processing
    for (const g of gradeRaw) {
      const k = g.orchard_id + "|" + g.measurement_date, c = gMap.get(k);
      if (!c || (g.processed_date || "") > (c.processed_date || "")) gMap.set(k, g);
    }
    const gradeList = [...gMap.values()];
    await upsert("aero_fruit_measurements", gradeList.map((g) => {
      const s: any = sizeBy.get(g.orchard_id + "|" + g.measurement_date) || {};
      return {
        orchard_id: g.orchard_id, measurement_date: g.measurement_date, processed_date: g.processed_date,
        avg_size_mm: g.average_fruit_size_mm ?? s.average_fruit_size_mm ?? null, avg_length_mm: s.average_length_mm ?? null,
        avg_mass_g: s.average_mass_g ?? null, fruit_count: g.count_fruit_measured ?? s.count_fruit_measured ?? null,
        fruit_unit: g.fruit_unit ?? null,
      };
    }), "orchard_id,measurement_date");
    // latest visit per orchard → fetch its detail once (size split, blemish, colour, sample GPS)
    const latestVisit = new Map<number, any>();
    for (const g of gradeList) { const c = latestVisit.get(g.orchard_id); if (!c || g.measurement_date > c.measurement_date) latestVisit.set(g.orchard_id, g); }
    // detail needed when missing, or when Aerobotics re-processed the visit after we fetched it
    const have = await readAll(() => svc.from("aero_fruit_measurements").select("orchard_id,measurement_date,synced_at")
      .not("size_dist", "is", null).order("orchard_id").order("measurement_date"));
    const detailAt = new Map(have.map((h) => [h.orchard_id + "|" + h.measurement_date, (h.synced_at || "").slice(0, 10)]));
    const todo = [...latestVisit.values()].filter((g) => {
      const k = g.orchard_id + "|" + g.measurement_date;
      return !detailAt.has(k) || (g.processed_date && g.processed_date > (detailAt.get(k) || ""));
    });
    const details = await pool(todo, 6, (g) => get(`/truefruit/grade/measurements/${g.orchard_id}/${g.measurement_date}/`));
    for (let i = 0; i < todo.length; i++) {
      const g = todo[i], d = details[i];
      if (!d) continue;
      const { error } = await svc.from("aero_fruit_measurements").update({
        avg_size_mm: d.average_fruit_size_mm ?? g.average_fruit_size_mm, fruit_count: d.count_fruit_measured ?? g.count_fruit_measured,
        size_dist: d.size_distribution ?? null, blemish_dist: d.blemish_distribution ?? null, colour_dist: d.color_distribution ?? null,
        sample_positions: d.sample_positions ?? null, synced_at: now,
      }).eq("orchard_id", g.orchard_id).eq("measurement_date", g.measurement_date);
      if (error) throw new Error("measurement detail: " + error.message);
    }
    stats.measurements = gradeList.length; stats.measurement_orchards = latestVisit.size; stats.measurements_new = todo.length;

    // 3. size forecasts (all weeks, avg size) + size split for the first week of each new run
    const fcRaw = await all("/truefruit/size/forecasts/?forecast_date__gte=2024-01-01");
    const fMap = new Map<string, any>();             // API repeats some rows — dedupe on the table key
    for (const f of fcRaw) fMap.set(f.orchard_id + "|" + f.processed_date + "|" + f.forecast_date, f);
    const fc = [...fMap.values()];
    const haveSplit = await readAll(() => svc.from("aero_size_forecasts").select("orchard_id,processed_date,forecast_date")
      .not("size_ranges", "is", null).order("orchard_id").order("processed_date").order("forecast_date"));
    const splitKey = new Set(haveSplit.map((h) => h.orchard_id + "|" + h.processed_date));
    await upsert("aero_size_forecasts", fc.map((f) => ({
      orchard_id: f.orchard_id, processed_date: f.processed_date, forecast_date: f.forecast_date,
      avg_size_mm: f.average_fruit_size_mm, synced_at: now,
    })), "orchard_id,processed_date,forecast_date");
    // latest run per orchard only — older runs keep their curve but not a split
    const latest = new Map<number, string>();
    for (const f of fc) if (!latest.has(f.orchard_id) || f.processed_date > latest.get(f.orchard_id)!) latest.set(f.orchard_id, f.processed_date);
    const firstWeek = new Map<string, string>();
    for (const f of fc) {
      if (latest.get(f.orchard_id) !== f.processed_date) continue;
      const k = f.orchard_id + "|" + f.processed_date;
      if (!firstWeek.has(k) || f.forecast_date < firstWeek.get(k)!) firstWeek.set(k, f.forecast_date);
    }
    const splitTodo = [...firstWeek.entries()].filter(([k]) => !splitKey.has(k));
    const splits = await pool(splitTodo, 6, ([k, d]) => get(`/truefruit/size/forecasts/${k.split("|")[0]}/${d}/`));
    for (let i = 0; i < splitTodo.length; i++) {
      const [k, d] = splitTodo[i]; const [oid, pd] = k.split("|"); const s = splits[i];
      if (!s?.size_ranges) continue;
      const { error } = await svc.from("aero_size_forecasts").update({ size_ranges: s.size_ranges })
        .eq("orchard_id", +oid).eq("processed_date", pd).eq("forecast_date", d);
      if (error) throw new Error("forecast split: " + error.message);
    }
    stats.forecasts = fc.length; stats.forecast_splits_new = splitTodo.length;

    // 4. re-link to Land Cloud blocks
    const { data: m, error: me } = await svc.rpc("aero_rematch");
    if (me) throw new Error("rematch: " + me.message);
    stats.links = m; stats.api_calls = calls;
    await svc.from("aero_sync_runs").delete().lt("started_at", new Date(Date.now() - 180 * 864e5).toISOString());

    await svc.from("aero_sync_runs").update({ finished_at: new Date().toISOString(), ok: true, stats }).eq("id", runId);
    return json({ ok: true, stats });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stats.api_calls = calls;
    await svc.from("aero_sync_runs").update({ finished_at: new Date().toISOString(), ok: false, stats, error: msg }).eq("id", runId);
    return json({ ok: false, error: msg, stats }, 500);
  }
});
