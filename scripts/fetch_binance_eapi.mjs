import fs from "node:fs";

const BASE = "https://www.deribit.com/api/v2";

const RULES = {
  dteMin: 12,
  dteMax: 25,

  hvMax: 70,

  deltaMin: 0.05,
  deltaMax: 0.09
};

function nowISO(){ return new Date().toISOString(); }
function daysBetween(a,b){ return Math.floor((b-a)/86400000); }

async function getJSON(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(`${r.status} ${url}`);
  return await r.json();
}

async function spot(){
  const j = await getJSON(`${BASE}/public/get_index_price?index_name=btc_usd`);
  return j.result.index_price;
}

async function hv7(){
  const end = Date.now();
  const start = end - 7*24*60*60*1000;

  const j = await getJSON(
    `${BASE}/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=${start}&end_timestamp=${end}&resolution=60`
  );

  const closes = j.result.close;
  const rets=[];
  for(let i=1;i<closes.length;i++){
    rets.push(Math.log(closes[i]/closes[i-1]));
  }

  const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
  const variance = rets.reduce((a,b)=>a+(b-mean)**2,0)/(rets.length-1);
  const stdev = Math.sqrt(variance);

  return stdev*Math.sqrt(24*365)*100;
}

async function main(){

  const ts = nowISO();
  const spotPrice = await spot();
  const hv = await hv7();

  // 红灯
  if(hv > RULES.hvMax){
    writeOut(ts, spotPrice, hv, []);
    return;
  }

  // 动态 VRP
  let vrpMin = 12;
  if(hv > 60) vrpMin = 15;

  const inst = await getJSON(
    `${BASE}/public/get_instruments?currency=BTC&kind=option&expired=false`
  );

  const options = inst.result;
  const today = new Date();

  const candidates = [];

  for(const o of options){

    const exp = new Date(o.expiration_timestamp);
    const dte = daysBetween(today,exp);
    if(dte < RULES.dteMin || dte > RULES.dteMax) continue;

    const ticker = await getJSON(
      `${BASE}/public/ticker?instrument_name=${o.instrument_name}`
    );

    const iv = ticker.result.mark_iv;
    const delta = Math.abs(ticker.result.greeks.delta);
    const vrp = iv - hv;

    if(delta < RULES.deltaMin || delta > RULES.deltaMax) continue;
    if(vrp < vrpMin) continue;

    candidates.push({
      strike: o.strike,
      dte,
      score: Math.abs(delta - 0.06)
    });
  }

  // 只输出一个最优
  candidates.sort((a,b)=>a.score-b.score);
  const best = candidates.length ? [candidates[0]] : [];

  writeOut(ts, spotPrice, hv, best);
}

function writeOut(ts, spot, hv, matches){

  const payload = {
    ts,
    spot,
    hv7: hv,
    matches
  };

  fs.mkdirSync("data",{recursive:true});
  fs.writeFileSync(
    "data/binance_btc_put_candidates.json",
    JSON.stringify(payload,null,2)
  );

  console.log("done", matches.length);
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});