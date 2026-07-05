import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = globalThis.process?.env || {};
const PORT = Number(env.PORT || 8788);
const REFRESH_MS = Number(env.REFRESH_MS || 10000);
const mockPath = path.join(__dirname, 'data', 'mock-sources.json');
const clients = new Set();
let state = null;
let tick = 0;

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readMock() {
  return JSON.parse(fs.readFileSync(mockPath, 'utf8'));
}

async function fetchJson(url) {
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } catch (error) {
    return { __error: error.message };
  }
}

function normalizeNews(raw, fallback) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.news) ? raw.news : fallback.news;
  return list.slice(0, 12).map((item, index) => ({
    sector: item.sector || item.track || item.category || 'all',
    level: item.level || (Number(item.score || 70) >= 85 ? 'hot' : 'watch'),
    title: item.title || item.summary || item.name || ('资讯 ' + (index + 1)),
    meta: item.meta || item.reason || item.source || '等待题材映射',
    score: Number(item.score || item.heat || (index < 2 ? 88 : 72))
  }));
}

function normalizeMarket(raw, fallback, wave) {
  const market = raw?.market || raw || fallback.market;
  return {
    limitUp: Number(market.limitUp ?? market.limit_up ?? fallback.market.limitUp) + wave.small,
    chainLimitUp: Number(market.chainLimitUp ?? market.chain_limit_up ?? fallback.market.chainLimitUp),
    breakRate: Math.max(5, Number(market.breakRate ?? market.break_rate ?? fallback.market.breakRate) + wave.breakMove),
    breadth: Number(market.breadth ?? fallback.market.breadth),
    marketPhase: market.marketPhase || market.market_phase || fallback.market.marketPhase,
    mainlineLevel: market.mainlineLevel || market.mainline_level || fallback.market.mainlineLevel
  };
}

function normalizeSectors(raw, fallback, wave) {
  const list = Array.isArray(raw?.sectors) ? raw.sectors : Array.isArray(raw?.boards) ? raw.boards : fallback.sectors;
  return list.slice(0, 8).map((item, index) => {
    const score = Number(item.score ?? item.heat ?? fallback.sectors[index % fallback.sectors.length].score) + wave.scoreMove;
    return {
      title: item.title || item.name || item.board || ('板块 ' + (index + 1)),
      theme: item.theme || item.sector || 'all',
      limitUp: Number(item.limitUp ?? item.limit_up ?? fallback.sectors[index % fallback.sectors.length].limitUp),
      breaks: Number(item.breaks ?? item.break_count ?? fallback.sectors[index % fallback.sectors.length].breaks),
      turnoverChange: Number(item.turnoverChange ?? item.turnover_change ?? fallback.sectors[index % fallback.sectors.length].turnoverChange),
      score: Math.max(0, Math.min(100, Math.round(score)))
    };
  });
}

function normalizeCandidates(raw, fallback, sectors) {
  const list = Array.isArray(raw?.candidates) ? raw.candidates : Array.isArray(raw?.stocks) ? raw.stocks : fallback.candidates;
  return list.slice(0, 12).map((item, index) => {
    const base = fallback.candidates[index % fallback.candidates.length];
    const theme = item.theme || item.board || base.theme;
    const sector = sectors.find(s => theme.includes(s.title) || s.title.includes(theme));
    const trend = Number(item.trend ?? item.score ?? base.trend);
    const leaderBonus = String(item.leader || base.leader).startsWith('A') ? 6 : 0;
    const score = Math.max(0, Math.min(100, Math.round(trend * 0.58 + (sector?.score || 70) * 0.32 + leaderBonus)));
    return {
      code: item.code || base.code,
      name: item.name || base.name,
      theme,
      buyPoint: item.buyPoint || item.buy_point || base.buyPoint,
      leader: item.leader || base.leader,
      trend: Math.round(trend),
      score,
      action: score >= 88 ? '可重点' : score >= 78 ? '等承接' : score >= 68 ? '观察' : '不接力'
    };
  });
}

function buildRisks(market, sectors) {
  const risks = [];
  if (market.breakRate >= 25) risks.push({ title: '炸板率抬升', meta: '接力难度提高，优先等分歧承接', tag: '谨慎' });
  if (market.breadth < 0.45) risks.push({ title: '大势转弱', meta: '弱势震荡或下降期，降低仓位', tag: '降权' });
  if (sectors.length && sectors[0].score - (sectors[1]?.score || 0) < 4) risks.push({ title: '主线不够聚焦', meta: '多题材轮动，避免高预期切换', tag: '观察' });
  risks.push({ title: '高位充分演绎', meta: '连续加速后的反包不计入再启动', tag: '谨慎' });
  risks.push({ title: '低于预期', meta: '主升个股不应大幅低开，触发后先应对', tag: '应对' });
  return risks.slice(0, 5);
}

function buildLogs(news, market, sectors, candidates) {
  const now = new Date();
  const hhmm = now.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return [
    { time: hhmm, title: (sectors[0]?.title || '主线') + '进入市场验证', body: '涨停、成交额、热度共同进入评分模型。' },
    { time: hhmm, title: (news[0]?.title || '题材催化') + '完成映射', body: news[0]?.meta || '等待资讯输出。' },
    { time: hhmm, title: (candidates[0]?.code || '') + ' 候选龙头评分更新', body: '当前动作：' + (candidates[0]?.action || '观察') + '。' },
    { time: hhmm, title: '大势状态：' + market.marketPhase, body: '主线强度 ' + market.mainlineLevel + '，炸板率 ' + market.breakRate + '%。' }
  ];
}

function buildBars() {
  return Array.from({ length: 12 }, (_, index) => {
    const base = [36,48,44,62,58,77,82,68,75,91,84,96][index];
    return Math.max(18, Math.min(98, base + Math.round(Math.sin((tick + index) / 2) * 6)));
  });
}

async function refreshState() {
  tick += 1;
  const fallback = readMock();
  const [stockRaw, newsRaw] = await Promise.all([
    fetchJson(env.ASTOCK_DATA_URL),
    fetchJson(env.INVESTMENT_NEWS_URL)
  ]);
  const wave = { small: tick % 3 - 1, breakMove: tick % 5 - 2, scoreMove: tick % 4 - 1 };
  const news = normalizeNews(newsRaw && !newsRaw.__error ? newsRaw : null, fallback);
  const market = normalizeMarket(stockRaw && !stockRaw.__error ? stockRaw : null, fallback, wave);
  const sectors = normalizeSectors(stockRaw && !stockRaw.__error ? stockRaw : null, fallback, wave).sort((a, b) => b.score - a.score);
  const candidates = normalizeCandidates(stockRaw && !stockRaw.__error ? stockRaw : null, fallback, sectors).sort((a, b) => b.score - a.score);
  state = {
    updatedAt: new Date().toISOString(),
    source: {
      stock: env.ASTOCK_DATA_URL ? (stockRaw?.__error ? 'error: ' + stockRaw.__error : 'a-stock-data') : 'mock',
      news: env.INVESTMENT_NEWS_URL ? (newsRaw?.__error ? 'error: ' + newsRaw.__error : 'investment-news') : 'mock'
    },
    news,
    mappings: [
      { title: 'AI/大模型', meta: '算力、AI应用、数据中心、端侧设备', tag: '强催化' },
      { title: '机器人', meta: '人形机器人、减速器、伺服、丝杠', tag: '验证中' },
      { title: '商业航天', meta: '卫星互联网、低空经济、军工电子', tag: '轮动' },
      { title: '新能源', meta: '储能、固态电池、光伏设备', tag: '观察' }
    ],
    market,
    sectors,
    candidates,
    risks: buildRisks(market, sectors),
    logs: buildLogs(news, market, sectors, candidates),
    bars: buildBars(),
    rules: [
      { title: '高优先级', body: '大势无风险 + 节奏好 + 主线 + 逻辑发展性好 + 走势强度好 + 最票地位。' },
      { title: '启动破局', body: '从无到有，优先共振启动；启动前三天的分歧按惯性修复观察。' },
      { title: '主升聚焦', body: '主线充分演绎前，少切轮动；超级行情扩大最票池，首次分歧容错更高。' },
      { title: '无咎风控', body: '滞涨降仓，低于预期应对，模式外机会不计入重仓池。' }
    ]
  };
  broadcast();
  return state;
}

function seeded(code) {
  let seed = 0;
  for (const ch of String(code)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function makeKline(code, period, count, basePrice) {
  const rand = seeded(code + period);
  const list = [];
  let close = basePrice;
  const now = new Date();
  const stepDays = period === 'month' ? 30 : period === 'week' ? 7 : 1;
  for (let i = count - 1; i >= 0; i--) {
    const date = new Date(now.getTime() - i * stepDays * 86400000);
    const drift = (rand() - 0.46) * (period === 'month' ? 4.2 : period === 'week' ? 3.2 : 2.1);
    const open = close * (1 + (rand() - 0.5) * 0.025);
    close = Math.max(2, close * (1 + drift / 100));
    const high = Math.max(open, close) * (1 + rand() * 0.035);
    const low = Math.min(open, close) * (1 - rand() * 0.035);
    const volume = Math.round((rand() * 0.8 + 0.45) * 1000000);
    list.push({
      date: date.toISOString().slice(0, 10),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume
    });
  }
  return list;
}

function makeMinuteLine(code, basePrice) {
  const rand = seeded(code + 'minute');
  const points = [];
  let price = basePrice;
  const slots = [];
  for (let h = 9, m = 30; h < 11 || (h === 11 && m <= 30); m += 5) {
    if (m >= 60) { h += 1; m = 0; }
    slots.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
  }
  for (let h = 13, m = 0; h < 15 || (h === 15 && m === 0); m += 5) {
    if (m >= 60) { h += 1; m = 0; }
    slots.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
  }
  for (const time of slots) {
    price = Math.max(2, price * (1 + (rand() - 0.49) * 0.012));
    points.push({ time, price: Number(price.toFixed(2)), volume: Math.round((rand() * 0.8 + 0.2) * 80000) });
  }
  return points;
}

function makeStockDetail(code) {
  const fallback = readMock();
  const all = state?.candidates?.length ? state.candidates : fallback.candidates;
  const found = all.find(item => String(item.code) === String(code)) || all[0] || fallback.candidates[0];
  const basePrice = 8 + (Number(String(code).slice(-3)) % 90) + ((String(code).charCodeAt(0) || 0) % 7);
  const daily = makeKline(code, 'day', 80, basePrice);
  const weekly = makeKline(code, 'week', 70, basePrice * 0.82);
  const monthly = makeKline(code, 'month', 60, basePrice * 0.64);
  const last = daily[daily.length - 1];
  const prev = daily[daily.length - 2] || last;
  const change = last.close - prev.close;
  const pct = prev.close ? change / prev.close * 100 : 0;
  return {
    code: String(code),
    name: found.name || '候选股',
    theme: found.theme || '未分类',
    buyPoint: found.buyPoint || '观察',
    leader: found.leader || 'B',
    action: found.action || '观察',
    score: Number(found.score || found.trend || 70),
    quote: {
      price: last.close,
      change: Number(change.toFixed(2)),
      pct: Number(pct.toFixed(2)),
      high: last.high,
      low: last.low,
      volume: last.volume
    },
    thesis: [
      '三位一体评分：大势、板块、个股共同确认后才进入重点池。',
      '买点标签来自启动/分歧/主升模式，盘中需要看承接与预期差。',
      '若低于预期或板块退潮，按无咎原则先处理风险。'
    ],
    minute: makeMinuteLine(code, last.close),
    kline: { day: daily, week: weekly, month: monthly }
  };
}

function broadcast() {
  if (!state) return;
  const data = 'event: state\\ndata: ' + JSON.stringify(state) + '\\n\\n';
  for (const res of clients) res.write(data);
}

function serveFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/state') return json(res, 200, state || await refreshState());
  if (url.pathname === '/api/refresh') return json(res, 200, await refreshState());
  if (url.pathname.startsWith('/api/stock/')) return json(res, 200, makeStockDetail(decodeURIComponent(url.pathname.split('/').pop())));
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    clients.add(res);
    res.write('event: state\\ndata: ' + JSON.stringify(state || await refreshState()) + '\\n\\n');
    req.on('close', () => clients.delete(res));
    return;
  }
  const requested = (url.pathname === '/' || url.pathname.startsWith('/stock/')) ? '/index.html' : url.pathname;
  const file = path.join(__dirname, 'public', requested.replace(/^\//, ''));
  if (file.startsWith(path.join(__dirname, 'public')) && fs.existsSync(file)) return serveFile(res, file);
  json(res, 404, { error: 'not found' });
});

await refreshState();
setInterval(refreshState, REFRESH_MS);
server.listen(PORT, '127.0.0.1', () => {
  console.log('本地实时看板已启动：http://127.0.0.1:' + PORT + '/');
});
