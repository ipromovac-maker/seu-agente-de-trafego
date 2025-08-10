// api/telegram.js
import { Telegraf } from "telegraf";
import { Redis as UpstashRedis } from "@upstash/redis";

// === ENV ===
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev-secret";
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",").map(s=>s.trim()).filter(Boolean);

// === Sessão: Upstash Redis (fallback memória) ===
let redis = null;
let mem = new Map();
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new UpstashRedis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}
const key = (chatId)=>`sessao:${chatId}`;
const getSession = async (chatId)=>{
  if (redis) return (await redis.get(key(chatId))) || {};
  return mem.get(chatId) || {};
};
const saveSession = async (chatId, data)=>{
  if (redis) return redis.set(key(chatId), data, { ex: 60*60*6 });
  mem.set(chatId, data);
};
const clearSession = async (chatId)=>{
  if (redis) return redis.del(key(chatId));
  mem.delete(chatId);
};

if (!BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");

// ── Parâmetros/Perfis (iguais ao que combinamos) ──
const DEFAULT_PARAMS = {
  "Meta":            { CTR_min: 0.01,  CPC_max: 1.50, ConvLP_min: 0.20, CPA_alvo: 10.0 },
  "Google Display":  { CTR_min: 0.007, CPC_max: 0.40, ConvLP_min: 0.10, CPA_alvo: 12.0 },
  "YouTube":         { CTR_min: 0.008, CPC_max: 0.30, ConvLP_min: 0.10, CPA_alvo: 12.0 },
  "Search":          { CTR_min: 0.03,  CPC_max: 1.20, ConvLP_min: 0.20, CPA_alvo: 15.0 },
};
const NICHO_PROFILES = {
  "B2C massivo":         { CTR_min: 1.20, CPC_max: 0.80, ConvLP_min: 1.10, CPA_alvo: 0.90 },
  "B2B high-ticket":     { CTR_min: 0.70, CPC_max: 1.50, ConvLP_min: 0.90, CPA_alvo: 1.80 },
  "Local/serviço":       { CTR_min: 0.90, CPC_max: 1.20, ConvLP_min: 1.00, CPA_alvo: 1.20 },
  "Infoproduto nichado": { CTR_min: 1.00, CPC_max: 1.00, ConvLP_min: 1.10, CPA_alvo: 1.00 },
};
const PLATAFORMAS = ["Meta","Google Display","YouTube","Search"];
const OBJETIVOS   = ["Aquecimento","Vendas"];
const PERFIS      = ["B2C massivo","B2B high-ticket","Local/serviço","Infoproduto nichado"];
const num = (s)=>{ if (s==null) return 0; const t=String(s).replace(/[€\s]/g,"").replace(",","."); const v=parseFloat(t); return isNaN(v)?0:v; };
const safeDiv = (a,b)=> b? a/b : 0;
const paramsAjustados = (plataforma, perfil)=>{
  const base = { ...(DEFAULT_PARAMS[plataforma] || DEFAULT_PARAMS["Meta"]) };
  const mult = NICHO_PROFILES[perfil];
  if (mult){ base.CTR_min*=mult.CTR_min; base.CPC_max*=mult.CPC_max; base.ConvLP_min*=mult.ConvLP_min; base.CPA_alvo*=mult.CPA_alvo; }
  return base;
};

const feynman = {
  CTR: (ctr,min)=>`Explicação: CTR é % de quem clica ao ver. Analogia: vitrine que faz (ou não) entrar. Checagem: ${(ctr*100).toFixed(2)}% vs meta ${(min*100).toFixed(2)}%.`,
  ConvLP: (vis, leads, conv, min)=>`Explicação: conversão da LP mostra se a página convence. Checagem: ${leads}/${vis} = ${(conv*100).toFixed(2)}% vs ${(min*100).toFixed(2)}%.`,
  CPA: (cpa,alvo)=>`Explicação: CPA/CPL é quanto paga por resultado. Checagem: €${cpa.toFixed(2)} vs alvo €${alvo.toFixed(2)}.`,
  Retencao: (r,meta)=>`Explicação: retenção é quanto do vídeo as pessoas assistem. Checagem: ${r}% vs meta ${meta}%.`,
};
const explicarPerfis = ()=>(
  "Escolha o tipo que mais parece com o seu negócio:\n\n" +
  "1) B2C massivo – vende para muitas pessoas diferentes.\nExemplo: roupas, comida, maquiagem.\n\n" +
  "2) B2B high-ticket – vende para empresas, preço alto.\nExemplo: software caro, consultoria para fábricas.\n\n" +
  "3) Local/serviço – atende só na sua cidade ou região.\nExemplo: salão, clínica, encanador.\n\n" +
  "4) Infoproduto nichado – ensina algo específico para um grupo pequeno.\nExemplo: curso para fotógrafos iniciantes."
);
const perguntaPlataforma = ()=>`Escolha a plataforma: ${PLATAFORMAS.join(" | ")}`;
const welcome = `Sou o *Seu Agente de Tráfego*. Vamos auditar sua campanha.\n\nObjetivo desta campanha? (Aquecimento ou Vendas)`;

// ── Fluxo ──
async function onText(ctx){
  const chatId = ctx.chat.id;
  if (ALLOWED_USER_IDS.length && !ALLOWED_USER_IDS.includes(String(ctx.from.id))) {
    return ctx.reply("Acesso restrito. Peça ao administrador para liberar seu ID.");
  }
  let s = await getSession(chatId);
  const text = (ctx.message.text || "").trim();

  if (text === "/start" || text === "/auditar"){
    s = { step: "objetivo" }; await saveSession(chatId,s);
    return ctx.replyWithMarkdown(welcome);
  }
  if (!s.step){ s.step="objetivo"; await saveSession(chatId,s); return ctx.replyWithMarkdown(welcome); }

  switch(s.step){
    case "objetivo": {
      const val = text.charAt(0).toUpperCase()+text.slice(1).toLowerCase();
      if (!OBJETIVOS.includes(val)) return ctx.reply("Responda: Aquecimento ou Vendas.");
      s.objetivo = val; s.step="perfil"; await saveSession(chatId,s);
      return ctx.reply(explicarPerfis());
    }
    case "perfil": {
      const mapa={"1":"B2C massivo","2":"B2B high-ticket","3":"Local/serviço","4":"Infoproduto nichado"};
      const val = mapa[text] || text;
      if (!PERFIS.includes(val)) return ctx.reply("Escolha 1,2,3,4 ou digite o nome do perfil.");
      s.perfil=val; s.step="publico"; await saveSession(chatId,s);
      return ctx.reply("Descreva seu *público-alvo* em 1 frase:", {parse_mode:"Markdown"});
    }
    case "publico": { s.publico=text; s.step="micro"; await saveSession(chatId,s); return ctx.reply("Descreva seu *micro-nicho* em 1 frase:", {parse_mode:"Markdown"}); }
    case "micro": { s.micro=text; s.step="plataforma"; await saveSession(chatId,s); return ctx.reply(perguntaPlataforma()); }
    case "plataforma": {
      if (!PLATAFORMAS.includes(text)) return ctx.reply(perguntaPlataforma());
      s.plataforma=text; s.step="orcamento"; await saveSession(chatId,s);
      return ctx.reply("Qual é o *orçamento diário*? (ex.: 50 ou €50)", {parse_mode:"Markdown"});
    }
    case "orcamento": {
      s.orcamento=num(text);
      s.step = s.objetivo==="Aquecimento" ? "alcance" : "impressoes";
      await saveSession(chatId,s);
      return ctx.reply(s.objetivo==="Aquecimento" ? "Quantas *pessoas únicas* foram alcançadas?" : "Quantas *impressões*?", {parse_mode:"Markdown"});
    }

    // Aquecimento
    case "alcance": { s.alcance=Math.round(num(text)); s.step="impressoes"; await saveSession(chatId,s); return ctx.reply("Quantas *impressões*?", {parse_mode:"Markdown"}); }
    case "impressoes": {
      s.impressoes=Math.round(num(text));
      s.step = s.objetivo==="Aquecimento" ? "views" : "cliques";
      await saveSession(chatId,s);
      return ctx.reply(s.objetivo==="Aquecimento" ? "Quantas *visualizações de vídeo* (ou interações)?" : "Quantos *cliques*?", {parse_mode:"Markdown"});
    }
    case "views": { s.views=Math.round(num(text)); s.step="custo"; await saveSession(chatId,s); return ctx.reply("Qual foi o *custo total*? (ex.: 12 ou €12)", {parse_mode:"Markdown"}); }
    case "custo": {
      s.custo=num(text);
      s.step = s.objetivo==="Aquecimento" ? "retencao" : "visitas";
      await saveSession(chatId,s);
      return ctx.reply(s.objetivo==="Aquecimento" ? "Qual a *retenção média do vídeo*? (em %)" : "Quantas *visitas na LP*?", {parse_mode:"Markdown"});
    }
    case "retencao": { s.retencao=num(text); await saveSession(chatId,s); await responderAquecimento(ctx,s); await clearSession(chatId); return; }

    // Vendas
    case "cliques": { s.cliques=Math.round(num(text)); s.step="custo"; await saveSession(chatId,s); return ctx.reply("Qual foi o *custo total*?", {parse_mode:"Markdown"}); }
    case "visitas": { s.visitas=Math.round(num(text)); s.step="leads"; await saveSession(chatId,s); return ctx.reply("Quantos *leads*?"); }
    case "leads": { s.leads=Math.round(num(text)); s.step="vendas"; await saveSession(chatId,s); return ctx.reply("Quantas *vendas*?"); }
    case "vendas": { s.vendas=Math.round(num(text)); s.step="receita"; await saveSession(chatId,s); return ctx.reply("Qual a *receita total*?", {parse_mode:"Markdown"}); }
    case "receita": { s.receita=num(text); await saveSession(chatId,s); await responderVendas(ctx,s); await clearSession(chatId); return; }
  }
}

// Respostas
async function responderAquecimento(ctx,s){
  const alcance=s.alcance||0, imp=s.impressoes||0, views=s.views||0, custo=s.custo||0, ret=s.retencao||0;
  const cpv=safeDiv(custo,views), freq=safeDiv(imp,alcance), metaRet=30;

  const out = [
    `*Diagnóstico – Aquecimento*`,
    `Objetivo: Aquecimento | Plataforma: ${s.plataforma} | Perfil: ${s.perfil}`,
    `Público-alvo: ${s.publico}`,
    `Micro-nicho: ${s.micro}`,
    `Alcance: ${alcance} | Impressões: ${imp} | Freq: ${freq.toFixed(2)}`,
    `Views: ${views} | Custo total: €${custo.toFixed(2)} | CPV: €${cpv.toFixed(4)}`,
    `Retenção média: ${ret}% (meta: ≥ ${metaRet}%)`,

    `\n*Agora*\n- ${ ret<metaRet
      ? "Regrave os 3–5s iniciais com promessa clara do micro-nicho; teste vídeo 15–20s e thumbnail com benefício direto."
      : "Conteúdo aprovado → escale +20% a cada 2 dias se o CPV se mantiver; crie variações de título/thumbnail."}`,

    `\n*Próximos testes*\n- 1 criativo focado em UMA dor do micro-nicho.\n- Lookalike/semelhante de quem assistiu ≥50%.\n- Segmentação por termos do nicho.`,

    `\n*Crie estes públicos*\n- YouTube/Google: listas “Assistiram ≥25% / ≥50% / ≥75%” (30/90/180d) e semelhantes de ≥50%.\n- Meta: públicos de vídeo (25/50/75%), engajamento do perfil e visitantes da LP; semelhantes de vídeo 50–75% e visitantes.`,

    `\n*Feynman*\n${feynman.Retencao(ret,metaRet)}\n\nChecagem: se dobrar o orçamento por 48h, o CPV e a retenção se mantêm?`,
  ].join("\n");

  await ctx.replyWithMarkdown(out);
}

async function responderVendas(ctx,s){
  const ref=paramsAjustados(s.plataforma,s.perfil);
  const imp=s.impressoes||0, cliques=s.cliques||0, custo=s.custo||0, vis=s.visitas||0, leads=s.leads||0, vendas=s.vendas||0, receita=s.receita||0;
  const ctr=safeDiv(cliques,imp), cpc=safeDiv(custo,cliques), convLP=safeDiv(leads,vis), cpa=safeDiv(custo, vendas||leads), roas=safeDiv(receita,custo);

  const acoes=[];
  if (ctr < ref.CTR_min){ acoes.push("CTR baixo → troque criativo/gancho; 2 variações novas."); acoes.push("Refine público (interesses do micro-nicho ou semelhantes)."); }
  else if (convLP < ref.ConvLP_min){ acoes.push("LP converte pouco → ajuste headline/CTA; adicione prova social; reduza campos."); }
  else if (cpa > 0 && cpa > ref.CPA_alvo){ acoes.push("CPA alto → trocar público/ajustar lances; Google: termos/negativas; Meta: interesses/lookalike."); }
  else if (cpa > 0 && cpa <= ref.CPA_alvo){ acoes.push("CPA dentro do alvo → escale +20–30%; duplique conjunto campeão."); }
  else { acoes.push("Dados insuficientes → colete 100 cliques ou 20 leads."); }

  const out = [
    `*Diagnóstico – Vendas*`,
    `Objetivo: Vendas | Plataforma: ${s.plataforma} | Perfil: ${s.perfil}`,
    `Público-alvo: ${s.publico}`,
    `Micro-nicho: ${s.micro}`,
    `CTR: ${(ctr*100).toFixed(2)}% | CPC: €${cpc.toFixed(2)} | Conv LP: ${(convLP*100).toFixed(2)}%`,
    `CPA: €${cpa.toFixed(2)} | ROAS: ${roas.toFixed(2)}`,

    `\n*Agora*\n- ${acoes.join("\n- ") || "Teste de orçamento controlado (+20% por 48h)"}`,

    `\n*Checklist*\n- Pixel/Tag ativos e conversões importadas (Lead/Purchase)\n- Exclusões: compradores e leads nas prospecções\n- LP rápida e com prova social do mesmo nicho`,

    `\n*Feynman*\n${[
      feynman.CTR(ctr,ref.CTR_min),
      feynman.ConvLP(vis,leads,convLP,ref.ConvLP_min),
      feynman.CPA(cpa,ref.CPA_alvo),
    ].join("\n\n")}\n\nChecagem: qual ponto do funil limita o resultado agora e por quê?`,
  ].join("\n");

  await ctx.replyWithMarkdown(out);
}

// ── Vercel handler (webhook) ──
export default async function handler(req, res){
  if (req.method === "GET") return res.status(200).send("ok");
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).send("unauthorized");

  const bot = new Telegraf(BOT_TOKEN, { webhookReply: false });
  bot.on("text", onText);
  bot.catch(err => console.error("Bot error:", err));

  try {
    await bot.handleUpdate(req.body);
    return res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    return res.status(500).send("ERROR");
  }
}
