// ==UserScript==
// @name         WarEra Empresas HUD
// @namespace    local.warera.empresas-hud
// @version      0.11.4
// @description  Dados económicos DENTRO dos cartões das empresas (glance-first): profit/dia, tendência, previsão ☀️/⛈️, inventário, ⚙️ payback de subir o motor; ordenado/dia no cartão do patrão. Read-only.
// @match        https://app.warera.io/*
// @connect      api2.warera.io
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/veryolab/warera-userscripts/main/WarEraEmpresasHUD.user.js
// @downloadURL  https://raw.githubusercontent.com/veryolab/warera-userscripts/main/WarEraEmpresasHUD.user.js
// ==/UserScript==

/*
  Filosofia: MENOR FRICÇÃO — a informação vive nos próprios cartões do jogo, legível num glance.
  O painel flutuante é só um mini-pill com o mercado (sparklines) — minimizado por defeito.
  Read-only: só lê a API com a tua sessão. Moeda = ícone SVG do jogo (não "$").
  Histórico de preços: 100% localStorage (amostra a cada 30 min com o jogo aberto).
*/
(() => {
  "use strict";

  // o jogo faz failover entre vários hosts de API (visto na consola: api3→api5→api4);
  // fazemos o mesmo: em erro de REDE/5xx tentamos o host seguinte e fixamos o que funcionar
  const HOSTS = ["https://api2.warera.io", "https://api3.warera.io", "https://api4.warera.io", "https://api5.warera.io"];
  const LS = { hist: "weh.hist", cfg: "weh.cfg", geo: "weh.geo", ui: "weh.ui", mkt: "weh.mkt" };
  const REFRESH_MS = 10 * 60 * 1000;   // ciclo de dados (API gentil)
  const SAMPLE_MS = 30 * 60 * 1000;    // amostragem de preços p/ histórico
  const HIST_MAX = 480;                // ~10 dias a 30 min
  const DOM_MS = 5 * 1000;             // re-aplicar chips (SPA re-render)

  // ícone de moeda do próprio jogo (currentColor → herda o dourado)
  const COIN = `<svg class="weh-coin" stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 5C7.031 5 2 6.546 2 9.5S7.031 14 12 14c4.97 0 10-1.546 10-4.5S16.97 5 12 5zm-5 9.938v3c1.237.299 2.605.482 4 .541v-3a21.166 21.166 0 0 1-4-.541zm6 .54v3a20.994 20.994 0 0 0 4-.541v-3a20.994 20.994 0 0 1-4 .541zm6-1.181v3c1.801-.755 3-1.857 3-3.297v-3c0 1.44-1.199 2.542-3 3.297zm-14 3v-3C3.2 13.542 2 12.439 2 11v3c0 1.439 1.2 2.542 3 3.297z"></path></svg>`;

  // ---------- API de sessão (padrão do CraftAdvisor) ----------
  const readCookie = (name) => {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  };
  let hostI = 0;
  async function trpc(path, input) {
    const qs = `?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
    let lastErr;
    for (let t = 0; t < HOSTS.length; t++) {
      const i = (hostI + t) % HOSTS.length;
      try {
        const res = await fetch(`${HOSTS[i]}/trpc/${path}${qs}`, {
          method: "GET", credentials: "include",
          headers: { "x-vid": readCookie("vid") || "", "x-gr": readCookie("gr") || "" },
        });
        if (res.status >= 500) throw new Error(`${path}: HTTP ${res.status}`); // servidor em baixo → roda
        hostI = i; // host bom: fica para os próximos pedidos
        if (!res.ok) throw { final: new Error(`${path}: HTTP ${res.status}`) }; // 4xx = erro nosso, não rodar
        const body = await res.json();
        if (body && body.error) throw { final: new Error(body.error.message || path) };
        return body && body.result ? body.result.data : body;
      } catch (e) {
        if (e && e.final) throw e.final;
        lastErr = e; // erro de rede/CORS/5xx → tenta o próximo host
      }
    }
    throw lastErr || new Error(path);
  }

  // ---------- storage ----------
  const load = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ---------- estado ----------
  const S = {
    userId: null, energyRegen: 0,
    cfg: null,                 // {items, engineLevels} (enxuto, cache 24h)
    geo: null,                 // {taxByCountry, regions} (cache 24h)
    prices: {}, inv: {},
    mine: [],                  // [{id,name,itemCode,profitDay,marginPP,stock,cap,region,w}]
    boss: null,                // {…, wage, worksDay, wageDay}
    hist: load(LS.hist, []),
    err: null, at: 0,
  };

  // ---------- econ (mini-port do econ.js do bot) ----------
  function trimConfig(cfg) {
    const items = {};
    for (const [code, it] of Object.entries(cfg.items || {}))
      items[code] = { pp: it.productionPoints, needs: it.productionNeeds || null };
    // NB: levels é um OBJETO {"1":{...},"2":{...}}, não array
    const engineLevels = {}, engineCost = {};
    for (const [lvl, l] of Object.entries(cfg.upgradesConfig?.automatedEngine?.levels || {})) {
      engineLevels[lvl] = l?.stats?.dailyProd ?? 0;
      // custo p/ CHEGAR a este nível = QUANTIDADE de AÇO (steel), e mais nada (verificado no jogo 2026-07-05).
      // ⚠ a config traz também "constructionPointsCost", mas o jogo NÃO cobra pontos de construção — só aço.
      engineCost[lvl] = l?.steelCost ?? 0;
    }
    return { items, engineLevels, engineCost, ecv: 2, moveCost: cfg.company?.moveCost ?? 5, at: Date.now() };
  }
  const depositMult = (region, itemCode) => {
    const d = region?.deposit;
    return d && d.type === itemCode && new Date(d.endsAt) > Date.now() ? 1 + (d.bonusPercent || 0) / 100 : 1;
  };
  // bónus de produção total do país para um item = recursos estratégicos (0–26%)
  // + ESPECIALIZAÇÃO: +30% se country.specializedItem === item (visto no popup "Mover empresa" do jogo)
  const SPEC_BONUS = 30;
  const prodPctFor = (ci, code) => (ci?.prod || 0) + (ci?.spec === code ? SPEC_BONUS : 0);
  const ENERGY_PER_WORK = 10; // gameConfig.user.energyCostPerAction

  // margem/pp: depósito da região + bónus de produção do país (estratégico + especialização).
  // SEM imposto: confirmado pelo utilizador (2026-07-04) — produção e self-work não pagam imposto;
  // taxes={income,market,selfWork} do país só se aplicam ao trabalho de WORKER (income).
  function marginPerPP(code, region, prodPct) {
    const it = S.cfg.items[code];
    if (!it || !it.pp) return 0;
    let inputs = 0;
    for (const [m, q] of Object.entries(it.needs || {})) inputs += (S.prices[m] || 0) * q;
    const net = (S.prices[code] || 0) - inputs;
    return (net / it.pp) * depositMult(region, code) * (1 + (prodPct || 0) / 100);
  }

  // payback de subir o MOTOR (automatedEngine) 1 nível.
  // Custo REAL (verificado no jogo 2026-07-05): SÓ aço, nada mais — a config traz também
  // "constructionPointsCost" mas o jogo não o cobra. Custo em $ = qtd_aço × preço_aço.
  // Ganho = +pp/dia extra × margem/pp (a mesma métrica).
  const ENGINE_MAT = "steel";
  function engineUpgrade(c, mpp) {
    const cur = c.activeUpgradeLevels?.automatedEngine ?? 1;
    const nextDp = S.cfg.engineLevels[cur + 1], qty = S.cfg.engineCost?.[cur + 1];
    if (nextDp == null || qty == null) return null;   // já no nível máximo (L7)
    const price = S.prices[ENGINE_MAT] || 0;
    if (!price) return null;                          // sem preço do aço não dá p/ custear
    const extraPP = nextDp - (S.cfg.engineLevels[cur] ?? 0);
    const gainDay = extraPP * mpp;                    // valor/dia extra QUANDO ativa
    const money = qty * price;
    return { cur, next: cur + 1, extraPP, qty, gainDay, cost: money, days: gainDay > 0 ? money / gainDay : Infinity };
  }

  // ---------- mercado de trabalho (ofertas reais, não o div do jogo) ----------
  // A API ordena por salário BRUTO decrescente MAS as ofertas de topo têm requisitos
  // (minLevel/citizenship/minProduction) que um worker normal NÃO cumpre — o jogo filtra-as.
  // Por isso: leio ~6 páginas e filtro às ofertas ACESSÍVEIS (sem citizenship, minLevel/minProduction
  // baixos). O topo destas ≈ o que a tela do jogo mostra ao worker (0.123 after-tax), a verdadeira
  // referência competitiva. O worker escolhe pelo AFTER-TAX; o dono paga o BRUTO.
  const accessibleOffer = (o) =>
    !o.citizenship && (!o.minLevel || o.minLevel <= 15) && (!o.minProduction || o.minProduction <= 10) && o.quantity > 0;
  const MKT_TTL = 30 * 60 * 1000; // salários são estáveis → cache 30 min p/ aliviar a API
  async function workMarket() {
    const cached = load(LS.mkt, null);
    if (cached && Date.now() - cached.at < MKT_TTL) return cached;
    let offers = [], cursor;
    for (let i = 0; i < 6; i++) {
      const r = await trpc("workOffer.getWorkOffersPaginated", cursor ? { limit: 50, cursor } : { limit: 50 }).catch(() => null);
      if (!r) break;
      offers.push(...(r.items || [])); cursor = r.nextCursor;
      if (!cursor) break;
    }
    const acc = offers.filter(accessibleOffer);
    const after = acc.map((o) => o.wageAfterTax).filter((x) => x > 0).sort((a, b) => a - b);
    let open = 0, init = 0;
    for (const o of offers) { open += o.quantity || 0; init += o.initialQuantity || 0; }
    if (!after.length) return cached || { n: 0, compAfter: 0, openPct: 0 };
    const p = (pc) => after[Math.floor(pc * (after.length - 1))] || 0;
    const out = {
      at: Date.now(),
      n: acc.length,
      compAfter: p(0.95),                       // melhor oferta ACESSÍVEL (≈ topo que o worker vê)
      openPct: init ? Math.round((open / init) * 100) : 0, // % de vagas por preencher = escassez
    };
    save(LS.mkt, out);
    return out;
  }

  // ---------- histórico + tendência ----------
  function samplePrices(codes) {
    const now = Date.now();
    const last = S.hist[S.hist.length - 1];
    if (last && now - last.t < SAMPLE_MS) return;
    const p = {};
    for (const c of codes) if (S.prices[c] != null) p[c] = +Number(S.prices[c]).toFixed(4);
    S.hist.push({ t: now, p });
    if (S.hist.length > HIST_MAX) S.hist = S.hist.slice(-HIST_MAX);
    save(LS.hist, S.hist);
  }
  const series = (code) => S.hist.map((s) => s.p[code]).filter((v) => v != null);
  function trend(code) {
    const v = series(code);
    if (v.length < 4) return null;
    const rec = v.slice(-6), old = v.slice(-30, -6);
    if (!old.length) return null;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const a = avg(old), b = avg(rec);
    if (!a) return null;
    return ((b - a) / a) * 100;
  }
  function spark(code, w = 84, h = 20) {
    const v = series(code).slice(-48);
    if (v.length < 2) return "";
    const min = Math.min(...v), max = Math.max(...v), rng = max - min || 1;
    const pts = v.map((y, i) => `${(i / (v.length - 1)) * w},${h - 2 - ((y - min) / rng) * (h - 4)}`).join(" ");
    const up = v[v.length - 1] >= v[0];
    return `<svg class="weh-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${up ? "#58c26e" : "#e05252"}" stroke-width="1.5"/></svg>`;
  }
  const arrow = (t) => t == null ? "" : t > 1.5 ? `<span class="weh-up">↗${t.toFixed(0)}%</span>` : t < -1.5 ? `<span class="weh-down">↘${t.toFixed(0)}%</span>` : `<span class="weh-flat">→</span>`;

  // ---------- "estado do tempo" (previsão, não temperatura) ----------
  function weather(co) {
    const reasons = [];
    let score = 0;
    const t = trend(co.itemCode);
    if (t != null) { score += t > 1.5 ? 1 : t < -1.5 ? -1.5 : 0; if (t < -1.5) reasons.push(`preço a cair (${t.toFixed(1)}%)`); if (t > 1.5) reasons.push(`preço a subir (+${t.toFixed(1)}%)`); }
    for (const m of Object.keys(S.cfg.items[co.itemCode]?.needs || {})) {
      const ti = trend(m);
      if (ti != null && ti > 2) { score -= 1; reasons.push(`input ${m} a encarecer (+${ti.toFixed(1)}%)`); }
    }
    if (co.marginPP <= 0) { score -= 2; reasons.push("margem negativa/nula"); }
    else if (co.marginPP < 0.5 * (S.bestMarginPP || co.marginPP)) { score -= 0.5; reasons.push("margem fraca vs as tuas outras"); }
    if (co.cap && co.stock / co.cap >= 0.9) { score -= 1; reasons.push(`armazém ${Math.round((co.stock / co.cap) * 100)}% — vai parar`); }
    const d = co.region?.deposit;
    if (d && d.type === co.itemCode && new Date(d.endsAt) > Date.now()) {
      const hrs = (new Date(d.endsAt) - Date.now()) / 3.6e6;
      if (hrs < 24) { score -= 0.5; reasons.push(`depósito +30% acaba em ${hrs.toFixed(0)}h`); }
      else { score += 1; reasons.push("depósito +30% ativo"); }
    }
    const icon = score >= 1 ? "☀️" : score >= 0 ? "⛅" : score >= -1.5 ? "🌧️" : "⛈️";
    return { icon, reasons };
  }

  // ---------- ciclo de dados ----------
  async function refresh() {
    try {
      const me = await trpc("user.getMe", {});
      S.userId = me?._id;
      const [user, inv, prices] = await Promise.all([
        trpc("user.getUserById", { userId: S.userId }),
        trpc("inventory.getMyInventory", {}).catch(() => null),
        trpc("itemTrading.getPrices", {}),
      ]);
      S.prices = prices || {};
      S.inv = inv?.items?.basics || {};
      S.energyRegen = user?.skills?.energy?.hourlyBarRegen ?? (user?.skills?.energy?.total ?? 0) / 10;

      let cfg = load(LS.cfg, null);
      if (!cfg || cfg.moveCost == null || cfg.ecv !== 2 || Date.now() - cfg.at > 24 * 3.6e6) { cfg = trimConfig(await trpc("gameConfig.getGameConfig", {})); save(LS.cfg, cfg); }
      S.cfg = cfg;

      const listRes = await trpc("company.getCompanies", { userId: S.userId, perPage: 100 });
      const ids = (listRes?.items || listRes || []).map((x) => (typeof x === "string" ? x : x._id));
      const bossId = user?.company && !ids.includes(user.company) ? user.company : null;
      const all = await Promise.all([...ids, ...(bossId ? [bossId] : [])].map((id) => trpc("company.getById", { companyId: id }).catch(() => null)));
      const companies = all.filter(Boolean);

      // países (nomes+bónus+especialização+GUERRAS, cache 2h — inimigos mudam rápido)
      let geo = load(LS.geo, null);
      if (!geo || geo.v !== 5 || geo.myCountry !== user?.country || Date.now() - geo.at > 2 * 3.6e6) {
        const countries = await trpc("country.getAllCountries", {});
        geo = { at: Date.now(), v: 5, countries: {}, myCountry: user?.country, enemies: [] };
        for (const c of countries || []) geo.countries[c._id] = {
          tax: c?.taxes?.market ?? 0, inc: c?.taxes?.income ?? 0, name: c?.name || "?",
          prod: c?.strategicResources?.bonuses?.productionPercent ?? 0,
          spec: c?.specializedItem || null,
        };
        const myC = (countries || []).find((c) => c._id === user?.country);
        if (myC) geo.enemies = [myC.enemy, ...(myC.warsWith || [])].filter(Boolean);
        save(LS.geo, geo);
      }
      S.geo = geo;
      S.enemySet = new Set(geo.enemies || []);
      S.regions = await trpc("region.getRegionsObject", {}).catch(() => S.regions || {});

      // cap de workers = skill "management" (gestão), dinâmico da API (NÃO hardcoded)
      S.mgmtCap = user?.skills?.management?.total ?? 0;
      // mercado de trabalho REAL (ofertas ativas) — wage é o custo do dono; wageAfterTax = o que o worker recebe
      S.market = await workMarket();

      // WORKER: salário é POR PP e o worker compara pelo AFTER-TAX (o que recebe).
      //   Para atrair, o teu after-tax tem de igualar o mercado → pagas BRUTO = alvoAfterTax/(1−imposto).
      //   O imposto de rendimento varia por país da fábrica → países de imposto baixo contratam mais barato.
      //   lucro/pp = margem/pp − bruto_p/_igualar.  breakeven (máx bruto) = margem/pp.
      const targetAfter = S.market?.compAfter || 0; // alvo: melhor oferta acessível (o que o worker escolhe)
      const evalCo = (c) => {
        const region = S.regions[c.region] || null;
        const ci = region ? geo.countries[region.country] : null;
        const mpp = marginPerPP(c.itemCode, region, prodPctFor(ci, c.itemCode));
        const dp = S.cfg.engineLevels[c.activeUpgradeLevels?.automatedEngine ?? 1] ?? 0;
        const enemy = region && S.enemySet?.has(region.country);
        const inc = ci?.inc ?? 0;                          // imposto de rendimento do país
        const grossToMatch = targetAfter / (1 - inc / 100); // bruto que pagas p/ igualar o mercado
        return {
          id: c._id, name: c.name || "?", itemCode: c.itemCode, disabled: !!c.disabledAt,
          marginPP: mpp, profitDay: c.disabledAt ? 0 : dp * mpp,
          potentialDay: dp * mpp, // o que faria se estivesse ativa
          dp, regionId: c.region, workerCount: c.workerCount || 0, engUp: engineUpgrade(c, mpp),
          incomeTax: inc, grossToMatch, breakevenWage: mpp,
          workerProfitPP: mpp - grossToMatch, // lucro/pp pagando o bruto competitivo (pode ser <0)
          enemy, enemyName: enemy ? ci?.name : null,
          stock: c.production || 0, cap: c.maxProduction || 0, region,
        };
      };
      S.mine = companies.filter((c) => ids.includes(c._id)).map(evalCo);
      S.bestMarginPP = Math.max(...S.mine.map((m) => m.marginPP), 0);
      for (const co of S.mine) { co.w = weather(co); co.move = moveAdvice(co); }
      // melhor empresa p/ SELF-WORK agora = maior margem/pp entre as ativas (deposit/tax-aware)
      const sw = S.mine.filter((c) => !c.disabled && c.marginPP > 0).sort((a, b) => b.marginPP - a.marginPP)[0];
      S.bestSelfWorkId = sw ? sw.id : null;

      S.boss = null;
      if (bossId) {
        const bc = companies.find((c) => c._id === bossId);
        if (bc) {
          const b = evalCo(bc);
          const wk = await trpc("worker.getWorkers", { companyId: bossId }).catch(() => null);
          const workers = Array.isArray(wk) ? wk : wk?.workers || wk?.items || [];
          const meW = workers.find((x) => (x.user?._id || x.user) === S.userId);
          const worksDay = Math.floor((S.energyRegen * 24) / 10);
          const wage = meW?.wage ?? null;
          S.boss = { ...b, wage, worksDay, wageDay: wage != null ? wage * worksDay : null };
        }
      }

      const codes = new Set(S.mine.map((m) => m.itemCode));
      if (S.boss) codes.add(S.boss.itemCode);
      for (const c of [...codes]) for (const m of Object.keys(S.cfg.items[c]?.needs || {})) codes.add(m);
      samplePrices([...codes]);

      S.err = null; S.at = Date.now();
    } catch (e) {
      S.err = e?.message || String(e);
    }
    renderPanel();
    applyCards();
  }

  // ---------- helpers de UI ----------
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const num = (n, d = 2) => Number(n || 0).toFixed(d);
  const coins = (n, d = 2, cls = "weh-gold") => `<span class="${cls}">${COIN}${num(n, d)}</span>`;
  // ícone real do item do jogo (padrão /images/items/<code>.png, visto em imagens.html)
  const itemIcon = (code) => `<img class="weh-item" src="/images/items/${encodeURIComponent(code)}.png?v=33" alt="${esc(code)}">`;

  function css() {
    if (document.getElementById("weh-css")) return;
    const st = document.createElement("style");
    st.id = "weh-css";
    st.textContent = `
.weh-gold{color:#f0b13e;white-space:nowrap}
.weh-up{color:#58c26e}.weh-down{color:#e05252}.weh-flat{color:#8494a8}
.weh-coin{width:1em;height:1em;vertical-align:-0.14em;margin-right:2px;font-size:105%;
  filter:drop-shadow(black 1px 1px 0px)}
.weh-spark{display:inline-block;vertical-align:middle}
.weh-item{width:15px;height:15px;object-fit:contain;vertical-align:-3px;
  filter:drop-shadow(black 1px 1px 0px)}

/* chip UI-NATIVE: ancorado na fila de stats do jogo mas em LINHA PRÓPRIA (flex:1 1 100%), para
   não alargar a fila e empurrar a UI do jogo para fora do ecrã. Texto pequeno (10px) e a QUEBRAR
   linha (white-space:normal + min-width:0) — assim nunca força overflow horizontal, no máximo cresce
   para baixo. Sem caixa; drop-shadow como os badges nativos. */
.weh-cardrow{display:flex;flex-wrap:wrap;align-items:center;column-gap:5px;row-gap:1px;
  flex:1 1 100%;min-width:0;max-width:100%;box-sizing:border-box;margin-top:2px;
  font:600 10px/1.35 inherit;color:#dbe4ee;font-variant-numeric:tabular-nums;
  white-space:normal;cursor:pointer;filter:drop-shadow(1px 1px 0 #000)}
.weh-cardrow:hover{color:#fff}
.weh-cardrow .weh-dim{color:#8494a8;font-weight:500}
/* ícone do item dentro do chip acompanha o texto pequeno (o do mini-pill fica nos 15px) */
.weh-cardrow .weh-item{width:13px;height:13px;vertical-align:-2px}

/* popover custom (ao clique) — com a pele do jogo; abre/fecha ao clicar */
#weh-tip{position:fixed;z-index:99999;display:none;max-width:min(300px,92vw);pointer-events:auto;
  background:#1a212bfa;border:1px solid #2b3441;border-radius:9px;padding:8px 11px;
  box-shadow:0 8px 24px #000b;backdrop-filter:blur(6px);
  font:500 11.5px/1.6 Inter,system-ui,Segoe UI,sans-serif;color:#dbe4ee;white-space:normal}
#weh-tip .weh-dim{color:#8494a8}
#weh-tip>div+div{margin-top:3px}

/* mini-pill do mercado (minimizado por defeito) */
#weh{position:fixed;z-index:99990;bottom:14px;left:14px;color:#dbe4ee;
  font:12px/1.45 Inter,system-ui,Segoe UI,sans-serif;user-select:none}
#weh .weh-box{background:#151a21f2;border:1px solid #2b3441;border-radius:11px;overflow:hidden;
  box-shadow:0 8px 28px #0009;backdrop-filter:blur(6px)}
#weh .weh-head{display:flex;align-items:center;gap:8px;padding:7px 11px;cursor:grab;background:#1a212b}
#weh.open .weh-head{border-bottom:1px solid #2b3441}
#weh .weh-head b{font-size:11px;letter-spacing:.07em;color:#f0b13e;text-transform:uppercase}
#weh .weh-btn{cursor:pointer;border:0;background:#232c38;color:#8494a8;border-radius:6px;padding:2px 7px;font-size:11px}
#weh .weh-btn:hover{color:#dbe4ee}
#weh .weh-body{width:min(300px,92vw);max-height:50vh;overflow-y:auto;padding:6px 0 8px}
#weh .weh-body::-webkit-scrollbar{width:8px}
#weh .weh-body::-webkit-scrollbar-thumb{background:#2b3441;border-radius:8px}
#weh .weh-row{display:flex;align-items:center;gap:7px;padding:4px 11px}
#weh .weh-row:hover{background:#1a212b}
#weh .weh-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#weh .weh-num{font-variant-numeric:tabular-nums;font-weight:600}
#weh h4{margin:8px 11px 3px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#617083}
#weh .weh-err{padding:7px 11px;color:#e05252}
#weh .weh-foot{padding:4px 11px 7px;color:#617083;font-size:10px}`;
    document.head.appendChild(st);
  }

  // ---------- mini-pill: mercado + sparklines (única coisa fora dos cartões) ----------
  function renderPanel() {
    css();
    let root = document.getElementById("weh");
    if (!root) {
      root = document.createElement("div");
      root.id = "weh";
      document.body.appendChild(root);
      const ui = load(LS.ui, {});
      if (ui.x != null) { root.style.left = ui.x + "px"; root.style.bottom = "auto"; root.style.top = ui.y + "px"; }
    }
    const ui = load(LS.ui, {});
    const open = !!ui.open; // minimizado por defeito
    root.classList.toggle("open", open);

    const mkt = [...new Set([...S.mine.map((m) => m.itemCode), ...(S.boss ? [S.boss.itemCode] : [])])].map((code) => `
      <div class="weh-row">
        <span class="weh-name">${itemIcon(code)} ${esc(code)}</span>
        ${spark(code) || `<span class="weh-flat" style="font-size:10px">a aprender…</span>`}
        <span class="weh-num">${coins(S.prices[code], 3)}</span>
        ${arrow(trend(code))}
      </div>`).join("");

    // overview agregado: produção passiva + ordenado do dia
    const prodDay = S.mine.reduce((s, c) => s + c.profitDay, 0);
    const totalDay = prodDay + (S.boss?.wageDay || 0);
    const resumo = `
      <div class="weh-row"><span class="weh-name">produção (${S.mine.filter((c) => !c.disabled).length} empresas)</span><span class="weh-num">${coins(prodDay)}</span><span class="weh-flat">/d</span></div>
      ${S.boss?.wageDay != null ? `<div class="weh-row"><span class="weh-name">ordenado (${esc(S.boss.name)})</span><span class="weh-num">${coins(S.boss.wageDay)}</span><span class="weh-flat">/d</span></div>` : ""}
      <div class="weh-row"><span class="weh-name"><b style="color:#dbe4ee">total</b></span><span class="weh-num">${coins(totalDay)}</span><span class="weh-flat">/d</span></div>`;

    // WORKERS: salário é POR PP. Só compensa onde margem/pp > salário/pp de mercado.
    const hire = S.mine.filter((c) => !c.disabled && c.marginPP > 0)
      .sort((a, b) => b.marginPP - a.marginPP);
    const usedSlots = S.mine.reduce((s, c) => s + (c.workerCount || 0), 0);
    const anyProfit = hire.some((c) => c.workerProfitPP > 0);
    const workersBlock = S.market?.compAfter ? `
      <h4>Workers · gestão ${usedSlots}/${S.mgmtCap || "?"} · mercado ${coins(S.market.compAfter, 3)}/pp after-tax<span class="weh-flat" style="font-weight:400"> (${S.market.openPct}% vagas por preencher)</span></h4>
      ${!anyProfit ? `<div class="weh-row weh-down" style="font-size:11px">⚠ nenhuma empresa compensa: p/ igualar o mercado pagas mais/pp do que a margem. Workers dariam prejuízo.</div>` : ""}
      ${hire.slice(0, 4).map((c) => `<div class="weh-row">
        <span class="weh-name">${itemIcon(c.itemCode)} ${esc(c.name)}${c.enemy ? ` <span class="weh-down">⚔️</span>` : ""}</span>
        <span class="weh-flat" style="font-size:10px">limite ${num(c.breakevenWage, 3)}</span>
        <span class="weh-num ${c.workerProfitPP > 0 ? "weh-up" : "weh-down"}">${c.workerProfitPP > 0 ? "+" : ""}${num(c.workerProfitPP, 3)}</span><span class="weh-flat">/pp</span>
      </div>`).join("")}
      <div class="weh-foot" style="padding-top:2px">limite = salário máx que podes pagar (= margem/pp) · atrair custa ~${num(S.market.compAfter, 3)}/(1−imposto) bruto · ⚔️ financia inimigo</div>` : "";

    root.innerHTML = `
      <div class="weh-box">
        <div class="weh-head" id="weh-drag">
          <b>${open ? "Overview" : ""}</b>
          <span class="weh-num">${coins(totalDay)}<span class="weh-flat" style="font-weight:500">/d</span></span>
          ${S.err ? `<span class="weh-down" title="${esc(S.err)}">⚠</span>` : ""}
          <button class="weh-btn" id="weh-re" title="atualizar">↻</button>
          <button class="weh-btn" id="weh-min" title="${open ? "encolher" : "expandir"}">${open ? "▾" : "▸"}</button>
        </div>
        ${!open ? "" : `<div class="weh-body">
          ${S.err ? `<div class="weh-err">⚠ ${esc(S.err)}</div>` : ""}
          ${resumo}
          ${workersBlock}
          <h4>Mercado</h4>
          ${mkt || `<div class="weh-row weh-flat">sem dados ainda…</div>`}
          <div class="weh-foot">read-only · ${S.at ? new Date(S.at).toLocaleTimeString("pt-PT") : "a carregar…"} · ${S.hist.length} amostras de preços</div>
        </div>`}
      </div>`;

    root.querySelector("#weh-re")?.addEventListener("click", () => refresh());
    root.querySelector("#weh-min")?.addEventListener("click", () => { const u = load(LS.ui, {}); u.open = !u.open; save(LS.ui, u); renderPanel(); });
    const head = root.querySelector("#weh-drag");
    head?.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      const r = root.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => { root.style.left = ev.clientX - dx + "px"; root.style.top = ev.clientY - dy + "px"; root.style.bottom = "auto"; };
      const up = (ev) => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        const u = load(LS.ui, {}); u.x = ev.clientX - dx; u.y = ev.clientY - dy; save(LS.ui, u); };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
  }

  // ---------- injeção nos cartões (glance-first) ----------
  function findNameNodes(name) {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.nodeValue && n.nodeValue.trim() === name && !n.parentElement.closest("#weh, .weh-cardrow")
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    let n; while ((n = walker.nextNode())) out.push(n.parentElement);
    return out;
  }
  // sobe até ao cartão (o ancestral mais próximo que contém um ícone de item DO JOGO)
  function cardScope(el) {
    let n = el;
    for (let i = 0; i < 8 && n; i++) {
      if (n.querySelector && n.querySelector('img[src*="/images/items/"]:not(.weh-item)')) return n;
      n = n.parentElement;
    }
    return el.parentElement || el;
  }
  // lê o itemCode que o cartão mostra (para distinguir empresas com o MESMO nome)
  function itemInCard(scope) {
    const img = scope.querySelector('img[src*="/images/items/"]:not(.weh-item)');
    const m = (img?.getAttribute("src") || "").match(/\/images\/items\/([^/.?]+)/);
    return m ? m[1] : img?.getAttribute("alt") || null;
  }
  // linha de STATS do jogo dentro do cartão = a que junta os badges nativos ("+35%", "7%", "⚙6"…).
  // Cada badge é um div[aria-haspopup="dialog"] com um svg.mdi-icon; a linha é o pai que tem MAIS
  // desses badges (≥2, p/ não confundir com o badge solitário ao lado do nome). Classes atómicas
  // hasheadas do jogo mudam — por isso ancoramos por estes atributos semânticos, não por classe.
  function statsRow(scope) {
    const badges = [...scope.querySelectorAll('div[aria-haspopup="dialog"]')].filter((b) => b.querySelector("svg.mdi-icon"));
    const byParent = new Map();
    for (const b of badges) { const p = b.parentElement; if (p) byParent.set(p, (byParent.get(p) || 0) + 1); }
    let best = null, n = 1; // exige ≥2 badges na linha
    for (const [p, c] of byParent) if (c > n) { n = c; best = p; }
    return best;
  }

  // chip de uma empresa MINHA: ☀️ lucro/d · inv N · tendência (tooltip = razões da previsão)
  // OFF mostra INLINE o valor que faria se ativa, a cinzento (pedido do utilizador: sem ir ao tooltip)
  function rowMine(co) {
    const qty = Number(S.inv[co.itemCode] || 0);
    // cor do valor/dia: VERDE = melhor self-work agora · VERMELHO = margem ≤0 · CINZA = OFF (potencial) · dourado = resto
    const cls = co.disabled ? "weh-dim" : co.id === S.bestSelfWorkId ? "weh-up" : co.marginPP <= 0 ? "weh-down" : "weh-gold";
    const val = co.disabled ? co.potentialDay : co.profitDay;
    return `${co.w.icon} ${coins(val, 2, cls)}<span class="weh-dim">/d${co.disabled ? " OFF" : ""}</span>` +
      `<span class="weh-dim">·</span>${itemIcon(co.itemCode)} ${qty.toLocaleString()}` +
      `${trend(co.itemCode) != null ? `<span class="weh-dim">·</span>${arrow(trend(co.itemCode))}` : ""}` +
      `${co.move?.chip ? `<span class="weh-dim">·</span><span class="weh-dim">${co.move.chip}</span>` : ""}` +
      `${!co.disabled && co.engUp && isFinite(co.engUp.days) ? `<span class="weh-dim">·</span><span class="weh-dim">⚙️${co.engUp.days < 1 ? Math.round(co.engUp.days * 24) + "h" : Math.round(co.engUp.days) + "d"}</span>` : ""}` +
      `${co.enemy ? `<span class="weh-dim">·</span><span class="weh-down" title="território inimigo">⚔️</span>` : ""}`;
  }
  // alternativa de localização — SÓ FACTOS, sem veredicto (quem decide és tu).
  // Separa DUAS perguntas diferentes:
  //   1) casa PERMANENTE: melhor região ignorando depósitos (bónus país+especialização estável).
  //   2) OPORTUNIDADE de depósito: se houver depósito ativo do teu item que bata a permanente
  //      durante a sua janela, é uma jogada temporária — mostra a janela e o resíduo pós-janela.
  // devolve {chip, txt}. chip mostra o payback da mudança permanente (ou "dep Nh" se só houver janela).
  const nameWithBonus = (rg, ci, code) => {
    const pct = prodPctFor(ci, code);
    return `${rg.name || "?"} (${ci?.name || "?"}${pct ? `, +${pct}%${ci?.spec === code ? " c/ especialização" : ""}` : ""})`;
  };
  function moveAdvice(co) {
    if (!S.regions || !co.dp) return null;
    const cost = (S.cfg.moveCost || 5) * (S.prices.concrete || 0); // mudança paga-se em BETÃO
    let perm = null, dep = null; // melhor permanente (sem depósito) · melhor oportunidade de depósito
    for (const [rid, rg] of Object.entries(S.regions)) {
      if (rid === co.regionId || !rg) continue;
      const ci = S.geo?.countries?.[rg.country];
      const pp = prodPctFor(ci, co.itemCode);
      const permMpp = marginPerPP(co.itemCode, { ...rg, deposit: null }, pp);
      if (!perm || permMpp > perm.mpp) perm = { mpp: permMpp, rg, ci };
      const d = rg.deposit;
      if (d && d.type === co.itemCode && new Date(d.endsAt) > Date.now()) {
        const nowMpp = marginPerPP(co.itemCode, rg, pp);
        if (!dep || nowMpp > dep.mpp) dep = { mpp: nowMpp, rg, ci, endsAt: d.endsAt };
      }
    }
    if (!perm) return null;

    const lines = [];
    let chip = "";
    // 1) mudança permanente
    const permGain = co.dp * (perm.mpp - co.marginPP);
    if (permGain >= 0.1) {
      const pb = cost / permGain < 1 ? Math.round((cost / permGain) * 24) + "h" : num(cost / permGain, 1) + "d";
      chip = `🏭 ${pb}`;
      lines.push(`🏭 melhor casa fixa: ${nameWithBonus(perm.rg, perm.ci, co.itemCode)} → +${num(permGain)}/d permanente · mudar custa ~${num(cost)} · recuperas em ${pb}`);
    }
    // 2) oportunidade de depósito (só se render mais QUE a casa permanente durante a janela).
    //    Deposit hunting = IDA + VOLTA a casa → custo = 2× mudança. A janela tem de pagar as duas.
    if (dep && dep.mpp > perm.mpp) {
      const hrs = (new Date(dep.endsAt) - Date.now()) / 3.6e6;
      const depGain = co.dp * (dep.mpp - co.marginPP);        // vs onde estás agora
      const windowGain = (depGain * Math.max(0, hrs - 4)) / 24; // −4h logística
      const roundTrip = 2 * cost;                             // ir ao depósito e voltar
      const net = windowGain - roundTrip;
      const verdict = net >= 0 ? `paga a ida-e-volta (líquido +${num(net)})` : `NÃO paga a ida-e-volta (~${num(roundTrip)}) → perdes ${num(-net)}`;
      lines.push(`📦 depósito AGORA em ${nameWithBonus(dep.rg, dep.ci, co.itemCode)}: +${num(depGain)}/d · janela ${hrs.toFixed(0)}h ≈ +${num(windowGain)} · ida-e-volta ~${num(roundTrip)} → ${verdict}`);
      if (!chip) chip = `📦 ${hrs.toFixed(0)}h`;
    }
    if (!lines.length) return { chip: "", txt: `🏭 já estás na melhor localização p/ ${co.itemCode}` };
    return { chip, txt: lines.join("\n") };
  }

  // chip do PATRÃO: lucro dele/d · o teu ordenado/d
  function rowBoss(b) {
    return `👔 ${coins(b.profitDay, 2)}<span class="weh-dim">/d dele</span>` +
      `<span class="weh-dim">·</span><span class="weh-dim">tu</span> ${b.wageDay != null ? coins(b.wageDay, 2) : "—"}<span class="weh-dim">/d</span>`;
  }

  // tooltip RICO (o nativo é lento/feio — este é instantâneo e com a pele do jogo)
  function tipMine(co) {
    const lines = [];
    if (co.id === S.bestSelfWorkId) lines.push(`<div class="weh-up">⚡ melhor self-work agora (maior margem/pp)</div>`);
    if (co.disabled) lines.push(`<div>💤 OFF — o valor no chip é o que faria se ativa</div>`);
    const ci = co.region ? S.geo?.countries?.[co.region.country] : null;
    if (ci) lines.push(`<div><span class="weh-dim">local:</span> ${esc(ci.name)} · bónus produção +${num(prodPctFor(ci, co.itemCode), 1)}%${ci.spec === co.itemCode ? ` (inclui +${SPEC_BONUS}% especialização)` : ""}</div>`);
    lines.push(`<div><span class="weh-dim">previsão:</span> ${co.w.icon} ${esc(co.w.reasons.join(" · ") || "estável")}</div>`);
    // worker: 1 linha — LIMITE (salário máx que podes pagar = margem/pp) vs o que atrair custa
    if (!co.disabled && co.marginPP > 0 && S.market?.compAfter) {
      const ok = co.workerProfitPP > 0;
      lines.push(`<div class="${ok ? "weh-up" : "weh-down"}">👷 limite ${num(co.breakevenWage, 3)}/pp · mercado ~${num(co.grossToMatch, 3)} → ${ok ? "✓" : "✗"}</div>`);
    }
    if (co.enemy) lines.push(`<div class="weh-down">⚔️ território INIMIGO (${esc(co.enemyName || "?")}): imposto do salário financia o inimigo</div>`);
    if (co.engUp) {
      const e = co.engUp;
      lines.push(`<div><span class="weh-dim">⚙️ motor L${e.cur}→L${e.next}:</span> +${e.extraPP} pp/dia (+${coins(e.gainDay)}/d) · custo ~${coins(e.cost)} <span class="weh-dim">(${e.qty} aço)</span> → ${isFinite(e.days) ? "paga em " + Math.round(e.days) + " dias" : "não paga"}${co.disabled ? " <span class=\"weh-dim\">(só quando reativada)</span>" : ""}</div>`);
    }
    if (co.move) for (const l of co.move.txt.split("\n")) lines.push(`<div>${esc(l)}</div>`);
    return lines.join("");
  }
  const tipBoss = (b) =>
    `<div><span class="weh-dim">lucro do patrão vs o teu ordenado:</span></div>` +
    `<div>${coins(b.wage, 3)}<span class="weh-dim">/work</span> × ${b.worksDay} <span class="weh-dim">works/dia</span> = ${coins(b.wageDay ?? 0)}<span class="weh-dim">/d</span></div>`;

  function showTip(row) {
    const html = S.tips && S.tips[row.dataset.co];
    if (!html) return;
    let tip = document.getElementById("weh-tip");
    if (!tip) { tip = document.createElement("div"); tip.id = "weh-tip"; document.body.appendChild(tip); }
    tip.innerHTML = html;
    tip.style.display = "block";
    tip.style.left = "0px"; tip.style.top = "0px"; // reset p/ medir
    const r = row.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = Math.max(8, Math.min(r.left, innerWidth - tw - 8));
    let y = r.bottom + 6;
    if (y + th > innerHeight - 8) y = r.top - th - 6;
    tip.style.left = x + "px"; tip.style.top = Math.max(8, y) + "px";
    S.tipCo = row.dataset.co;
  }
  function hideTip() { const t = document.getElementById("weh-tip"); if (t) t.style.display = "none"; S.tipCo = null; }
  // DELEGAÇÃO no document (não no chip): sobrevive aos re-renders do React → SEM flicker.
  // O chip está DENTRO de <a href="/company/…"> e de triggers de popover do jogo que abrem
  // no POINTERDOWN. Por isso engolimos o pointerdown (bloqueia o menu/navegação do jogo),
  // fazemos o toggle no pointerup (funciona p/ rato E toque), e bloqueamos o click.
  const inChip = (e) => e.target.closest && e.target.closest(".weh-cardrow");
  document.addEventListener("pointerdown", (e) => {
    if (inChip(e)) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  document.addEventListener("pointerup", (e) => {
    const chip = inChip(e);
    if (chip) { e.stopPropagation(); e.preventDefault(); S.tipCo === chip.dataset.co ? hideTip() : showTip(chip); }
  }, true);
  document.addEventListener("click", (e) => {
    if (inChip(e)) { e.stopPropagation(); e.preventDefault(); } // já tratado no pointerup
    else if (!(e.target.closest && e.target.closest("#weh-tip"))) hideTip();
  }, true);

  function placeChip(el, ent) {
    // o chip vive DENTRO do elemento do nome, inline à direita (sobrevive a re-renders).
    // SEM listeners no chip — o clique é tratado por delegação no document (ver acima).
    let row = el.querySelector(":scope > .weh-cardrow");
    if (!row) {
      row = document.createElement("span");
      row.className = "weh-cardrow";
      el.appendChild(row);
    }
    row.dataset.co = ent.co.id;
    if (row.dataset.h !== ent.html) { row.dataset.h = ent.html; row.innerHTML = ent.html; }
  }

  function applyCards() {
    if (!S.mine.length && !S.boss) return;
    S.tips = {};
    const entities = [
      ...S.mine.map((co) => ({ co, html: rowMine(co), tip: tipMine(co) })),
      ...(S.boss ? [{ co: S.boss, html: rowBoss(S.boss), tip: tipBoss(S.boss) }] : []),
    ];
    for (const e of entities) S.tips[e.co.id] = e.tip;

    // agrupar por nome: empresas com o MESMO nome desambiguam-se pelo ícone do item no cartão
    const byName = new Map();
    for (const e of entities) { const a = byName.get(e.co.name) || []; a.push(e); byName.set(e.co.name, a); }

    for (const [name, ents] of byName) {
      const nodes = findNameNodes(name);
      const used = [];
      for (const el of nodes) {
        const scope = cardScope(el);
        let ent = ents[0];
        if (ents.length > 1) {
          const item = itemInCard(scope);
          const matches = ents.filter((x) => x.co.itemCode === item);
          // entre empresas do mesmo nome+item (ex.: 2×iron) são idênticas → qualquer serve
          ent = matches.find((x) => !used.includes(x)) || matches[0] || ents.find((x) => !used.includes(x)) || ents[0];
        }
        used.push(ent);
        // UI-native: ancorar na linha de stats do jogo; se não a encontrar, fallback p/ o nome
        placeChip(statsRow(scope) || el, ent);
      }
    }
  }

  // ---------- reagir a AÇÕES do jogador (ativar/desativar empresa, trabalhar, …) ----------
  // as mutações do jogo são POSTs tRPC — intercetamos o fetch do app e refrescamos 1.2s depois.
  // (o nosso próprio trpc() usa GET, por isso não entra em loop)
  let qr = 0;
  const queueRefresh = () => {
    const now = Date.now();
    if (now - qr < 3000) return; // rate-limit
    qr = now;
    setTimeout(refresh, 1200);
  };
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = String((args[0] && args[0].url) || args[0] || "");
      const method = String((args[1] && args[1].method) || (args[0] && args[0].method) || "GET").toUpperCase();
      // NB: consumir a rejeição desta cadeia paralela — sem isto, um POST falhado do jogo
      // gerava um "Uncaught (in promise)" atribuído ao userscript (visto 2026-07-04)
      if (url.includes("/trpc/") && method !== "GET") p.then(queueRefresh, queueRefresh);
    } catch (_) {}
    return p;
  };

  // ---------- arranque ----------
  const mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(applyCards, 400); });
  mo.observe(document.body, { childList: true, subtree: true });
  setInterval(applyCards, DOM_MS);
  setInterval(refresh, REFRESH_MS);
  refresh();
})();
