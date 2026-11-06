// @ts-nocheck -- ported verbatim from the prototype (checked for undefined names; behaviour is covered by npm run e2e)
// Screens: reports (with CSV export) and setup.
import { RANK, DAY, addDays, daysBetween, gyDate, isComeback, lineCost, woTotal, woWarranty, hoursAt, computeAvailability, toCsv } from '../shared/pure';
import { STATUS, isAvail, isOos, WO_STATUS, WO_KIND, WO_TYPES, PRIO, SEV, ISSUE_ST, HOLD, WO_ACTIVE, REPAIR_CODES } from '../shared/constants';
import { D, LST, ui, S, can, canWo, canPlan, settings, vehiclesSorted, basesSorted, baseName, mechName, unitOf, readingsOf, eventsOf, issuesOf, wosOf, openIssues, prog, hasSample, remH, vsum, remText, coverage, coverageAfterRemoval, coverageEffect, nameOf } from './state';
import { $, $$, esc, num, gyd, fmtDate, fmtDT, todayStr, nowISO, fmtSize, toast, selHtml, field, inp, opt, nv, val, run, uerr } from './util';
import { pill, statusPill, pmPill, kv, baseOpts, vehOpts, statusOpts, loanChip, CLIP, attChip, isImgAtt, thumbStrip, pageHead } from './bits';
import { icon } from './icons';
import { VIEWS, VT } from './registry';
import { fileUrl, safeAsset, UP, pending, setProgressHook } from './files';
import { backBtn, routeLabel, route, allowedRoutes } from './nav';


/* ===== VIEWS C: reports, setup ===== */
export let CSV:Record<string,any>={};
const csvBtn=(key:string,filename:string,rows:any[][])=>{CSV[key]={filename,rows};return `<button class="btn sm" type="button" data-act="export-csv" data-key="${key}" data-csv id="csv-${key}">${icon('download')}Export CSV</button>`;};
function barChart(items,{fmt=num,cls=''}={}){
  if(!items.length||items.every(i=>!i.value))return '<p class="muted small">Nothing to show for this period.</p>';
  const max=Math.max(...items.map(i=>i.value),1),rowH=34,W=360,H=items.length*rowH;
  const grid=[0,.5,1].map(f=>`<line class="gl" x1="${f*W}" x2="${f*W}" y1="0" y2="${H}"/>`).join('');
  const rows=items.map((it,k)=>{const y=k*rowH,w=it.value>0?Math.max(2,W*it.value/max):0,lab=String(it.label).length>36?String(it.label).slice(0,35)+'…':it.label;
    return `<g><text x="0" y="${y+12}">${esc(lab)}</text><text class="v" x="${W}" y="${y+12}">${esc(fmt(it.value))}</text><rect class="bg" x="0" y="${y+20}" width="${W}" height="6" rx="1"/><rect class="b ${it.cls||cls}" x="0" y="${y+20}" width="${w}" height="6" rx="1"/></g>`;}).join('');
  return `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart: ${esc(items.map(i=>i.label+' '+fmt(i.value)).join(', '))}">${grid}${rows}</svg>`;
}
function hoursRun(v,startMs){
  const rs=readingsOf(v.id);
  const h0=(v.inServiceDate&&Date.parse(v.inServiceDate)>startMs)?0:hoursAt(rs,startMs);
  if(h0==null)return null;
  return Math.max(0,(v.engineHours||0)-h0);
}
const costWhen=w=>Date.parse(w.completedAt||w.openedAt);
const dayTxt=n=>(Math.round(n*10)/10).toLocaleString('en-US')+' d';
VIEWS.reports=function(){
  CSV={};
  const days=ui.period,now=Date.now(),start=now-days*DAY,yr=now-365*DAY;
  const S=settings();
  const av=computeAvailability(LST.vehicles,LST.statusEvents,start,now);
  const done=w=>['completed','closed'].includes(w.status)&&w.completedAt;
  const pmDone=LST.workOrders.filter(w=>w.type==='preventive'&&done(w)&&Date.parse(w.completedAt)>=start);
  const onTime=pmDone.filter(w=>!(w.overdueAtOpen>0)).length;
  const overdueNow=LST.vehicles.filter(v=>v.status!=='decommissioned').reduce((s,v)=>s+vsum(v).overdue,0);
  const rep=LST.workOrders.filter(w=>w.type!=='preventive'&&done(w)&&Date.parse(w.completedAt)>=start&&w.openedAt);
  const mttr=rep.length?rep.reduce((s,w)=>s+(Date.parse(w.completedAt)-Date.parse(w.openedAt))/36e5,0)/rep.length:null;
  /* hold time by reason */
  const hold={};
  LST.workOrders.forEach(w=>(w.holdLog||[]).forEach(h=>{const a=Math.max(Date.parse(h.from),start),b=Math.min(h.to?Date.parse(h.to):now,now);if(b>a)hold[h.reason]=(hold[h.reason]||0)+(b-a)/DAY;}));
  const holdItems=Object.keys(HOLD).map(k=>({label:HOLD[k],value:Math.round((hold[k]||0)*10)/10,cls:k==='parts'?'warn':k==='approval'?'res':''}));
  /* backlog */
  const bands=[['0-7 days',0,8],['8-30 days',8,31],['31+ days',31,1e9]];
  const act=LST.workOrders.filter(w=>WO_ACTIVE.includes(w.status));
  const bl=bands.map(([l,a,b])=>({label:l,value:act.filter(w=>{const d=(now-Date.parse(w.openedAt))/DAY;return d>=a&&d<b;}).length,cls:l.startsWith('31')?'bad':l.startsWith('8')?'warn':''}));
  /* costs in period */
  const inP=LST.workOrders.filter(w=>w.status!=='cancelled'&&costWhen(w)>=start);
  const perV=LST.vehicles.map(v=>{const c=inP.filter(w=>w.vehicleId===v.id).reduce((s,w)=>s+woTotal(w),0),h=hoursRun(v,start);return{v,c,h,ph:h>0?c/h:null};}).sort((a,b)=>b.c-a.c);
  const mechSp={},sysSp={};
  inP.forEach(w=>{mechSp[w.mechanicId||'']=(mechSp[w.mechanicId||'']||0)+woTotal(w);(w.lines||[]).forEach(l=>{if(!l.warranty)sysSp[l.repairCode||'Other']=(sysSp[l.repairCode||'Other']||0)+lineCost(l);});});
  const mechItems=Object.entries(mechSp).map(([id,v])=>({label:mechName(id||null),value:v})).sort((a,b)=>b.value-a.value);
  const sysItems=Object.entries(sysSp).map(([k,v])=>({label:k,value:v})).sort((a,b)=>b.value-a.value);
  /* parts usage */
  const pu={};
  LST.workOrders.filter(w=>done(w)&&Date.parse(w.completedAt)>=start).forEach(w=>(w.lines||[]).forEach(l=>{if(l.kind!=='part')return;const k=l.partId||l.description;pu[k]=pu[k]||{d:l.description,q:0,c:0};pu[k].q+=Number(l.qty)||0;pu[k].c+=l.warranty?0:lineCost(l);}));
  const puRows=Object.values(pu).sort((a,b)=>b.c-a.c);
  /* replacement candidates */
  const cand=LST.vehicles.filter(v=>v.status!=='decommissioned').map(v=>{
    const c=LST.workOrders.filter(w=>w.vehicleId===v.id&&w.status!=='cancelled'&&costWhen(w)>=yr).reduce((s,w)=>s+woTotal(w),0),h=hoursRun(v,yr);
    const cb=LST.workOrders.filter(w=>w.vehicleId===v.id&&isComeback(w,LST.workOrders,S.comebackDays)).length;
    return{v,c,h,ph:h>0?c/h:null,cb};});
  const top=cand.filter(x=>x.ph!=null&&x.c>0).sort((a,b)=>b.ph-a.ph).slice(0,5);
  const extra=cand.filter(x=>x.cb>=3&&!top.includes(x));
  const cands=[...top,...extra];
  const kpi=(k,v,s,def,cls='')=>`<div class="kpi ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div><div class="def">${def}</div></div>`;
  const aPct=av.pct==null?'–':(Math.round(av.pct*10)/10)+'%';
  const mtt=mttr==null?'–':(mttr>=48?(Math.round(mttr/24*10)/10)+' d':(Math.round(mttr*10)/10)+' h');
  const rowsPv=[['Unit','Base','Cost (G$)','Engine hours run','Cost per engine hour (G$)'],...perV.map(x=>[x.v.unit,baseName(x.v.baseId),Math.round(x.c),x.h!=null?Math.round(x.h):'',x.ph!=null?Math.round(x.ph):''])];
  const rowsMech=[['Mechanic','Spend (G$)'],...mechItems.map(i=>[i.label,Math.round(i.value)])];
  const rowsSys=[['Repair system','Spend (G$)'],...sysItems.map(i=>[i.label,Math.round(i.value)])];
  const rowsPu=[['Part','Quantity','Cost (G$)'],...puRows.map(p=>[p.d,p.q,Math.round(p.c)])];
  const rowsCand=[['Unit','Base','Cost last 365 days (G$)','Cost per engine hour (G$)','Comebacks'],...cands.map(x=>[x.v.unit,baseName(x.v.baseId),Math.round(x.c),x.ph!=null?Math.round(x.ph):'',x.cb])];
  const rowsHold=[['Hold reason','Days'],...holdItems.map(i=>[i.label,i.value])];
  const rowsBl=[['Age band','Open work orders'],...bl.map(i=>[i.label,i.value])];
  return `${pageHead('Reports')}
  <div class="filters"><div class="f2 fix"><label for="f-period">Period</label>${selHtml('f-period',[[30,'Last 30 days'],[90,'Last 90 days'],[365,'Last 365 days']],days,'data-filter="period"')}</div></div>
  <div class="kpis panel">
    ${kpi('Fleet availability',aPct,`last ${days} days`,'Share of unit-time spent in service, limited or reserve. Decommissioned time is left out.',av.pct!=null&&av.pct<85?'warn':'ok')}
    ${kpi('PM on-time rate',pmDone.length?Math.round(onTime/pmDone.length*100)+'%':'–',`${onTime} of ${pmDone.length} PM jobs`,'PM work orders completed in the period where no task was overdue when the job was opened.')}
    ${kpi('Overdue PM now',overdueNow,'tasks across the fleet','PM tasks that have passed their due hours, date or km.',overdueNow?'bad':'ok')}
    ${kpi('Mean time to repair',mtt,`${rep.length} repairs`,'Average time from opening to completing a corrective, accident, warranty or inspection work order.')}</div>
  <div class="cgrid">
    <div class="panel"><div class="ph"><h2>Downtime by hold reason</h2>${csvBtn('hold','hold-time-by-reason.csv',rowsHold)}</div><div class="pb"><p class="small muted">Days work orders spent on hold in the period.</p>${barChart(holdItems,{fmt:dayTxt})}</div></div>
    <div class="panel"><div class="ph"><h2>Work order backlog by age</h2>${csvBtn('backlog','backlog-by-age.csv',rowsBl)}</div><div class="pb"><p class="small muted">Work orders not yet completed, by days since opened.</p>${barChart(bl)}</div></div>
    <div class="panel"><div class="ph"><h2>Spend by mechanic</h2>${csvBtn('mech','spend-by-mechanic.csv',rowsMech)}</div><div class="pb">${barChart(mechItems,{fmt:gyd})}</div></div>
    <div class="panel"><div class="ph"><h2>Spend by repair system</h2>${csvBtn('sys','spend-by-system.csv',rowsSys)}</div><div class="pb">${barChart(sysItems,{fmt:gyd})}</div></div></div>
  <div class="panel"><div class="ph"><h2>Cost per vehicle</h2>${csvBtn('veh','cost-per-vehicle.csv',rowsPv)}</div>
    <div class="pn small muted">Work order cost in the period (warranty lines excluded). Engine hours run come from meter readings and are estimated where readings do not reach back to the start of the period.</div>
    <div class="tscroll"><table class="t"><thead><tr><th>Unit</th><th>Base</th><th class="n">Cost</th><th class="n">Engine h run</th><th class="n">Cost per engine h</th></tr></thead><tbody>
    ${perV.map(x=>`<tr><td><button class="ulink" data-act="open-vehicle" data-id="${esc(x.v.id)}">${esc(x.v.unit)}</button></td><td>${esc(baseName(x.v.baseId))}</td><td class="n">${gyd(x.c)}</td><td class="n">${x.h!=null?num(Math.round(x.h)):'–'}</td><td class="n">${x.ph!=null?gyd(x.ph):'–'}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="cgrid">
  <div class="panel"><div class="ph"><h2>Parts usage</h2>${csvBtn('parts','parts-usage.csv',rowsPu)}</div><div class="tscroll"><table class="t"><thead><tr><th>Part</th><th class="n">Qty</th><th class="n">Cost</th></tr></thead><tbody>
    ${puRows.map(p=>`<tr><td>${esc(p.d)}</td><td class="n">${num(p.q)}</td><td class="n">${gyd(p.c)}</td></tr>`).join('')||'<tr><td colspan="3" class="muted">No parts used in this period.</td></tr>'}</tbody></table></div></div>
  <div class="panel"><div class="ph"><h2>Replacement candidates</h2>${csvBtn('cand','replacement-candidates.csv',rowsCand)}</div><div class="pn small muted">Top 5 units by cost per engine hour over the last 365 days, plus any unit with 3 or more comebacks.</div>
    <div class="tscroll"><table class="t"><thead><tr><th>Unit</th><th class="n">Cost, 365 d</th><th class="n">Per engine h</th><th class="n">Comebacks</th></tr></thead><tbody>
    ${cands.map(x=>`<tr><td><button class="ulink" data-act="open-vehicle" data-id="${esc(x.v.id)}">${esc(x.v.unit)}</button></td><td class="n">${gyd(x.c)}</td><td class="n">${x.ph!=null?gyd(x.ph):'–'}</td><td class="n">${x.cb}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">No candidates yet.</td></tr>'}</tbody></table></div></div></div>`;
};

/* ---- setup ---- */
VIEWS.setup=function(){
  const S=settings(),m=can('setup');
  const rd=m?'':'disabled';
  return `${pageHead('Setup',{sub:m?'':'Only a fleet manager can change setup. You are viewing it read-only.'})}
  <div class="panel"><div class="ph"><h2>Bases</h2>${m?'<button class="btn sm" data-act="add-base" id="addBase">'+icon('plus')+'Add base</button>':''}</div>
  <div class="tscroll"><table class="t"><thead><tr><th>Base</th><th>Region</th><th class="n">Minimum units</th><th class="n">Units</th><th></th></tr></thead><tbody>
  ${basesSorted().map(b=>`<tr><td><b>${esc(b.name)}</b></td><td>${esc(b.region)}</td><td class="n">${num(b.minUnits)}</td><td class="n">${LST.vehicles.filter(v=>v.baseId===b.id).length}</td><td class="c-act">${m?`<button class="btn sm ghost" data-act="edit-base" data-id="${esc(b.id)}" id="eb-${esc(b.id)}">Edit</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">No bases yet.</td></tr>'}</tbody></table></div></div>
  <div class="panel"><div class="ph"><h2>PM programs</h2>${m?'<button class="btn sm" data-act="add-program" id="addProg">'+icon('plus')+'Add program</button>':''}</div>
  <div class="pn small muted">Confirm intervals with the manufacturer’s schedule. The intervals here are examples only.</div>
  ${LST.pmPrograms.map(p=>`<div class="subpanel"><div class="ph sub"><h3>${esc(p.name)} <span class="muted small">for ${esc(p.appliesTo||'all units')}</span></h3>${m?`<button class="btn sm" data-act="edit-program" data-id="${esc(p.id)}" id="ep-${esc(p.id)}">Edit tasks</button>`:''}</div>
  <div class="tscroll"><table class="t"><thead><tr><th>Task</th><th>Group</th><th class="n">Hours</th><th class="n">Days</th><th class="n">km</th></tr></thead><tbody>${(p.tasks||[]).map(t=>`<tr><td>${esc(t.name)}</td><td>${esc(t.group)}</td><td class="n">${num(t.intervalHours)}</td><td class="n">${num(t.intervalDays)}</td><td class="n">${num(t.intervalKm)}</td></tr>`).join('')}</tbody></table></div></div>`).join('')||'<p class="muted pb">No PM programs yet.</p>'}</div>
  <div class="panel"><div class="ph"><h2>Settings</h2></div><form data-form="settings" id="settingsForm" class="pb" novalidate><div class="fgrid">
    ${field('Approval threshold (G$)',inp('st-thr',S.approvalThresholdGYD,'number',`min="0" step="1000" ${rd}`),'Work orders at or above this need fleet manager approval.')}
    ${field('Due soon window, hours',inp('st-h',S.dueSoonHours,'number',`min="0" ${rd}`))}${field('Due soon window, days',inp('st-d',S.dueSoonDays,'number',`min="0" ${rd}`))}
    ${field('Comeback window, days',inp('st-cb',S.comebackDays,'number',`min="0" ${rd}`),'A repeat repair of the same system within this many days is a comeback.')}</div>
    ${m?'<button class="btn primary" type="submit" id="st-save">Save settings</button>':''}</form></div>
  <div class="panel"><div class="ph"><h2>Sample data</h2></div><div class="pb"><p class="small muted">Demo records, if any were loaded when the app was set up, are marked as sample data and can be removed in one step. Records you add yourself are never touched.</p>
  ${m?`<div class="row"><button class="btn danger" data-act="remove-sample" id="removeSample" ${hasSample()?'':'disabled'}>Remove sample data</button></div>`:'<p class="small muted">Fleet managers can remove sample data.</p>'}
  ${hasSample()?'<p class="small" style="margin:8px 0 0"><span class="badge">Sample data</span> is present.</p>':''}</div></div>`;
};
