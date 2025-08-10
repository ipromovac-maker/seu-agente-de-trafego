// ─────────────────────────────────────────────────────────────
// Seu Agente de Tráfego – Vercel (Webhook Telegram)
// Node 18 + Telegraf + Upstash Redis (KV)
// Modos: Aquecimento e Vendas, com explicações estilo Feynman
// ─────────────────────────────────────────────────────────────

import { Telegraf } from "telegraf";
import { Redis } from "@upstash/redis";

// ENV obrigatórias (adicione em Vercel > Settings > Environment Variables)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // string aleatória (pra URL)
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN) throw new Error("Defina TELEGRAM_BOT_TOKEN nas variáveis de ambiente");
if (!WEBHOOK_SECRET) throw new Error("Defina WEBHOOK_SECRET nas variáveis de ambiente");

// Redis (Upstash) para guardar estado da conversa
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Parâmetros base por plataforma
const DEFAULT_PARAMS = {
  "Meta":            { CTR_min: 0.01,  CPC_max: 1.50, ConvLP_min: 0.20, CPA_alvo: 10.0 },
  "Google Display":  { CTR_min: 0.007, CPC_max: 0.40, ConvLP_min: 0.10, CPA_alvo: 12.0 },
  "YouTube":         { CTR_min: 0.008, CPC_max: 0.30, ConvLP_min: 0.10, CPA_alvo: 12.0 },
  "Search":          { CTR_min: 0.03,  CPC_max: 1.20, ConvLP_min: 0.20, CPA_alvo: 15.0 },
};

// Ajustes por perfil de nicho
const NICHO_PROFILES = {
  "B2C massivo":         { CTR_min: 1.20, CPC_max: 0.80, ConvLP_min: 1.10, CPA_alvo: 0.90 },
  "B2B high-ticket":     { CTR_min: 0.70, CPC_max: 1.50, ConvLP_min: 0.90, CPA_alvo: 1.80 },
  "Local/serviço":       { CTR_min: 0.90, CPC_max: 1.20, ConvLP_min: 1.00, CPA_alvo: 1.20 },
  "Infoproduto nichado": { CTR_min: 1.00, CPC_max: 1.00, ConvLP_min: 1.10, CPA_alvo: 1.00 },
};

const PLATAFORMAS = ["Meta","Google Display","YouTube","Search"];
const OBJETIVOS   = ["Aquecimento","Vendas"];
const PERFIS      = ["B2C massivo","B2B high-ticket","Local/serviço","Infoproduto nichado"];

// Utilidades
const key = (chatId) => `sessao:${chatId}`;
const getSession  = async (chatId) => (await redis.get(key(chatId))) || {};
const saveSession = async (chatId, data) => { await redis.set(key(chatId), data, { ex: 60 * 60 * 6 }); };
const clearSession= async (chatId) => { await redis.del(key(chatId)); };

const num = (s) => {
  if (s == null) return 0;
  const t = String(s).replace(/[€\s]/g, "").replace(",", ".");
  const v = parseFloat(t);
  return isNaN(v) ? 0 : v;
};
const safeDiv = (a, b) => (b ? a / b : 0);

const paramsAjustados = (plataforma, perfil) => {
  const base = { ...(DEFAULT_PARAMS[plataforma] || DEFAULT_PARAMS["Meta"]) };
  const mult = NICHO_PROFILES[perfil];
  if (mult) {
    base.CTR_min    *= mult.CTR_min;
    base.CPC_max    *= mult.CPC_max;
    base.ConvLP_min *= mult.ConvLP_min;
    base.CPA_alvo   *= mult.CPA_alvo;
  }
  return base;
};

// Explicações estilo Feynman
const feynman = {
  CTR: (ctr, min) =>
    `Explicação simples: CTR é a taxa de pessoas que clicam quando veem seu anúncio. Se está baixo, o anúncio não chama atenção.
Analogia: é uma vitrine que não faz ninguém entrar.
Checagem: ${(ctr*100).toFixed(2)}% é menor que a meta de ${(min*100).toFixed(2)}%?`,
  ConvLP: (visitas, leads, conv, min) =>
    `Explicação simples: Conversão da LP mostra se quem chegou na página virou lead/compra.
Analogia: a vitrine chamou, mas o vendedor (sua página) não convenceu.
Checagem: ${leads}/${visitas} = ${(conv*100).toFixed(2)}%. A meta é ${(min*100).toFixed(2)}%.`,
  CPA: (cpa, alvo) =>
    `Explicação simples: CPA/CPL é quanto você paga por cada resultado.
Analogia: é o custo por cada cliente que sai da loja com uma sacola.
Checagem: €${cpa.toFixed(2)} está acima da meta de €${alvo.toFixed(2)}?`,
  Retencao: (ret, meta) =>
    `Explicação simples: retenção é quanto do vídeo as pessoas assistem.
Analogia: é como uma história que prende até o fim.
Checagem: ${ret}% está acima da meta de ${meta}%?`,
};

const explicarPerfis = () =>
  "Escolha o tipo que mais parece com o seu negócio:\n\n" +
  "1) B2C massivo – vende para muitas pessoas diferentes.\nExemplo: roupas, comida, maquiagem.\n\n" +
  "2) B2B high-ticket – vende para empresas, preço alto.\nExemplo: software caro, consultoria para fábricas.\n\n" +
  "3) Local/serviço – atende só na sua cidade ou região.\nExemplo: salão de beleza, clínica, pintor, encanador.\n\n" +
  "4) Infoproduto nichado – ensina algo específico para um grupo pequeno.\nExemplo: curso para fotógrafos iniciantes, programa de emagrecimento para mães após o parto.";

const perguntaPlataforma = () => `Escolha a plataforma: ${PLATAFORMAS.join(" | ")}`;
const welcome = `Sou o *Seu Agente de Tráfego*. Vamos auditar sua campanha.

Objetivo desta campanha? (Aquecimento ou Vendas)`;

// Handler principal de mensagens de texto
async function onText(ctx) {
  const chatId = ctx.chat.id;

  // Acesso restrito opcional
  if (ALLOWED_USER_IDS.length && !ALLOWED_USER_IDS.includes(String(ctx.from.id))) {
    return ctx.reply("Acesso restrito. Peça ao administrador para liberar seu ID.");
  }

  let s = await getSession(chatId);
  const text = (ctx.message.text || "").trim();

  // Comandos
  if (text === "/start" || text === "/auditar") {
    s = { step: "objetivo" };
    await saveSession(chatId, s);
    return ctx.replyWithMarkdown(welcome);
  }

  if (!s.step) {
    s.step = "objetivo"; await saveSession(chatId, s);
    return ctx.replyWithMarkdown(welcome);
  }

  // Fluxo
  switch (s.step) {
    case "objetivo": {
      const val = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
      if (!OBJETIVOS.includes(val)) return ctx.reply("Responda: Aquecimento ou Vendas.");
      s.objetivo = val;
      s.step = "perfil"; await saveSession(chatId, s);
      return ctx.reply(explicarPerfis());
    }
    case "perfil": {
      const mapa = { "1":"B2C massivo", "2":"B2B high-ticket", "3":"Local/serviço", "4":"Infoproduto nichado" };
      const val = mapa[text] || text;
      if (!PERFIS.includes(val)) return ctx.reply("Escolha 1, 2, 3, 4 ou digite o nome do perfil.");
      s.perfil = val;
      s.step = "publico"; await saveSession(chatId, s);
      return ctx.reply("Descreva seu *público-alvo* em 1 frase:", { parse_mode: "Markdown" });
    }
    case "publico": {
      s.publico = text; s.step = "micro"; await saveSession(chatId, s);
      return ctx.reply("Descreva seu *micro-nicho* em 1 frase:", { parse_mode: "Markdown" });
    }
    case "micro": {
      s.micro = text; s.step = "plataforma"; await saveSession(chatId, s);
      return ctx.reply(perguntaPlataforma());
    }
    case "plataforma": {
      if (!PLATAFORMAS.includes(text)) return ctx.reply(perguntaPlataforma());
      s.plataforma = text; s.step = "orcamento"; await saveSession(chatId, s);
      return ctx.reply("Qual é o *orçamento diário*? (ex.: 50 ou €50)", { parse_mode: "Markdown" });
    }
    case "orcamento": {
      s.orcamento = num(text);
      if (s.objetivo === "Aquecimento") { s.step = "alcance"; }
      else { s.step = "impressoes"; }
      await saveSession(chatId, s);
      return ctx.reply(
        s.objetivo === "Aquecimento" ? "Quantas *pessoas únicas* foram alcançadas?" : "Quantas *impressões*?",
        { parse_mode: "Markdown" }
      );
    }

    // Modo Aquecimento
    case "alcance": {
      s.alcance = Math.round(num(text));
      s.step = "impressoes"; await saveSession(chatId, s);
      return ctx.reply("Quantas *impressões*?", { parse_mode: "Markdown" });
    }
    case "impressoes": {
      s.impressoes = Math.round(num(text));
      if (s.objetivo === "Aquecimento") { s.step = "views"; } else { s.step = "cliques"; }
      await saveSession(chatId, s);
      return ctx.reply(
        s.objetivo === "Aquecimento" ? "Quantas *visualizações de vídeo* (ou interações)?" : "Quantos *cliques*?",
        { parse_mode: "Markdown" }
      );
    }
    case "views": {
      s.views = Math.round(num(text));
      s.step = "custo"; await saveSession(chatId, s);
      return ctx.reply("Qual foi o *custo total*? (ex.: 12 ou €12)", { parse_mode: "Markdown" });
    }
    case "custo": {
      s.custo = num(text);
      if (s.objetivo === "Aquecimento") { s.step = "retencao"; } else { s.step = "visitas"; }
      await saveSession(chatId, s);
      return ctx.reply(
        s.objetivo === "Aquecimento" ? "Qual a *retenção média do vídeo*? (em %)" : "Quantas *visitas na LP*?",
        { parse_mode: "Markdown" }
      );
    }
    case "retencao": {
      s.retencao = num(text);
      await saveSession(chatId, s);
      await responderAquecimento(ctx, s);
      await clearSession(chatId);
      return;
    }

    // Modo Vendas
    case "cliques": {
      s.cliques = Math.round(num(text));
      s.step = "custo"; await saveSession(chatId, s);
      return ctx.reply("Qual foi o *custo total*?", { parse_mode: "Markdown" });
    }
    case "visitas": {
      s.visitas = Math.round(num(text));
      s.step = "leads"; await saveSession(chatId, s);
      return ctx.reply("Quantos *leads*?");
    }
    case "leads": {
      s.leads = Math.round(num(text));
      s.step = "vendas"; await saveSession(chatId, s);
      return ctx.reply("Quantas *vendas*?");
    }
    case "vendas": {
      s.vendas = Math.round(num(text));
      s.step = "receita"; await saveSession(chatId, s);
      return ctx.reply("Qual a *receita total*?", { parse_mode: "Markdown" });
    }
    case "receita": {
      s.receita = num(text);
      await saveSession(chatId, s);
      await responderVendas(ctx, s);
      await clearSession(chatId);
      return;
    }
  }
}

// Resposta — Aquecimento
async function responderAquecimento(ctx, s) {
  // metas ajustadas (se quiser usar no futuro)
  paramsAjustados(s.plataforma, s.perfil);

  const alcance = s.alcance || 0;
  const imp = s.impressoes || 0;
  const views = s.views || 0;
  const custo = s.custo || 0;
  const ret = s.retencao || 0;

  const cpv = safeDiv(custo, views); // custo por view
  const freq = safeDiv(imp, alcance);
  const metaRet = 30; // retenção alvo p/ aquecimento (%)

  const linhas = [];
  linhas.push(`*Diagnóstico – Aquecimento*`);
  linhas.push(`Objetivo: Aquecimento | Plataforma: ${s.plataforma} | Perfil: ${s.perfil}`);
  linhas.push(`Público-alvo: ${s.publico}`);
  linhas.push(`Micro-nicho: ${s.micro}`);
  linhas.push(`Alcance: ${alcance} | Impressões: ${imp} | Freq: ${freq.toFixed(2)}`);
  linhas.push(`Views: ${views} | Custo total: €${custo.toFixed(2)} | CPV: €${cpv.toFixed(4)}`);
  linhas.push(`Retenção média: ${ret}% (meta: ≥ ${metaRet}%)`);

  const acoes = [];
  if (ret < metaRet) {
    acoes.push("Retenção baixa → regrave o início (3–5s) com promessa clara do micro-nicho.");
    acoes.push("Teste vídeo 15–20s e thumbnail com benefício direto.");
  } else {
    acoes.push("Conteúdo aprovado → escale +20% a cada 2 dias se CPV se mantiver.");
    acoes.push("Crie variações de título/thumbnail para alcançar públicos novos.");
  }

  const testes = [
    "1 criativo focado em UMA dor específica do micro-nicho.",
    "Lookalike/semelhante de quem assistiu ≥50%.",
    "Segmentação por termos do nicho (‘trabalhar com faxina’, ‘ganhar dinheiro com limpeza’).",
  ];

  const checklist = [
    "Tag Google e Pixel Meta ativos; eventos básicos recebendo.",
    "Consent Mode / LGPD ativo.",
    "Landing de valor carregando rápido (<=2s).",
  ];

  const publicos = [
    "YouTube/Google: listas ‘Assistiram ≥25%’, ‘≥50%’, ‘≥75%’ (30/90/180 dias).",
    "YouTube/Google: semelhantes baseados em ‘≥50%’.",
    "Meta: públicos de vídeo (25/50/75%), engajamento de perfil, visitantes da LP.",
    "Meta: semelhantes de vídeo 50–75% e de visitantes da LP.",
  ];

  const out = [
    linhas.join("\n"),
    "\n*Agora*\n- " + acoes.join("\n- "),
    "\n*Próximos testes*\n- " + testes.join("\n- "),
    "\n*Checklist*\n- " + checklist.join("\n- "),
    "\n*Crie estes públicos*\n- " + publicos.join("\n- "),
    "\n*Feynman*\n" + feynman.Retencao(ret, metaRet) + "\n\nChecagem: se dobrar o orçamento por 48h, o CPV e a retenção se mantêm?",
  ].join("\n\n");

  await ctx.replyWithMarkdown(out);
}

// Resposta — Vendas
async function responderVendas(ctx, s) {
  const ref = paramsAjustados(s.plataforma, s.perfil);

  const imp = s.impressoes || 0;
  const cliques = s.cliques || 0;
  const custo = s.custo || 0;
  const visitas = s.visitas || 0;
  const leads = s.leads || 0;
  const vendas = s.vendas || 0;
  const receita = s.receita || 0;

  const ctr = safeDiv(cliques, imp);
  const cpc = safeDiv(custo, cliques);
  const convLP = safeDiv(leads, visitas);
  const cpa = safeDiv(custo, vendas || leads);
  const roas = safeDiv(receita, custo);

  const linhas = [];
  linhas.push(`*Diagnóstico – Vendas*`);
  linhas.push(`Objetivo: Vendas | Plataforma: ${s.plataforma} | Perfil: ${s.perfil}`);
  linhas.push(`Público-alvo: ${s.publico}`);
  linhas.push(`Micro-nicho: ${s.micro}`);
  linhas.push(`CTR: ${(ctr*100).toFixed(2)}% | CPC: €${cpc.toFixed(2)} | Conv LP: ${(convLP*100).toFixed(2)}%`);
  linhas.push(`CPA: €${cpa.toFixed(2)} | ROAS: ${roas.toFixed(2)}`);

  const acoes = [];
  const testes = [];
  const check = [
    "Pixel/Tag ativos e conversões importadas (Lead/Purchase)",
    "Exclusões: compradores e leads nas campanhas de prospecção",
    "LP rápida e com prova social do mesmo nicho",
  ];

  if (ctr < ref.CTR_min) {
    acoes.push("CTR baixo → troque criativo/gancho; 2 variações novas.");
    acoes.push("Refine público: interesses específicos do micro-nicho ou semelhantes.");
    testes.push("Criativo focado em UMA dor (título e visual alinhados).");
  } else if (convLP < ref.ConvLP_min) {
    acoes.push("Conversão da LP baixa → ajuste headline/CTA com a dor do micro-nicho.");
    acoes.push("Inclua prova social e reduza fricção (menos campos).");
    testes.push("A/B de headline e CTA.");
  } else if (cpa > 0 && cpa > ref.CPA_alvo) {
    acoes.push("CPA acima do alvo → trocar público/ajustar lances.");
    acoes.push("Google: refinar termos/negativas; Meta: interesses/lookalike.");
    testes.push("Novo público semelhante ao melhor conjunto (1–3%).");
  } else if (cpa > 0 && cpa <= ref.CPA_alvo) {
    acoes.push("CPA dentro do alvo → escale +20–30%. Duplique conjunto campeão.");
    testes.push("Criativo variação curta mantendo estrutura campeã.");
  } else {
    acoes.push("Dados insuficientes → colete 100 cliques ou 20 leads.");
  }

  const out = [
    linhas.join("\n"),
    "\n*Agora*\n- " + acoes.join("\n- "),
    "\n*Próximos testes*\n- " + (testes.length ? testes.join("\n- ") : "Teste de orçamento controlado (+20% por 48h)"),
    "\n*Checklist*\n- " + check.join("\n- "),
    "\n*Feynman*\n" + [
      feynman.CTR(ctr, ref.CTR_min),
      feynman.ConvLP(visitas, leads, convLP, ref.ConvLP_min),
      feynman.CPA(cpa, ref.CPA_alvo),
    ].join("\n\n") + "\n\nChecagem: qual ponto do funil está limitando o resultado agora e por quê?",
  ].join("\n\n");

  await ctx.replyWithMarkdown(out);
}

// ── Vercel handler (webhook) ─────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).send("ok");
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).send("unauthorized");

  const bot = new Telegraf(BOT_TOKEN, { webhookReply: false });
  bot.on("text", onText);
  bot.catch((err) => console.error("Bot error:", err));

  try {
    await bot.handleUpdate(req.body);
    return res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    return res.status(500).send("ERROR");
  }
}
