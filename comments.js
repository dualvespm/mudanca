// Comentários do Cronograma de Mudança — guardados no Upstash Redis (Vercel Storage)
const crypto = require("crypto");

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "mudanca:comentarios";
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

const publicView = ({ id, apt, name, text, ts }) => ({ id, apt, name, text, ts });

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: "O banco de dados ainda não foi conectado ao projeto no Vercel." });
  }
  const pin = process.env.COMMENT_PIN || "";
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  try {
    if (req.method === "GET") {
      const all = await readAll();
      return res.status(200).json({ comments: all.map((x) => publicView(x.c)).reverse(), pinRequired: !!pin });
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
    return res.status(500).json({ error: "Erro ao acessar o banco de dados. Tente de novo em instantes." });
  }
};
