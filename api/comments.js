// Comentários do Cronograma de Mudança — guardados no Upstash Redis (Vercel Storage)
const crypto = require("crypto");

// Encontra a conexão do Upstash, qualquer que seja o prefixo que o Vercel usou
function findRedis() {
  const env = process.env;
  const keys = Object.keys(env);
  const urlKey = keys.find((k) => /(^|_)(KV|UPSTASH_REDIS)_REST_API_URL$|UPSTASH_REDIS_REST_URL$/.test(k) && env[k]);
  const tokKey = keys.find((k) => /(^|_)(KV|UPSTASH_REDIS)_REST_API_TOKEN$|UPSTASH_REDIS_REST_TOKEN$/.test(k) && !/READ_ONLY/.test(k) && env[k]);
  if (urlKey && tokKey) return { url: env[urlKey], token: env[tokKey] };
  // alternativa: REDIS_URL / KV_URL no formato rediss://default:TOKEN@host:porta
  const rKey = keys.find((k) => /(^|_)(REDIS_URL|KV_URL)$/.test(k) && /^rediss?:\/\//.test(env[k] || ""));
  if (rKey) {
    try { const u = new URL(env[rKey]); if (u.password) return { url: "https://" + u.hostname, token: decodeURIComponent(u.password) }; } catch {}
  }
  return null;
}
const CONN = findRedis();
const REDIS_URL = CONN && CONN.url;
const REDIS_TOKEN = CONN && CONN.token;
const KEY = "mudanca:comentarios";
const STATUS_KEY = "mudanca:situacao";
const RATING_KEY = "mudanca:notas";
const STATUSES = ["visitar", "visitado", "favorito", "descartado"];
const TOTAL_APTS = 13;

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function readAll() {
  const raw = (await redis(["LRANGE", KEY, "0", "-1"])) || [];
  return raw.map((s) => { try { return { raw: s, c: JSON.parse(s) }; } catch { return null; } }).filter(Boolean);
}

function pairs(arr) { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; }

const publicView = ({ id, apt, name, text, ts }) => ({ id, apt, name, text, ts });

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: "O banco de dados não está conectado a este projeto no Vercel (Storage) ou o site não foi republicado depois de conectar." });
  }
  const pin = process.env.COMMENT_PIN || "";
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  try {
    if (req.method === "GET") {
      const all = await readAll();
      const status = pairs(await redis(["HGETALL", STATUS_KEY]));
      const ratings = Object.values(pairs(await redis(["HGETALL", RATING_KEY])))
        .map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
      return res.status(200).json({ comments: all.map((x) => publicView(x.c)).reverse(), status, ratings, pinRequired: !!pin });
    }

    if (req.method === "POST" && (body.kind === "status" || body.kind === "rating")) {
      const apt = Number(body.apt);
      if (!Number.isInteger(apt) || apt < 1 || apt > TOTAL_APTS) return res.status(400).json({ error: "Apartamento inválido." });
      if (pin && String(body.pin || "").trim() !== pin) return res.status(403).json({ error: "Código incorreto. Confira o código para comentar." });
      if (body.kind === "status") {
        const value = String(body.value || "");
        if (!STATUSES.includes(value)) return res.status(400).json({ error: "Situação inválida." });
        if (value === "visitar") await redis(["HDEL", STATUS_KEY, String(apt)]);
        else await redis(["HSET", STATUS_KEY, String(apt), value]);
        return res.status(200).json({ ok: true });
      }
      const name = String(body.name || "").trim().slice(0, 40);
      const stars = Number(body.stars);
      if (!name) return res.status(400).json({ error: "Escreva seu nome para dar nota." });
      if (!Number.isInteger(stars) || stars < 0 || stars > 5) return res.status(400).json({ error: "Nota inválida." });
      const field = apt + "|" + name.toLowerCase();
      if (stars === 0) await redis(["HDEL", RATING_KEY, field]);
      else await redis(["HSET", RATING_KEY, field, JSON.stringify({ apt, name, stars, ts: Date.now() })]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "POST") {
      const apt = Number(body.apt);
      const name = String(body.name || "").trim().slice(0, 40);
      const text = String(body.text || "").trim().slice(0, 1000);
      if (!Number.isInteger(apt) || apt < 1 || apt > TOTAL_APTS) return res.status(400).json({ error: "Apartamento inválido." });
      if (!name) return res.status(400).json({ error: "Escreva seu nome." });
      if (!text) return res.status(400).json({ error: "Escreva o comentário." });
      if (pin && String(body.pin || "").trim() !== pin) return res.status(403).json({ error: "Código para comentar incorreto." });

      const deleteKey = crypto.randomBytes(12).toString("hex");
      const comment = { id: Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), apt, name, text, ts: Date.now(), deleteKey };
      await redis(["LPUSH", KEY, JSON.stringify(comment)]);
      await redis(["LTRIM", KEY, "0", "1999"]);
      return res.status(201).json({ comment: publicView(comment), deleteKey });
    }

    if (req.method === "DELETE") {
      const id = String(req.query.id || "");
      const key = String(body.key || "");
      const all = await readAll();
      const found = all.find((x) => x.c.id === id);
      if (!found) return res.status(404).json({ error: "Comentário não encontrado." });
      if (!key || found.c.deleteKey !== key) return res.status(403).json({ error: "Só quem publicou pode apagar este comentário." });
      await redis(["LREM", KEY, "1", found.raw]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Método não permitido." });
  } catch (e) {
    return res.status(500).json({ error: "Erro ao acessar o banco de dados: " + (e && e.message ? e.message : "desconhecido") });
  }
};
