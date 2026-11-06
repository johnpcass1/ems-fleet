// @ts-nocheck -- ported from the prototype; behaviour is covered by the e2e run
// Screens: board, dispatch, vehicles, vehicle detail, read-only unit details.
import { RANK, DAY, addDays, daysBetween, gyDate, isComeback, lineCost, woTotal, woWarranty, hoursAt, computeAvailability, toCsv } from '../shared/pure';
import { STATUS, isAvail, isOos, WO_STATUS, WO_KIND, WO_TYPES, PRIO, SEV, ISSUE_ST, HOLD, WO_ACTIVE, REPAIR_CODES } from '../shared/constants';
import { D, LST, ui, S, can, canWo, canPlan, settings, vehiclesSorted, basesSorted, baseName, mechName, unitOf, readingsOf, eventsOf, issuesOf, wosOf, openIssues, prog, hasSample, remH, vsum, remText, coverage, coverageAfterRemoval, coverageEffect, nameOf } from './state';
import { $, $$, esc, num, gyd, fmtDate, fmtDT, todayStr, nowISO, fmtSize, toast, selHtml, field, inp, opt, nv, val, run, uerr } from './util';
import { pill, statusPill, pmPill, kv, baseOpts, vehOpts, statusOpts, loanChip, CLIP, attChip, isImgAtt, thumbStrip } from './bits';
import { VIEWS, VT } from './registry';
import { fileUrl, safeAsset, UP, pending, setProgressHook } from './files';
import { backBtn, routeLabel, route, allowedRoutes } from './nav';

export const emptyFleet=()=>`<div class="empty"><h2>No vehicles yet</h2><p class="muted">Add the first ambulance to start tracking status, service and repairs.</p>
  ${can('editVehicle')?'<button class="btn primary" id="emptyAdd" data-act="add-vehicle">Add vehicle</button>':'<p class="small muted">Ask a fleet manager to add vehicles.</p>'}</div>`;

export function filterVehicles(f){
  const q=(f.q||'').trim().toLowerCase();
  return vehiclesSorted().filter(v=>(!f.base||v.baseId===f.base)&&(!f.status||v.status===f.status)&&(!q||`${v.unit} ${v.plate}`.toLowerCase().includes(q)));
}
export function filterBar(key,{status=true,q=true}={}){
  const f=ui.f[key];
  return `<div class="filters"><div class="f2"><label for="f-${key}-base">Base</label>${selHtml(`f-${key}-base`,baseOpts(true),f.base,`data-filter="${key}.base"`)}</div>
  ${status?`<div class="f2"><label for="f-${key}-status">Status</label>${selHtml(`f-${key}-status`,statusOpts(true),f.status,`data-filter="${key}.status"`)}</div>`:''}
  ${q?`<div class="f2 q"><label for="f-${key}-q">Search unit or plate</label><input type="search" id="f-${key}-q" value="${esc(f.q)}" data-filter="${key}.q" autocomplete="off"></div>`:''}</div>`;
}
export function pmLine(v){
  const s=vsum(v);if(!s.next)return '<span class="muted">No PM program</span>';
  const st=s.next,cls=st.state==='overdue'?'bad':st.state==='due_soon'?'warn':'';
  return `<span>${esc(st.task.name)}</span><b class="${cls}">${esc(remText(st))}</b>`;
}
export function tile(v){
  const s=STATUS[v.status]||{kind:'off',label:v.status},oos=isOos(v.status),open=openIssues(v.id).length;
  const days=oos&&v.statusSince?Math.max(0,daysBetween(v.statusSince,todayStr())):null;
  const sm=vsum(v),st=sm.next,cls=st&&st.state==='overdue'?'bad':st&&st.state==='due_soon'?'warn':'';
  const loan=loanChip(v),mv=can('move',v)&&v.status!=='decommissioned';
  return `<div class="tilew st-${s.kind}"><button type="button" class="tile" data-act="open-vehicle" data-id="${esc(v.id)}" id="tile-${esc(v.id)}">
    <div class="r1"><span class="u">${esc(v.unit)}</span>${statusPill(v.status)}</div>
    <div class="mm">${esc(v.make)} ${esc(v.model)} \u00b7 ${esc(v.plate)}</div>
    ${v.statusReason?`<div class="why">${esc(v.statusReason)}</div>`:''}
    <div class="meta">${days!=null?`<span>Out ${days===0?'today':days+' d'}</span>`:''}${v.expectedReturn?`<span>Back by ${fmtDate(v.expectedReturn)}</span>`:''}<span>${open} open ${open===1?'issue':'issues'}</span></div>
    <div class="pm">${st?`<span>${esc(st.task.name)}</span><b class="${cls}">${esc(remText(st))}</b>`:'<span class="muted">No PM program</span>'}</div></button>
    ${loan||mv?`<div class="tilefoot">${loan}${mv?`<button type="button" class="btn sm" data-act="move-units" data-id="${esc(v.id)}" id="mvbtn-${esc(v.id)}">Move unit</button>`:''}</div>`:''}</div>`;
}
VIEWS.board=function(){
  if(!LST.vehicles.length)return `<div class="vhead"><h1>Service status board</h1></div>`+emptyFleet();
  const f=ui.f.board,all=LST.vehicles;
  const avail=all.filter(v=>isAvail(v.status)).length,oos=all.filter(v=>isOos(v.status)).length;
  const od=all.filter(v=>v.status!=='decommissioned'&&vsum(v).overdue>0).length;
  const odTasks=all.filter(v=>v.status!=='decommissioned').reduce((s,v)=>s+vsum(v).overdue,0);
  const crit=LST.issues.filter(i=>i.severity==='critical'&&(i.status==='open'||i.status==='in_work_order'));
  const vs=filterVehicles(f),groups={};
  vs.forEach(v=>(groups[v.baseId||'']=groups[v.baseId||'']||[]).push(v));
  const order=[...basesSorted().map(b=>b.id),''];
  const gh=order.filter(id=>groups[id]).map(id=>{
    const c=id?coverage(id):null,b=D.bases[id];
    return `<section aria-labelledby="bh-${esc(id||'none')}"><div class="basehead"><h2 id="bh-${esc(id||'none')}">${esc(b?b.name:'Unassigned')}</h2>
      ${c?`<span class="cov${c.low?' low':''}">${c.avail} of ${c.total} available · minimum ${c.min}</span>${c.low?'<span class="chip bad">Below minimum</span>':''}`:''}</div>
      <div class="tiles">${groups[id].map(tile).join('')}</div></section>`;}).join('');
  return `<div class="vhead"><h1>Service status board</h1><div class="row">${can('move')?'<button class="btn" data-act="move-units" id="boardMove">Move units</button>':''}${can('report')?'<button class="btn" data-act="report-issue" id="boardReport">Report a problem</button>':''}</div></div>
  ${crit.length?`<div class="alertbar" role="alert"><b>Critical problem${crit.length>1?'s':''} reported</b><ul style="margin:6px 0 0;padding-left:18px">${crit.map(i=>`<li><button class="btn link" style="color:inherit;text-decoration:underline" data-act="open-vehicle" data-id="${esc(i.vehicleId)}">${esc(unitOf(i.vehicleId))}</button>: ${esc(i.title)} (${fmtDate(i.reportedAt)})</li>`).join('')}</ul></div>`:''}
  <div class="strip">
    <div class="kpi ok"><div class="k">Available</div><div class="v">${avail}</div><div class="s">of ${all.filter(v=>v.status!=='decommissioned').length} units</div></div>
    <div class="kpi ${oos?'bad':''}"><div class="k">Out of service</div><div class="v">${oos}</div><div class="s">repair, service, parts, accident</div></div>
    <div class="kpi ${od?'warn':''}"><div class="k">Overdue PM</div><div class="v">${od}</div><div class="s">${odTasks} overdue ${odTasks===1?'task':'tasks'}</div></div>
    <div class="kpi ${crit.length?'bad':''}"><div class="k">Critical issues</div><div class="v">${crit.length}</div><div class="s">open now</div></div></div>
  ${filterBar('board')}${gh||'<p class="muted">No units match these filters.</p>'}`;
};
VIEWS.dispatch=function(){
  const all=LST.vehicles.filter(v=>v.status!=='decommissioned');
  if(!all.length)return `<div class="wallhead"><h1>Ambulance availability</h1>${allowedRoutes().includes('board')?'<a href="#board">Back to board</a>':''}</div><div class="empty"><h2>No vehicles yet</h2><p class="muted">Units will appear here once they are added.</p></div>`;
  const avail=all.filter(v=>isAvail(v.status)).length;
  const stamps=[...all.map(v=>v.statusSince),...LST.statusEvents.map(e=>e.at),...LST.issues.map(i=>i.reportedAt),...LST.moves.map(m=>m.at)].filter(Boolean).map(Date.parse).filter(Number.isFinite);
  const last=stamps.length?new Date(Math.max(...stamps)).toISOString():null;
  const sec=basesSorted().filter(b=>all.some(v=>v.baseId===b.id)).map(b=>{
    const vs=all.filter(v=>v.baseId===b.id).sort((x,y)=>(isAvail(y.status)-isAvail(x.status))||String(x.unit).localeCompare(String(y.unit),undefined,{numeric:true}));
    const c=coverage(b.id);
    return `<section aria-labelledby="dw-${esc(b.id)}"><div class="basehead"><h2 id="dw-${esc(b.id)}" style="font-size:28px">${esc(b.name)}</h2>
      <span class="cov${c.low?' low':''}" style="font-size:17px">${c.avail} of ${c.total} available${c.low?' · below minimum of '+c.min:''}</span></div>
      <div class="wtiles">${vs.map(v=>{const s=STATUS[v.status]||{kind:'off',label:v.status};
        return `<button type="button" class="wt st-${s.kind}" data-act="open-unit" data-id="${esc(v.id)}"><span class="u">${esc(v.unit)}</span><span class="s">${esc(s.label)}</span>
        ${isAvail(v.status)?(v.statusReason&&v.status!=='reserve'?`<span class="e">${esc(v.statusReason)}</span>`:''):`<span class="e">${esc(v.statusReason||'No reason given')}</span><span class="e"><b>${v.expectedReturn?'Expected back '+fmtDate(v.expectedReturn):'Return date not set'}</b></span>`}
        </button>`;}).join('')}</div></section>`;}).join('');
  return `<div class="wallhead"><h1>Ambulance availability</h1><div class="muted small">Last updated ${last?fmtDT(last):'–'}${allowedRoutes().includes('board')?' · <a href="#board">Back to board</a>':''}</div></div>
  <div class="wsum"><span style="color:var(--ok)">${avail} available</span><span style="color:var(--bad)">${all.length-avail} out of service</span></div>${sec}`;
};
VIEWS.vehicles=function(){
  if(!LST.vehicles.length)return `<div class="vhead"><h1>Vehicles</h1></div>`+emptyFleet();
  const vs=filterVehicles(ui.f.vehicles);
  return `<div class="vhead"><h1>Vehicles</h1>${can('editVehicle')?'<button class="btn primary" data-act="add-vehicle" id="addVehicle">Add vehicle</button>':''}</div>${filterBar('vehicles')}
  <div class="panel" style="padding:0"><div class="tscroll"><table class="t"><thead><tr><th>Unit</th><th>Plate</th><th>Make / model / year</th><th>Base</th><th>Status</th><th class="n">Engine h</th><th class="n">km</th><th>Next PM</th></tr></thead><tbody>
  ${vs.map(v=>`<tr><td><button class="ulink" data-act="open-vehicle" data-id="${esc(v.id)}">${esc(v.unit)}</button></td><td>${esc(v.plate)}</td><td>${esc(v.make)} ${esc(v.model)} ${esc(v.year)}</td><td>${esc(baseName(v.baseId))}</td><td>${statusPill(v.status)}</td>
  <td class="n">${num(v.engineHours)}</td><td class="n">${num(v.odometerKm)}</td><td>${pmLine(v)}</td></tr>`).join('')||'<tr><td colspan="8" class="muted">No units match these filters.</td></tr>'}
  </tbody></table></div></div>`;
};

/* ---- vehicle detail ---- */
export const VTABS=[['overview','Overview'],['pm','PM'],['issues','Issues'],['wos','Work orders'],['history','History'],['costs','Costs']];
VIEWS.vehicle=function(){
  const v=D.vehicles[ui.vehicleId];
  if(!v)return `<div class="vhead"><div>${backBtn()}<h1>Vehicle</h1></div></div><p class="muted">Pick a unit from the <a href="#vehicles">vehicles list</a> or the <a href="#board">board</a>.</p>`;
  const sm=vsum(v);
  return `<div class="vhead"><div>${backBtn()}<div class="row"><h1>${esc(v.unit)}</h1>${statusPill(v.status)}</div>
    <div class="sub">${esc(v.make)} ${esc(v.model)} ${esc(v.year)} · ${esc(baseName(v.baseId))} · ${esc(v.plate)} ${loanChip(v)}</div></div>
    <div class="row">
      ${can('reading',v)?'<button class="btn" data-act="log-hours" id="logHours">Log engine hours</button>':''}
      ${can('report',v)?'<button class="btn" data-act="report-issue" data-id="'+esc(v.id)+'" id="vReport">Report a problem</button>':''}
      ${can('createWO',v)?'<button class="btn" data-act="new-wo" data-id="'+esc(v.id)+'" id="vNewWo">Create work order</button>':''}
      ${can('move',v)&&v.status!=='decommissioned'?'<button class="btn" data-act="move-units" data-id="'+esc(v.id)+'" id="vMove">Move to another base</button>':''}
      ${can('status',v)&&v.status!=='decommissioned'?(isAvail(v.status)?`<button class="btn danger" data-act="change-status" data-to="oos_repair" id="vOut">Take out of service</button>`:`<button class="btn primary" data-act="change-status" data-to="in_service" id="vBack">Return to service</button>`):''}
    </div></div>
  <div class="tabs" role="tablist" aria-label="Vehicle sections">${VTABS.map(([k,l])=>`<button role="tab" id="vt-${k}" type="button" data-act="vtab" data-tab="${k}" aria-selected="${ui.vtab===k}">${l}${k==='pm'&&sm.overdue?` (${sm.overdue})`:''}</button>`).join('')}</div>
  <div role="tabpanel" aria-labelledby="vt-${ui.vtab}">${VT[ui.vtab](v,sm)}</div>`;
};
VT.overview=function(v){
  const oos=isOos(v.status),days=v.statusSince?daysBetween(v.statusSince,todayStr()):0,warrantyOver=v.warrantyEnd&&v.warrantyEnd<todayStr();
  const rs=readingsOf(v.id).slice().reverse().slice(0,8);
  return `<div class="panel"><div class="ph"><h2>Status</h2>${can('status',v)&&v.status!=='decommissioned'?'<button class="btn sm" data-act="change-status" id="vChange">Change status</button>':''}</div>
    <dl class="dl">${kv('Status',statusPill(v.status))}${kv('Since',fmtDate(v.statusSince)+(oos?` (${days} d)`:''))}${kv('Reason',esc(v.statusReason||'–'))}${kv('Expected return',v.expectedReturn?fmtDate(v.expectedReturn):'–')}</dl></div>
  <div class="panel"><div class="ph"><h2>Details</h2>${can('editVehicle')?'<button class="btn sm" data-act="edit-vehicle" id="vEdit">Edit details</button>':''}</div>
    <dl class="dl">${kv('Unit',esc(v.unit))}${kv('Plate',esc(v.plate))}${kv('VIN',esc(v.vin||'–'))}${kv('Make',esc(v.make))}${kv('Model',esc(v.model))}${kv('Year',esc(v.year))}${kv('Type',esc(v.type))}${kv('Base',esc(baseName(v.baseId))+' '+loanChip(v))}
    ${kv('In service since',fmtDate(v.inServiceDate))}${kv('Engine hours',num(v.engineHours)+' h')}${kv('Odometer',num(v.odometerKm)+' km')}${kv('Warranty ends',fmtDate(v.warrantyEnd)+(warrantyOver?' <span class="chip">Expired</span>':''))}
    ${kv('PM program',esc(prog(v)?.name||'None'))}${kv('Notes',esc(v.notes||'–'))}</dl></div>
  <div class="panel"><div class="ph"><h2>Recent meter readings</h2></div><div class="tscroll"><table class="t"><thead><tr><th>When</th><th class="n">Engine h</th><th class="n">km</th><th>Source</th><th>By</th><th></th></tr></thead><tbody>
  ${rs.map(r=>`<tr><td>${fmtDT(r.at)}</td><td class="n">${num(r.hours)}</td><td class="n">${num(r.km)}</td><td>${esc(r.source)}</td><td>${esc(nameOf(r.by))}</td>
  <td>${r.flagged?`<span class="chip warn">Flagged</span> ${can('confirmReading',v)?`<button class="btn sm" data-act="accept-reading" data-id="${esc(r.id)}" id="acc-${esc(r.id)}">Accept</button>`:''}`:''}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">No readings yet.</td></tr>'}</tbody></table></div>
  <p class="tiny muted" style="margin-top:6px">Flagged readings do not change the unit’s hours until a supervisor accepts them.</p></div>`;
};
VT.pm=function(v,sm){
  const intv=t=>[t.intervalHours?t.intervalHours+' h':'',t.intervalDays?t.intervalDays+' d':'',t.intervalKm?num(t.intervalKm)+' km':''].filter(Boolean).join(' / ');
  return `<div class="panel"><div class="ph"><h2>Preventive maintenance</h2>${can('createWO',v)&&sm.due.length?`<button class="btn primary sm" data-act="pm-wo" data-id="${esc(v.id)}" id="vPmWo">Create work order for ${sm.due.length} due ${sm.due.length===1?'task':'tasks'}</button>`:''}</div>
  <p class="small muted">Engine hours now: <b>${num(v.engineHours)} h</b>. Average use: ${sm.rate?num(Math.round(sm.rate*10)/10)+' h/day':'not enough readings'}.</p>
  <div class="tscroll"><table class="t"><thead><tr><th>Task</th><th>Interval</th><th>Last done</th><th>Next due</th><th>Remaining</th><th>Projected</th><th>State</th></tr></thead><tbody>
  ${sm.tasks.slice().sort((a,b)=>RANK[b.state]-RANK[a.state]).map(st=>{const l=v.pm?.[st.task.id];
    return `<tr><td>${esc(st.task.name)}<div class="tiny muted">${esc(st.task.group||'')}</div></td><td>${intv(st.task)}</td>
    <td>${st.never?'Never done':`${l.lastHours!=null?num(l.lastHours)+' h':''} ${l.lastDate?fmtDate(l.lastDate):''}`}</td>
    <td>${[st.nextDueHours!=null?num(st.nextDueHours)+' h':'',st.nextDueDate?fmtDate(st.nextDueDate):'',st.nextDueKm!=null?num(st.nextDueKm)+' km':''].filter(Boolean).join(' / ')||'Now'}</td>
    <td>${esc(remText(st))}</td><td>${st.projected?fmtDate(st.projected):'–'}</td><td>${pmPill(st.state)}</td></tr>`;}).join('')||'<tr><td colspan="7" class="muted">No PM program is set for this unit.</td></tr>'}</tbody></table></div></div>`;
};
export const issueRows=(list,withUnit)=>list.map(i=>`<tr class="stripe sev-${esc(i.severity)}"><td>${withUnit?`<button class="ulink" data-act="open-vehicle" data-id="${esc(i.vehicleId)}">${esc(unitOf(i.vehicleId))}</button><div class="tiny muted">${esc(baseName(D.vehicles[i.vehicleId]?.baseId))}</div>`:fmtDate(i.reportedAt)}</td>
  <td><button class="btn link" data-act="open-issue" data-id="${esc(i.id)}" id="oi-${esc(i.id)}"><b>${esc(i.title)}</b></button>${attChip(i)}<div class="small muted">${esc(i.description||'')}</div>${thumbStrip(i)}</td><td>${pill(i.severity==='critical'?'bad':i.severity==='major'?'warn':'res',SEV[i.severity])}</td>
  <td>${esc(ISSUE_ST[i.status]||i.status)}${i.woId&&D.workOrders[i.woId]?`<div><button class="btn link" data-act="open-wo" data-id="${esc(i.woId)}">${esc(D.workOrders[i.woId].number)}</button></div>`:''}</td>
  <td>${fmtDate(i.reportedAt)}<div class="tiny muted">${esc(nameOf(i.by))}</div></td></tr>`).join('');
VT.issues=function(v){
  const list=issuesOf(v.id).slice().reverse();
  return `<div class="panel" style="padding:0"><div class="tscroll"><table class="t"><thead><tr><th>Date</th><th>Problem</th><th>Severity</th><th>Status</th><th>Reported</th></tr></thead><tbody>${issueRows(list,false)||'<tr><td colspan="5" class="muted">No problems reported for this unit.</td></tr>'}</tbody></table></div></div>`;
};
export const woRows=(list,withUnit)=>list.map(w=>`<tr><td><button class="ulink" data-act="open-wo" data-id="${esc(w.id)}">${esc(w.number)}</button>${isComeback(w,LST.workOrders,settings().comebackDays)?' <span class="chip warn">Comeback</span>':''}${attChip(w)}</td>
  ${withUnit?`<td>${esc(unitOf(w.vehicleId))}</td>`:''}<td>${esc(WO_TYPES[w.type]||w.type)}</td><td>${pill(WO_KIND[w.status],WO_STATUS[w.status])}${w.status==='on_hold'&&w.holdReason?`<div class="tiny muted">${esc(HOLD[w.holdReason])}</div>`:''}</td>
  <td>${esc(PRIO[w.priority])}</td><td>${fmtDate(w.openedAt)}</td><td>${esc(mechName(w.mechanicId))}</td><td class="n">${gyd(woTotal(w))}</td></tr>`).join('');
export const woHead=withUnit=>`<thead><tr><th>Number</th>${withUnit?'<th>Unit</th>':''}<th>Type</th><th>Status</th><th>Priority</th><th>Opened</th><th>Mechanic</th><th class="n">Cost</th></tr></thead>`;
VT.wos=function(v){
  const list=wosOf(v.id).slice().reverse();
  return `<div class="panel" style="padding:0"><div class="tscroll"><table class="t">${woHead(false)}<tbody>${woRows(list,false)||'<tr><td colspan="7" class="muted">No work orders for this unit.</td></tr>'}</tbody></table></div></div>`;
};
VT.history=function(v){
  const items=[];
  eventsOf(v.id).forEach(e=>items.push({at:e.at,kind:'status',title:`${STATUS[e.from]?.label||e.from||'Start'} → ${STATUS[e.to]?.label||e.to}`,detail:e.reason}));
  issuesOf(v.id).forEach(i=>items.push({at:i.reportedAt,kind:'issue',title:`Problem reported: ${i.title}`,detail:`${SEV[i.severity]} · ${ISSUE_ST[i.status]}`}));
  wosOf(v.id).forEach(w=>{items.push({at:w.openedAt,kind:'wo',title:`${w.number} opened`,detail:WO_TYPES[w.type]});if(w.completedAt)items.push({at:w.completedAt,kind:'wo',title:`${w.number} completed`,detail:`${gyd(woTotal(w))}`});});
  readingsOf(v.id).forEach(r=>items.push({at:r.at,kind:'meter',title:`Meter reading ${num(r.hours)} h${r.km!=null?' / '+num(r.km)+' km':''}`,detail:r.flagged?'Flagged, not applied':r.source}));
  LST.moves.filter(m=>m.vehicleId===v.id).forEach(m=>items.push({at:m.at,kind:'move',title:`Moved from ${baseName(m.fromBaseId)} to ${baseName(m.toBaseId)}`,detail:[m.reason,m.tempUntil?'Temporary until '+fmtDate(m.tempUntil):''].filter(Boolean).join(' \u00b7 ')}));
  const f=ui.f.hist,list=items.filter(x=>f==='all'||x.kind===f).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const KL={status:'Status',issue:'Problem',wo:'Work order',meter:'Meter',move:'Moved'};
  return `<div class="panel"><div class="filters"><div class="f2"><label for="f-hist">Show</label>${selHtml('f-hist',[['all','Everything'],['status','Status changes'],['issue','Problems'],['wo','Work orders'],['meter','Meter readings'],['move','Moves']],f,'data-filter="hist"')}</div></div>
  <ul class="tl">${list.map(x=>`<li><div><div class="when">${fmtDT(x.at)}</div><div class="kind">${KL[x.kind]}</div></div><div><b>${esc(x.title)}</b><div class="small muted">${esc(x.detail||'')}</div></div></li>`).join('')||'<li class="muted">Nothing recorded yet.</li>'}</ul></div>`;
};
VT.costs=function(v){
  const yr=Date.now()-365*DAY,tbl=(keyFn,labelFn,keys)=>{
    const m={};
    wosOf(v.id).filter(w=>w.status!=='cancelled').forEach(w=>{const when=Date.parse(w.completedAt||w.openedAt);(w.lines||[]).forEach(l=>{if(l.warranty)return;const k=keyFn(l);m[k]=m[k]||[0,0];const c=lineCost(l);m[k][0]+=c;if(when>=yr)m[k][1]+=c;});});
    const rows=keys.filter(k=>m[k]);const t=[0,0];rows.forEach(k=>{t[0]+=m[k][0];t[1]+=m[k][1];});
    return `<div class="tscroll"><table class="t"><thead><tr><th>${labelFn}</th><th class="n">Lifetime</th><th class="n">Last 12 months</th></tr></thead><tbody>${rows.map(k=>`<tr><td>${esc(k)}</td><td class="n">${gyd(m[k][0])}</td><td class="n">${gyd(m[k][1])}</td></tr>`).join('')||'<tr><td colspan="3" class="muted">No costs recorded.</td></tr>'}
    <tr class="tot"><td>Total</td><td class="n">${gyd(t[0])}</td><td class="n">${gyd(t[1])}</td></tr></tbody></table></div>`;};
  return `<div class="cgrid"><div class="panel"><h2>By repair system</h2>${tbl(l=>l.repairCode||'Other','System',REPAIR_CODES)}</div>
  <div class="panel"><h2>By kind</h2>${tbl(l=>({labor:'Labor',part:'Parts',outside:'Outside work'})[l.kind]||l.kind,'Kind',['Labor','Parts','Outside work'])}</div></div>
  <p class="tiny muted">Warranty lines are not counted. Cancelled work orders are left out.</p>`;
};

/* ---- read-only unit details (dispatch) ---- */
export function unitHtml(v){
  const sm=vsum(v),st=sm.next,open=openIssues(v.id),wos=wosOf(v.id).filter(w=>WO_ACTIVE.includes(w.status)),ev=eventsOf(v.id).slice(-5).reverse();
  return `<div class="row" style="margin-bottom:10px"><h3 style="font-size:26px">${esc(v.unit)}</h3>${statusPill(v.status)}${loanChip(v)}</div>
  <dl class="dl" style="margin-bottom:14px">${kv('Base',esc(baseName(v.baseId)))}${kv('Reason',esc(v.statusReason||'–'))}${kv('Since',fmtDT(v.statusSince))}${kv('Expected return',v.expectedReturn?fmtDate(v.expectedReturn):'–')}
  ${kv('Engine hours',num(v.engineHours)+' h')}${kv('Next PM due',st?esc(st.task.name)+'<br><span class="muted small">'+esc(remText(st))+'</span>':'–')}</dl>
  <h3>Open problems</h3>${open.length?`<ul style="margin:4px 0 12px;padding-left:18px">${open.map(i=>`<li>${esc(i.title)} <span class="muted small">${esc(SEV[i.severity])}</span></li>`).join('')}</ul>`:'<p class="small muted">None.</p>'}
  <h3>Open work orders</h3>${wos.length?`<ul style="margin:4px 0 12px;padding-left:18px">${wos.map(w=>`<li>${esc(w.number)} · ${esc(WO_STATUS[w.status])} · ${esc(mechName(w.mechanicId))}</li>`).join('')}</ul>`:'<p class="small muted">None.</p>'}
  <h3>Recent status history</h3>${ev.length?`<ul style="margin:4px 0 12px;padding-left:18px">${ev.map(e=>`<li>${fmtDate(e.at)}: ${esc(STATUS[e.from]?.label||e.from||'Start')} → ${esc(STATUS[e.to]?.label||e.to)}${e.reason?` <span class="muted small">(${esc(e.reason)})</span>`:''}</li>`).join('')}</ul>`:'<p class="small muted">No changes recorded.</p>'}
  ${allowedRoutes().includes('vehicle')?`<div class="dfoot"><a class="btn primary" href="#vehicle" data-act="open-full" data-id="${esc(v.id)}" id="openFull">Open full record →</a></div>`:''}`;
}
