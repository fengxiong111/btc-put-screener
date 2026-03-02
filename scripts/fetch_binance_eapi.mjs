import fs from "node:fs";

const BASE = "https://www.deribit.com/api/v2";

const RULES = {
  dteMin: 3,
  dteMax: 30,

  hv7Max: 65,        // 超过直接不卖（硬红灯）

  ivMin: 70,         // %
  ratioMin: 0.70,
  ratioMax: 0.86,
  targetRatio: 0.80,

  deltaMin: 0.04,
  deltaMax: 0.09,    // 收紧
};

function nowISO(){ return new Date().toISOString(); }
function daysBetween(a, b){ return Math.floor((b - a) / 86400000); }

async function getJSON(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(`${r.status} ${r.statusText} url=${url}`);
  return await r.json();
}

async function spotPrice(){
  const j = await getJSON(`${BASE}/public/get_index_price?index_name=btc_usd`);
  return Number(j.result.index_price);
}

// 用 Deribit 1H K线算 7日年化波动
async function hv7Percent(){
  const end = Date.now();
  const start = end - 7*24*60*60*1000;

  const url = `${BASE}/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=${start}&end_timestamp=${end}&resolution=60`;
  const j = await getJSON(url);

  const closes = (j.result?.close || []).map(Number).filter(x => x > 0);
  if(closes.length < 50) throw new Error("Not enough data for HV7");

  const rets = [];
  for(let i=1;i<closes.length;i++){
    rets.push(Math.log(closes[i] / closes[i-1]));
  }

  const mean = rets.reduce((a,b)=>a+b,0) / rets.length;
  const variance = rets.reduce((a,b)=>a+(b-mean)**2,0)/(rets.length-1);
  const stdev = Math.sqrt(variance);

  return stdev * Math.sqrt(24*365) * 100;
}

async function mapLimit(arr, limit, fn){
  const ret = [];
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async ()=>{
    while(true){
      const idx = i++;
      if(idx >= arr.length) break;
      ret[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

async function main(){

  const ts = nowISO();
  const spot = await spotPrice();
  const hv7 = await hv7Percent();

  // -------- 动态 VRP 规则 --------
  let vrpMin = 20;
  if(hv7 > 60) vrpMin = 22;

  // -------- 硬红灯 --------
  if(hv7 > RULES.hv7Max){
    const payload = {
      ts,
      spot,
      hv7,
      vrpMin,
      rules: RULES,
      matches: [],
      note: `HV7=${hv7.toFixed(1)} > ${RULES.hv7Max}：禁止开仓`,
    };

    fs.mkdirSync("data",{recursive:true});
    fs.writeFileSync("data/binance_btc_put_candidates.json", JSON.stringify(payload,null,2));
    console.log(payload.note);
    return;
  }

  const instRes = await getJSON(`${BASE}/public/get_instruments?currency=BTC&kind=option&expired=false`);
  const puts = instRes.result.filter(i => i.option_type === "put");

  const today = new Date();

  const preFiltered = puts
    .map(i=>{
      const exp = new Date(i.expiration_timestamp);
      const dte = daysBetween(today, exp);
      const ratio = i.strike / spot;
      return {i,dte,ratio};
    })
    .filter(x =>
      x.dte >= RULES.dteMin &&
      x.dte <= RULES.dteMax &&
      x.ratio >= RULES.ratioMin &&
      x.ratio <= RULES.ratioMax
    );

  const rows = await mapLimit(preFiltered, 10, async (x)=>{
    const name = x.i.instrument_name;
    const t = await getJSON(`${BASE}/public/ticker?instrument_name=${encodeURIComponent(name)}`);

    const iv = Number(t.result.mark_iv);
    const delta = Number(t.result.greeks?.delta);
    const deltaAbs = Math.abs(delta);
    const vrp = iv - hv7;

    if(!(iv >= RULES.ivMin)) return null;
    if(!(vrp >= vrpMin)) return null;
    if(!(deltaAbs >= RULES.deltaMin && deltaAbs <= RULES.deltaMax)) return null;

    return {
      symbol: name,
      dte: x.dte,
      strike: Number(x.i.strike),
      ratio: x.ratio,
      iv,
      vrp,
      delta,
      markPrice: Number(t.result.mark_price),
      score: Math.abs(x.ratio - RULES.targetRatio)
    };
  });

  const out = rows.filter(Boolean).sort((a,b)=>a.score-b.score).slice(0,60);

  const payload = {
    ts,
    spot,
    hv7,
    vrpMin,
    rules: RULES,
    matches: out
  };

  fs.mkdirSync("data",{recursive:true});
  fs.writeFileSync("data/binance_btc_put_candidates.json", JSON.stringify(payload,null,2));

  console.log(`ok matches=${out.length} hv7=${hv7} vrpMin=${vrpMin}`);
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});