// Hitman Absolution contracts - sharing hub for Cloudflare Workers + D1.
// Same job as hub.py, but contracts are kept in a Cloudflare database, so they are never wiped.
// Version 2: also keeps scores (leaderboard) and star ratings.
// Needs a D1 database bound to this Worker with the variable name DB.

const FIELDS = ["_id", "DisplayId", "LevelIndex", "CheckpointIndex", "Difficulty", "ExitId", "UserId",
  "UserName", "Likes", "Dislikes", "Plays", "UserScore", "Title", "Description",
  "CompetitionHighestScore", "HighestScoringFriendName", "HighestScoringFriendScore",
  "StartingWeaponToken", "StartingOutfitToken", "Targets", "Restrictions"];
const NUMERIC = new Set(["LevelIndex", "CheckpointIndex", "Difficulty", "ExitId", "Likes", "Dislikes",
  "Plays", "UserScore", "CompetitionHighestScore", "HighestScoringFriendScore",
  "StartingWeaponToken", "StartingOutfitToken"]);
const LIMITS = { Description: 1500, Targets: 4000, Restrictions: 2000 };
const PAGE = 1000;
const MAX_CONTRACTS = 20000;
const POSTS_PER_MINUTE = 60;

const ID_RE = /^[0-9a-f]{40}$/;
const STEAM_RE = /^\d{1,20}$/;
let summaryCache = null;
let summaryAt = 0;
const hits = new Map();
let hubId = null;

function clean(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const out = {};
  for (const k of FIELDS) {
    let v = rec[k];
    if (typeof v === "number") v = String(v);
    if (typeof v !== "string" || v.length > (LIMITS[k] || 200)) return null;
    if (NUMERIC.has(k) && !/^-?\d{1,12}$/.test(v)) return null;
    out[k] = v;
  }
  if (!/^[0-9a-f]{40}$/.test(out._id)) return null;
  for (const k of ["Targets", "Restrictions"]) {
    try { JSON.parse(out[k]); } catch (e) { return null; }
  }
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function getHubId(db) {
  if (hubId) return hubId;
  await db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('hub_id', ?)")
    .bind(crypto.randomUUID().replace(/-/g, "")).run();
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'hub_id'").first();
  hubId = row.value;
  return hubId;
}

function allowed(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= POSTS_PER_MINUTE) return false;
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

export default {
  async fetch(request, env) {
    const db = env.DB;
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/contracts") {
      const since = parseFloat(url.searchParams.get("since") || "0") || 0;
      const { results } = await db
        .prepare("SELECT data, created FROM contracts WHERE created > ? ORDER BY created ASC LIMIT ?")
        .bind(since, PAGE + 1).all();
      const page = results.slice(0, PAGE);
      const now = results.length > PAGE ? page[page.length - 1].created : Date.now() / 1000;
      return json({
        hub_id: await getHubId(db),
        now,
        contracts: page.map((r) => Object.assign(JSON.parse(r.data), { Created: r.created })),
      });
    }

    if (request.method === "POST" && url.pathname === "/contracts") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!allowed(ip)) return json({ ok: false, error: "slow down" }, 429);
      const text = await request.text();
      if (text.length === 0 || text.length > 20000) return json({ ok: false, error: "bad size" }, 400);
      let rec;
      try { rec = JSON.parse(text); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
      const c = clean(rec);
      if (!c) return json({ ok: false, error: "invalid contract" }, 400);
      const n = await db.prepare("SELECT COUNT(*) AS n FROM contracts").first();
      if (n.n < MAX_CONTRACTS) {
        await db.prepare("INSERT OR IGNORE INTO contracts (id, created, data) VALUES (?, ?, ?)")
          .bind(c._id, Date.now() / 1000, JSON.stringify(c)).run();
      }
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/scores") {
      const cid = url.searchParams.get("contract") || "";
      if (!ID_RE.test(cid)) return json({ ok: false, error: "invalid" }, 400);
      const { results } = await db
        .prepare("SELECT user_id, user_name, score FROM scores WHERE contract_id = ? ORDER BY score DESC LIMIT 50")
        .bind(cid).all();
      return json({ scores: results });
    }

    if (request.method === "GET" && url.pathname === "/myratings") {
      const user = url.searchParams.get("user") || "";
      if (!STEAM_RE.test(user)) return json({ ok: false, error: "invalid" }, 400);
      const { results } = await db.prepare("SELECT contract_id, stars FROM ratings WHERE user_id = ?").bind(user).all();
      const ratings = {};
      for (const r of results) ratings[r.contract_id] = r.stars;
      return json({ ratings });
    }

    if (request.method === "GET" && url.pathname === "/summary") {
      if (!summaryCache || Date.now() - summaryAt > 60000) {
        const rt = await db.prepare("SELECT contract_id, AVG(stars) AS avg, COUNT(*) AS votes FROM ratings GROUP BY contract_id").all();
        const sc = await db.prepare("SELECT contract_id, COUNT(*) AS players, MAX(score) AS best FROM scores GROUP BY contract_id").all();
        const out = {};
        for (const x of rt.results) out[x.contract_id] = { stars: Math.round(x.avg * 10) / 10, votes: x.votes, players: 0, best: 0 };
        for (const x of sc.results) {
          out[x.contract_id] = Object.assign(out[x.contract_id] || { stars: 0, votes: 0 }, { players: x.players, best: x.best });
        }
        summaryCache = out;
        summaryAt = Date.now();
      }
      return json({ summary: summaryCache });
    }

    if (request.method === "POST" && (url.pathname === "/scores" || url.pathname === "/rate")) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!allowed(ip)) return json({ ok: false, error: "slow down" }, 429);
      const text = await request.text();
      if (!text || text.length > 2000) return json({ ok: false, error: "bad size" }, 400);
      let b;
      try { b = JSON.parse(text); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
      if (!b || typeof b !== "object" || !ID_RE.test(String(b.contract_id || "")) || !STEAM_RE.test(String(b.user_id || ""))) {
        return json({ ok: false, error: "invalid" }, 400);
      }
      const user = String(b.user_id);
      const row = await db.prepare("SELECT json_extract(data, '$.UserId') AS owner FROM contracts WHERE id = ?").bind(b.contract_id).first();
      if (!row) return json({ ok: false, error: "unknown contract" }, 404);
      const now = Date.now() / 1000;
      if (url.pathname === "/scores") {
        const score = Number(b.score);
        if (!Number.isInteger(score) || Math.abs(score) > 1000000000) return json({ ok: false, error: "invalid score" }, 400);
        const name = String(b.user_name || user).slice(0, 64);
        await db.prepare("INSERT INTO scores (contract_id, user_id, user_name, score, updated) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(contract_id, user_id) DO UPDATE SET score = MAX(score, excluded.score), user_name = excluded.user_name, updated = excluded.updated")
          .bind(b.contract_id, user, name, score, now).run();
      } else {
        const stars = Number(b.stars);
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json({ ok: false, error: "invalid stars" }, 400);
        if (row.owner === user) return json({ ok: false, error: "own contract" }, 400);
        await db.prepare("INSERT INTO ratings (contract_id, user_id, stars, updated) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(contract_id, user_id) DO UPDATE SET stars = excluded.stars, updated = excluded.updated")
          .bind(b.contract_id, user, stars, now).run();
      }
      summaryAt = 0;
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/") {
      const n = await db.prepare("SELECT COUNT(*) AS n FROM contracts").first();
      return json({ status: "Hitman Absolution contracts hub", contracts: n.n });
    }
    return json({ ok: false }, 404);
  },
};
