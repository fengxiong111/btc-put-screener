import fs from "node:fs";

const EAPI = "https://eapi.binance.com";
const SPOT = "https://api.binance.com";

const RULES = {
  dteMin: 3,
  dteMax: 30,
  ivMin: 70,          // %
  vrpMin: 20,         // pp
  ratioMin: 0.70,
  ratioMax: 0.86,
  targetRatio: 0.80,
  deltaMin: 0.04,
  deltaMax: 0.11,
};

function nowISO(){ return new Date().toISOString(); }
function daysBetween(a, b){ return Math.floor((b - a) / 86400000); }
function parseExpiryFromSymbol(sym){
  const m = sym.match(/^[A-Z]+-(\d{6})-\d+-(P|C)$/);
  if(!m) return null;
  const yymmdd = m[1];
  const yy = Number(yymmdd.slice(0,2));
  const mm = Number(yymmdd.slice(2,4));
  const dd = Number(yymmdd.slice(4,6));
  const yyyy = 2000 + yy;
  return new Date(Date.UTC(yyyy, mm-1, dd, 8, 0, 0));
}
async function getJSON(url, headers={}){
  const r = await fetch(url, { headers });
  if(!r.ok) throw new Error(`${r.status} ${r.statusText} url=${url}`);
  return await r.json();
}

async function spotPrice(){
  const j = await getJSON(`${SPOT}/api/v3/ticker/price?symbol=BTCUSDT`);
  return Number(j.price);
}

async function hv7Percent(){
  const end = Date.now();
  const start = end - 7*24*60*60*1000;
  const kl = await getJSON(`${SPOT}/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${start}&endTime=${end}&limit=1000`);
  const closes = kl.map(x => Number(x[4])).filter(x=>x>0);
  const rets = [];
  for(let i=1;i<closes.length;i++) rets.push(Math.log(closes[i]/closes[i-1]));
  const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
  const varr = rets.reduce((a,b)=>a+(b-mean)**2,0)/(rets.length-1);
  const stdev = Math.sqrt(varr);
  const ann = stdev * Math.sqrt(24*365);
  return ann * 100;
}

async function main(){
  const apiKey = process.env.BINANCE_API_KEY; // 可选
  const headers = apiKey ? { "X-MBX-APIKEY": apiKey } : {};

  const ts = nowISO();
  const spot = await spotPrice();
  const hv7 = await hv7Percent();

  const ex = await getJSON(`${EAPI}/eapi/v1/exchangeInfo`, headers);
  const symbols = (ex.optionSymbols || ex.symbols || [])
    .map(s => ({ symbol: s.symbol, strike: Number(s.strikePrice) }))
    .filter(x => x.symbol && Number.isFinite(x.strike));

  const marks = await getJSON(`${EAPI}/eapi/v1/mark`, headers);
  const markMap = new Map(marks.map(m => [m.symbol, m]));

  const today = new Date();
  const out = [];

  for(const s of symbols){
    if(!s.symbol.endsWith("-P")) continue;

    const exp = parseExpiryFromSymbol(s.symbol);
    if(!exp) continue;

    const dte = daysBetween(today, exp);
    if(dte < RULES.dteMin || dte > RULES.dteMax) continue;

    const ratio = s.strike / spot;
    if(ratio < RULES.ratioMin || ratio > RULES.ratioMax) continue;

    const mk = markMap.get(s.symbol);
    if(!mk) continue;

    const iv = Number(mk.markIV) * 100;
    const deltaAbs = Math.abs(Number(mk.delta));
    const vrp = iv - hv7;

    if(!(iv >= RULES.ivMin)) continue;
    if(!(vrp >= RULES.vrpMin)) continue;
    if(!(deltaAbs >= RULES.deltaMin && deltaAbs <= RULES.deltaMax)) continue;

    out.push({
      symbol: s.symbol,
      dte,
      strike: s.strike,
      ratio,
      iv,
      vrp,
      delta: Number(mk.delta),
      markPrice: Number(mk.markPrice),
      score: Math.abs(ratio - RULES.targetRatio),
    });
  }

  out.sort((a,b)=> a.score - b.score);

  const payload = { ts, spot, hv7, rules: RULES, matches: out.slice(0, 60) };

  fs.mkdirSync("data", { recursive:true });
  fs.writeFileSync("data/binance_btc_put_candidates.json", JSON.stringify(payload, null, 2));
  console.log(`ok matches=${payload.matches.length}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
