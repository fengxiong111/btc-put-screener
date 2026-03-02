import fs from "node:fs";

const BASE = "https://www.deribit.com/api/v2";

const RULES = {
  dteMin: 3,
  dteMax: 30,
  ivMin: 70,
  vrpMin: 20,
  ratioMin: 0.70,
  ratioMax: 0.86,
  targetRatio: 0.80,
  deltaMin: 0.04,
  deltaMax: 0.11,
};

function nowISO(){ return new Date().toISOString(); }
function daysBetween(a, b){ return Math.floor((b - a) / 86400000); }

async function getJSON(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(`${r.status} ${url}`);
  return await r.json();
}

async function main(){

  const ts = nowISO();

  // 现价
  const priceRes = await getJSON(`${BASE}/public/get_index_price?index_name=btc_usd`);
  const spot = priceRes.result.index_price;

  // 近 7 天年化波动
  const volRes = await getJSON(`${BASE}/public/get_volatility_index_data?currency=BTC&resolution=60`);
  const hv7 = volRes.result.data.slice(-24*7).reduce((a,b)=>a+b[4],0)/(24*7);

  // 全部期权
  const instRes = await getJSON(`${BASE}/public/get_instruments?currency=BTC&kind=option&expired=false`);
  const instruments = instRes.result.filter(i => i.option_type === "put");

  const out = [];
  const today = new Date();

  for(const i of instruments){

    const exp = new Date(i.expiration_timestamp);
    const dte = daysBetween(today, exp);
    if(dte < RULES.dteMin || dte > RULES.dteMax) continue;

    const ratio = i.strike / spot;
    if(ratio < RULES.ratioMin || ratio > RULES.ratioMax) continue;

    const ticker = await getJSON(`${BASE}/public/ticker?instrument_name=${i.instrument_name}`);
    const iv = ticker.result.mark_iv;
    const deltaAbs = Math.abs(ticker.result.greeks.delta);
    const vrp = iv - hv7;

    if(iv < RULES.ivMin) continue;
    if(vrp < RULES.vrpMin) continue;
    if(deltaAbs < RULES.deltaMin || deltaAbs > RULES.deltaMax) continue;

    out.push({
      symbol: i.instrument_name,
      dte,
      strike: i.strike,
      ratio,
      iv,
      vrp,
      delta: ticker.result.greeks.delta,
      markPrice: ticker.result.mark_price,
      score: Math.abs(ratio - RULES.targetRatio)
    });
  }

  out.sort((a,b)=>a.score-b.score);

  const payload = {
    ts,
    spot,
    hv7,
    rules: RULES,
    matches: out.slice(0,50)
  };

  fs.mkdirSync("data",{recursive:true});
  fs.writeFileSync("data/binance_btc_put_candidates.json",
    JSON.stringify(payload,null,2));

  console.log("ok matches="+payload.matches.length);
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});