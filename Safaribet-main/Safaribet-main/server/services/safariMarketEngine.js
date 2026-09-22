'use strict';

// SafariBet-owned bookmaker market engine.
// SofaBets supplies the fixture + base 1X2 prices + result/score data only.
// SafariBet creates the market catalogue and prices here. No provider market
// catalogue, provider market id, or provider market price is copied.

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clampProb(p) { return Math.max(0.0005, Math.min(0.9995, Number(p) || 0)); }
function oddsFromProb(p, margin = 0.065) {
  p = clampProb(p);
  return Math.min(100, Math.max(1.05, Number((1 / (p * (1 + margin))).toFixed(2))));
}

// Long-shot markets such as Correct Score contain extremely small model
// probabilities. A straight 1/p conversion creates four-digit prices that
// are not practical sportsbook prices. SafariBet compresses only these
// long-shot prices and hard-caps every generated price at 100.00.
function longshotOddsFromProb(p, margin = 0.065) {
  p = clampProb(p);
  const raw = 1 / (p * (1 + margin));
  const compressed = 1 + Math.pow(Math.max(0, raw - 1), 0.62);
  return Math.min(100, Math.max(1.05, Number(compressed.toFixed(2))));
}
function poisson(lambda, k) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}
function normalize(ps) {
  const s = ps.reduce((a,b)=>a+b,0) || 1;
  return ps.map(p=>p/s);
}
function addMarket(out, market, label, options) {
  const valid = (options || [])
    .filter(o => Number.isFinite(Number(o.odds)) && Number(o.odds) >= 1.05)
    .map(o => ({ ...o, odds:Number(Number(o.odds).toFixed(2)), bettable:true, generatedMarket:true }));
  if (valid.length >= 1) out.push({ market, label, generatedMarket:true, isSynthetic:true, options:valid });
}
function sumPoisson(lambda, predicate, max=14) {
  let p=0;
  for (let k=0;k<=max;k++) if (predicate(k)) p += poisson(lambda,k);
  return p;
}
function fitFootball(match) {
  const h=num(match?.odds?.home), d=num(match?.odds?.draw), a=num(match?.odds?.away);
  if (!(h>1 && a>1)) return null;
  const raw = normalize([1/h, d>1 ? 1/d : 0, 1/a]);
  const targetH=raw[0], targetD=raw[1], targetA=raw[2];
  let best={err:Infinity,lh:1.45,la:1.15};
  for(let lh=0.35;lh<=3.65;lh+=0.15){
    for(let la=0.35;la<=3.65;la+=0.15){
      let ph=0,pd=0;
      for(let x=0;x<=9;x++) for(let y=0;y<=9;y++){
        const p=poisson(lh,x)*poisson(la,y);
        if(x>y) ph+=p; else if(x===y) pd+=p;
      }
      const pa=Math.max(0,1-ph-pd);
      const err=(ph-targetH)**2+(pd-targetD)**2+(pa-targetA)**2;
      if(err<best.err) best={err,lh,la};
    }
  }
  return best;
}
function footballMarkets(match) {
  const model=fitFootball(match); if(!model) return [];
  const {lh,la}=model, total=lh+la, out=[];
  const [ph,pd,pa]=normalize([1/match.odds.home, match.odds.draw>1?1/match.odds.draw:0, 1/match.odds.away]);
  const home=match.homeTeam, away=match.awayTeam;

  // Main markets.
  addMarket(out,'gen:ft:1x2','Match Result',[
    {pick:'home',pickLabel:home,odds:oddsFromProb(ph)},
    {pick:'draw',pickLabel:'Draw',odds:oddsFromProb(pd)},
    {pick:'away',pickLabel:away,odds:oddsFromProb(pa)}
  ]);
  addMarket(out,'gen:ft:dc','Double Chance',[
    {pick:'dc_1x',pickLabel:`${home} or Draw`,odds:oddsFromProb(ph+pd)},
    {pick:'dc_x2',pickLabel:`Draw or ${away}`,odds:oddsFromProb(pd+pa)},
    {pick:'dc_12',pickLabel:`${home} or ${away}`,odds:oddsFromProb(ph+pa)}
  ]);
  addMarket(out,'gen:ft:dnb','Draw No Bet',[
    {pick:'dnb_home',pickLabel:home,odds:oddsFromProb(ph/(ph+pa))},
    {pick:'dnb_away',pickLabel:away,odds:oddsFromProb(pa/(ph+pa))}
  ]);

  // Goals.
  for(const line of [0.5,1.5,2.5,3.5,4.5,5.5,6.5]){
    const over=sumPoisson(total,k=>k>line,16), under=1-over;
    addMarket(out,`gen:ft:ou:${line}`,`Total Goals ${line}`,[
      {pick:'over',pickLabel:`Over ${line}`,odds:oddsFromProb(over)},
      {pick:'under',pickLabel:`Under ${line}`,odds:oddsFromProb(under)}
    ]);
  }
  addMarket(out,'gen:ft:btts','Both Teams to Score',[
    {pick:'yes',pickLabel:'Yes',odds:oddsFromProb((1-Math.exp(-lh))*(1-Math.exp(-la)))},
    {pick:'no',pickLabel:'No',odds:oddsFromProb(1-(1-Math.exp(-lh))*(1-Math.exp(-la)))}
  ]);
  addMarket(out,'gen:ft:oddeven','Total Goals Odd/Even',[
    {pick:'odd',pickLabel:'Odd',odds:oddsFromProb((1-Math.exp(-2*total))/2)},
    {pick:'even',pickLabel:'Even',odds:oddsFromProb((1+Math.exp(-2*total))/2)}
  ]);
  addMarket(out,'gen:ft:range','Total Goals Range',[
    {pick:'0-1',pickLabel:'0–1 Goals',odds:oddsFromProb(sumPoisson(total,k=>k<=1,16))},
    {pick:'2-3',pickLabel:'2–3 Goals',odds:oddsFromProb(sumPoisson(total,k=>k>=2&&k<=3,16))},
    {pick:'4-5',pickLabel:'4–5 Goals',odds:oddsFromProb(sumPoisson(total,k=>k>=4&&k<=5,16))},
    {pick:'6+',pickLabel:'6+ Goals',odds:oddsFromProb(sumPoisson(total,k=>k>=6,16))}
  ]);

  // Team goals and clean-sheet/win-to-nil markets.
  for(const side of ['home','away']){
    const lambda=side==='home'?lh:la, name=side==='home'?home:away;
    for(const line of [0.5,1.5,2.5,3.5]){
      const over=sumPoisson(lambda,k=>k>line,14);
      addMarket(out,`gen:ft:teamtotal:${side}:${line}`,`${name} Total Goals ${line}`,[
        {pick:'over',pickLabel:`Over ${line}`,odds:oddsFromProb(over)},
        {pick:'under',pickLabel:`Under ${line}`,odds:oddsFromProb(1-over)}
      ]);
    }
    const scoreZero=Math.exp(-lambda);
    const winNil=side==='home'
      ? sumPoisson(lh,x=>x>0,14)*Math.exp(-la)
      : sumPoisson(la,x=>x>0,14)*Math.exp(-lh);
    addMarket(out,`gen:ft:wintonil:${side}`,`${name} to Win to Nil`,[
      {pick:'yes',pickLabel:'Yes',odds:oddsFromProb(winNil)},
      {pick:'no',pickLabel:'No',odds:oddsFromProb(1-winNil)}
    ]);
    addMarket(out,`gen:ft:clean:${side}`,`${name} Clean Sheet`,[
      {pick:'yes',pickLabel:'Yes',odds:oddsFromProb(scoreZero)},
      {pick:'no',pickLabel:'No',odds:oddsFromProb(1-scoreZero)}
    ]);
  }

  // Handicap families generated from the same Poisson model.
  for(const line of [0.5,1.5,2.5,3.5]){
    let homeCover=0, awayCover=0;
    for(let x=0;x<=10;x++) for(let y=0;y<=10;y++){
      const p=poisson(lh,x)*poisson(la,y);
      if(x-y>line) homeCover+=p;
      if(y-x>line) awayCover+=p;
    }
    addMarket(out,`gen:ft:ah:${line}`,`Asian Handicap ${line}`,[
      {pick:'home',pickLabel:`${home} -${line}`,odds:oddsFromProb(homeCover)},
      {pick:'away',pickLabel:`${away} +${line}`,odds:oddsFromProb(1-homeCover)}
    ]);
  }
  for(const line of [1,2,3]){
    const homeP=sumPoisson(total,k=>k===0,16); // replaced below with explicit score loop
    let hw=0,draw=0,aw=0;
    for(let x=0;x<=10;x++) for(let y=0;y<=10;y++){
      const p=poisson(lh,x)*poisson(la,y);
      if(x+line>y) hw+=p; else if(x+line===y) draw+=p; else aw+=p;
    }
    addMarket(out,`gen:ft:eh:${line}`,`European Handicap ${line}`,[
      {pick:'home',pickLabel:`${home} (-${line})`,odds:oddsFromProb(hw)},
      {pick:'draw',pickLabel:'Draw',odds:oddsFromProb(draw)},
      {pick:'away',pickLabel:`${away} (+${line})`,odds:oddsFromProb(aw)}
    ]);
  }

  // Result + goals and result + BTTS combinations.
  const resultTotal=(result,line)=>{
    let p=0;
    for(let x=0;x<=10;x++) for(let y=0;y<=10;y++){
      const r=x>y?'home':x<y?'away':'draw';
      if(r===result && ((line==='over25'&&x+y>2.5)||(line==='under25'&&x+y<2.5))) p+=poisson(lh,x)*poisson(la,y);
    }
    return p;
  };
  addMarket(out,'gen:ft:resultou25','Result + Over/Under 2.5',[
    {pick:'home_over',pickLabel:`${home} & Over 2.5`,odds:oddsFromProb(resultTotal('home','over25'))},
    {pick:'draw_over',pickLabel:'Draw & Over 2.5',odds:oddsFromProb(resultTotal('draw','over25'))},
    {pick:'away_over',pickLabel:`${away} & Over 2.5`,odds:oddsFromProb(resultTotal('away','over25'))},
    {pick:'home_under',pickLabel:`${home} & Under 2.5`,odds:oddsFromProb(resultTotal('home','under25'))},
    {pick:'draw_under',pickLabel:'Draw & Under 2.5',odds:oddsFromProb(resultTotal('draw','under25'))},
    {pick:'away_under',pickLabel:`${away} & Under 2.5`,odds:oddsFromProb(resultTotal('away','under25'))}
  ]);
  const combo=(r,btts)=>{
    let p=0; for(let x=0;x<=10;x++) for(let y=0;y<=10;y++){
      const rr=x>y?'home':x<y?'away':'draw', bb=x>0&&y>0;
      if(rr===r&&bb===btts) p+=poisson(lh,x)*poisson(la,y);
    } return p;
  };
  addMarket(out,'gen:ft:resultbtts','Result + BTTS',[
    {pick:'home_yes',pickLabel:`${home} & BTTS Yes`,odds:oddsFromProb(combo('home',true))},
    {pick:'draw_yes',pickLabel:'Draw & BTTS Yes',odds:oddsFromProb(combo('draw',true))},
    {pick:'away_yes',pickLabel:`${away} & BTTS Yes`,odds:oddsFromProb(combo('away',true))},
    {pick:'home_no',pickLabel:`${home} & BTTS No`,odds:oddsFromProb(combo('home',false))},
    {pick:'draw_no',pickLabel:'Draw & BTTS No',odds:oddsFromProb(combo('draw',false))},
    {pick:'away_no',pickLabel:`${away} & BTTS No`,odds:oddsFromProb(combo('away',false))}
  ]);

  // Correct score and exact total goals.
  const cs=[];
  for(let x=0;x<=5;x++) for(let y=0;y<=5;y++) cs.push({pick:`${x}-${y}`,pickLabel:`${x} - ${y}`,odds:longshotOddsFromProb(poisson(lh,x)*poisson(la,y))});
  addMarket(out,'gen:ft:correctscore','Correct Score',cs);
  addMarket(out,'gen:ft:totalexact','Exact Total Goals',Array.from({length:8},(_,k)=>({pick:String(k),pickLabel:String(k),odds:longshotOddsFromProb(poisson(total,k))})));

  // Winning margin.
  let home1=0,home2=0,home3=0,away1=0,away2=0,away3=0;
  for(let x=0;x<=10;x++) for(let y=0;y<=10;y++){
    const p=poisson(lh,x)*poisson(la,y), diff=x-y;
    if(diff===1) home1+=p; else if(diff===2) home2+=p; else if(diff>=3) home3+=p;
    if(diff===-1) away1+=p; else if(diff===-2) away2+=p; else if(diff<=-3) away3+=p;
  }
  addMarket(out,'gen:ft:margin','Winning Margin',[
    {pick:'home1',pickLabel:`${home} by 1`,odds:oddsFromProb(home1)},
    {pick:'home2',pickLabel:`${home} by 2`,odds:oddsFromProb(home2)},
    {pick:'home3+',pickLabel:`${home} by 3+`,odds:oddsFromProb(home3)},
    {pick:'draw',pickLabel:'Draw',odds:oddsFromProb(pd)},
    {pick:'away1',pickLabel:`${away} by 1`,odds:oddsFromProb(away1)},
    {pick:'away2',pickLabel:`${away} by 2`,odds:oddsFromProb(away2)},
    {pick:'away3+',pickLabel:`${away} by 3+`,odds:oddsFromProb(away3)}
  ]);
  return out;
}

function basketballMarkets(match){
  const h=num(match?.odds?.home),a=num(match?.odds?.away); if(!(h>1&&a>1)) return [];
  const [ph,pa]=normalize([1/h,1/a]), out=[];
  addMarket(out,'gen:bb:winner','Winner',[{pick:'home',pickLabel:match.homeTeam,odds:oddsFromProb(ph)},{pick:'away',pickLabel:match.awayTeam,odds:oddsFromProb(pa)}]);
  const hs=num(match?.score?.home),as=num(match?.score?.away), observed=hs!=null&&as!=null?hs+as:170;
  for(const line of [130.5,140.5,150.5,160.5,170.5,180.5,190.5,200.5,210.5,220.5]){
    const p=1/(1+Math.exp(-((observed-line)/18)));
    addMarket(out,`gen:bb:total:${line}`,`Total Points ${line}`,[{pick:'over',pickLabel:`Over ${line}`,odds:oddsFromProb(p)},{pick:'under',pickLabel:`Under ${line}`,odds:oddsFromProb(1-p)}]);
  }
  for(const line of [2.5,5.5,8.5,11.5,14.5,17.5]){
    const p=1/(1+Math.exp(-((ph-pa)*4-line/15)));
    addMarket(out,`gen:bb:spread:${line}`,`Point Spread ${line}`,[{pick:'home',pickLabel:`${match.homeTeam} -${line}`,odds:oddsFromProb(p)},{pick:'away',pickLabel:`${match.awayTeam} +${line}`,odds:oddsFromProb(1-p)}]);
  }
  for(const side of ['home','away']){
    const name=side==='home'?match.homeTeam:match.awayTeam, base=side==='home'?ph:pa;
    for(const line of [60.5,70.5,80.5,90.5,100.5]){
      const p=1/(1+Math.exp(-((observed/2-line)/15)));
      addMarket(out,`gen:bb:teamtotal:${side}:${line}`,`${name} Total Points ${line}`,[{pick:'over',pickLabel:`Over ${line}`,odds:oddsFromProb(p)},{pick:'under',pickLabel:`Under ${line}`,odds:oddsFromProb(1-p)}]);
    }
  }
  addMarket(out,'gen:bb:oddeven','Total Points Odd/Even',[{pick:'odd',pickLabel:'Odd',odds:oddsFromProb(0.5)},{pick:'even',pickLabel:'Even',odds:oddsFromProb(0.5)}]);
  return out;
}

function tennisMarkets(match){
  const h=num(match?.odds?.home),a=num(match?.odds?.away); if(!(h>1&&a>1)) return [];
  const [ph,pa]=normalize([1/h,1/a]),out=[];
  addMarket(out,'gen:tn:winner','Match Winner',[{pick:'home',pickLabel:match.homeTeam,odds:oddsFromProb(ph)},{pick:'away',pickLabel:match.awayTeam,odds:oddsFromProb(pa)}]);
  const best5=String(match?.league||'').toLowerCase().includes('grand slam');
  const sets=best5?[['3-0',ph*.5],['3-1',ph*.3],['3-2',ph*.2],['0-3',pa*.5],['1-3',pa*.3],['2-3',pa*.2]]:[['2-0',ph*.58],['2-1',ph*.42],['0-2',pa*.58],['1-2',pa*.42]];
  for(const [score,p] of sets) addMarket(out,`gen:tn:sets:${score}`,`Correct Sets ${score}`,[{pick:'exact',pickLabel:score,odds:oddsFromProb(p)}]);
  addMarket(out,'gen:tn:setshandicap','Set Handicap',[{pick:'home',pickLabel:`${match.homeTeam} -1.5 sets`,odds:oddsFromProb(ph*.42)},{pick:'away',pickLabel:`${match.awayTeam} +1.5 sets`,odds:oddsFromProb(1-ph*.42)}]);
  addMarket(out,'gen:tn:totalsets','Total Sets',[{pick:'over2',pickLabel:'Over 2.5 Sets',odds:oddsFromProb(best5?.65:.45)},{pick:'under2',pickLabel:'Under 2.5 Sets',odds:oddsFromProb(best5?.35:.55)}]);
  return out;
}

function sportKey(match){
  const s=String(match?.sport||'').toLowerCase();
  if(s==='football'||s==='soccer'||s.startsWith('soccer_')||s.includes('football')) return 'football';
  if(s.includes('basket')) return 'basketball';
  if(s.includes('tennis')) return 'tennis';
  return s;
}
function generateMarkets(match){
  const sport=sportKey(match);
  if(sport==='football') return footballMarkets(match);
  if(sport==='basketball') return basketballMarkets(match);
  if(sport==='tennis') return tennisMarkets(match);
  const h=num(match?.odds?.home),a=num(match?.odds?.away); if(!(h>1&&a>1)) return [];
  const [ph,pa]=normalize([1/h,1/a]);
  return [{market:'gen:winner',label:'Winner',generatedMarket:true,isSynthetic:true,options:[{pick:'home',pickLabel:match.homeTeam,odds:oddsFromProb(ph),bettable:true},{pick:'away',pickLabel:match.awayTeam,odds:oddsFromProb(pa),bettable:true}]}];
}
function getGeneratedOdds(match,market,pick){
  if(!String(market||'').startsWith('gen:')) return null;
  const mk=generateMarkets(match).find(x=>x.market===market); const opt=mk?.options?.find(x=>String(x.pick)===String(pick));
  return opt?Number(opt.odds):null;
}
module.exports={generateMarkets,getGeneratedOdds};
