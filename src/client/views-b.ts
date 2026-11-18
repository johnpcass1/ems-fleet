// @ts-nocheck -- ported verbatim from the prototype (checked for undefined names; behaviour is covered by npm run e2e)
// Screens: PM queue, issues, work orders, parts and mechanics, plus the issue / work order detail HTML.
import { RANK, DAY, addDays, daysBetween, gyDate, isComeback, lineCost, woTotal, woWarranty, hoursAt, computeAvailability, toCsv } from '../shared/pure';
import { STATUS, isAvail, isOos, WO_STATUS, WO_KIND, WO_TYPES, PRIO, SEV, ISSUE_ST, HOLD, WO_ACTIVE, REPAIR_CODES } from '../shared/constants';
import { D, LST, ui, S, can, canWo, canPlan, settings, uploadsOn, uploadState, vehiclesSorted, basesSorted, baseName, mechName, unitOf, readingsOf, eventsOf, issuesOf, wosOf, openIssues, prog, hasSample, remH, vsum, remText, coverage, coverageAfterRemoval, coverageEffect, nameOf } from './state';
import { $, $$, esc, num, gyd, cur, moneyStep, fmtDate, fmtDT, todayStr, nowISO, fmtSize, toast, selHtml, field, inp, opt, nv, val, run, uerr } from './util';
import { pill, statusPill, pmPill, kv, baseOpts, vehOpts, statusOpts, loanChip, CLIP, attChip, isImgAtt, thumbStrip, pageHead, actBtn, emptyState } from './bits';
import { icon } from './icons';
import { VIEWS, VT } from './registry';
import { fileUrl, safeAsset, UP, pending, setProgressHook, normalizeFile, fileType } from './files';
import { woHead, woRows } from './views-a';
import { isDemo } from './demo';
import { backBtn, routeLabel, route, allowedRoutes } from './nav';


/* ===== VIEWS B: PM, issues, work orders, parts & mechanics ===== */
export const baseOfV=id=>D.vehicles[id]?.baseId||'';
VIEWS.pm=function(){
  const f=ui.f.pm,rows=[];
  LST.vehicles.filter(v=>v.status!=='decommissioned'&&(!f.base||v.baseId===f.base)).forEach(v=>{const sm=vsum(v);sm.due.forEach(st=>rows.push({v,st,rate:sm.rate}));});
  rows.sort((a,b)=>(RANK[b.st.state]-RANK[a.st.state])||((remH(a.st,a.rate)??1e9)-(remH(b.st,b.rate)??1e9)));
  const since=Date.now()-90*DAY;
  const comp=basesSorted().map(b=>{
    const ws=LST.workOrders.filter(w=>w.type==='preventive'&&['completed','closed'].includes(w.status)&&w.completedAt&&Date.parse(w.completedAt)>=since&&baseOfV(w.vehicleId)===b.id);
    const on=ws.filter(w=>!(w.overdueAtOpen>0)).length;return{b,n:ws.length,on,late:ws.length-on};});
  return `${pageHead('PM queue',{sub:'Tasks that are due soon or overdue across the fleet'})}
  <div class="filters"><div class="f2"><label for="f-pm-base">Base</label>${selHtml('f-pm-base',baseOpts(true),f.base,'data-filter="pm.base"')}</div></div>
  <div class="panel"><div class="tscroll"><table class="t"><thead><tr><th>Unit</th><th>Base</th><th>Task</th><th>Remaining</th><th>Next due</th><th>Projected</th><th>State</th><th></th></tr></thead><tbody>
  ${rows.map(({v,st})=>`<tr><td><button class="ulink" data-act="open-vehicle" data-id="${esc(v.id)}">${esc(v.unit)}</button></td><td>${esc(baseName(v.baseId))}</td><td>${esc(st.task.name)}</td><td>${esc(remText(st))}</td>
  <td>${[st.nextDueHours!=null?num(st.nextDueHours)+' h':'',st.nextDueDate?fmtDate(st.nextDueDate):''].filter(Boolean).join(' / ')||'Now'}</td><td>${st.projected?fmtDate(st.projected):'–'}</td><td>${pmPill(st.state)}</td>
  <td class="c-act">${can('createWO',v)?`<button class="btn sm" data-act="pm-wo" data-id="${esc(v.id)}" id="pmwo-${esc(v.id)}-${esc(st.task.id)}">Create work order</button>`:''}</td></tr>`).join('')||'<tr><td colspan="8" class="muted">Nothing is due. All PM is up to date.</td></tr>'}
  </tbody></table></div></div>
  <div class="panel"><div class="ph"><h2>PM compliance, last 90 days</h2></div><div class="pn small muted">A completed PM work order counts as on time when none of its tasks were overdue when it was opened.</div>
  <div class="tscroll"><table class="t"><thead><tr><th>Base</th><th class="n">Completed</th><th class="n">On time</th><th class="n">Late</th><th class="n">On-time rate</th></tr></thead><tbody>
  ${comp.map(c=>`<tr><td>${esc(c.b.name)}</td><td class="n">${c.n}</td><td class="n">${c.on}</td><td class="n">${c.late}</td><td class="n">${c.n?Math.round(c.on/c.n*100)+'%':'–'}</td></tr>`).join('')}</tbody></table></div></div>`;
};

/* ---- issues ---- */
export const ISSUE_FILTER=[['active','Open or in a work order'],['open','Open (no work order yet)'],['in_work_order','In a work order'],['resolved','Resolved'],['dismissed','Dismissed'],['all','All']];
VIEWS.issues=function(){
  const f=ui.f.issues;
  let list=LST.issues.filter(i=>(f.status==='all'||(f.status==='active'?(i.status==='open'||i.status==='in_work_order'):i.status===f.status))&&(!f.severity||i.severity===f.severity)&&(!f.base||baseOfV(i.vehicleId)===f.base));
  list.sort((a,b)=>Date.parse(b.reportedAt)-Date.parse(a.reportedAt));
  const selOk=ui.selIssues.filter(id=>D.issues[id]&&D.issues[id].status==='open');
  const sameVeh=selOk.length>0&&new Set(selOk.map(id=>D.issues[id].vehicleId)).size===1;
  return `${pageHead('Issues',{acts:(can('issues')?`<button class="btn" data-act="wo-from-issues" id="issWo" ${sameVeh?'':'disabled'}>Create work order from ${selOk.length||''} selected</button>`:'')+(can('report')?actBtn('Report a problem',{id:'issReport',act:'report-issue',primary:true,icon:'alert'}):'')})}
  <div class="filters"><div class="f2"><label for="f-issues-status">Status</label>${selHtml('f-issues-status',ISSUE_FILTER,f.status,'data-filter="issues.status"')}</div>
  <div class="f2"><label for="f-issues-severity">Severity</label>${selHtml('f-issues-severity',[['','All severities'],['critical','Critical'],['major','Major'],['minor','Minor']],f.severity,'data-filter="issues.severity"')}</div>
  <div class="f2"><label for="f-issues-base">Base</label>${selHtml('f-issues-base',baseOpts(true),f.base,'data-filter="issues.base"')}</div></div>
  ${can('issues')&&selOk.length>1&&!sameVeh?'<div class="warnbox">Pick problems from one unit only to make a work order.</div>':''}
  <div class="panel"><div class="tscroll"><table class="t"><thead><tr>${can('issues')?'<th class="chkcol"><span class="sr">Select</span></th>':''}<th>Unit</th><th>Problem</th><th>Severity</th><th>Status</th><th>Reported</th>${can('issues')?'<th></th>':''}</tr></thead><tbody>
  ${list.map(i=>`<tr>${can('issues')?`<td class="chkcol">${i.status==='open'?`<input type="checkbox" id="sel-${esc(i.id)}" data-sel="${esc(i.id)}" aria-label="Select ${esc(i.title)}" ${ui.selIssues.includes(i.id)?'checked':''}>`:''}</td>`:''}
  <td><button class="ulink" data-act="open-vehicle" data-id="${esc(i.vehicleId)}">${esc(unitOf(i.vehicleId))}</button><div class="tiny muted">${esc(baseName(baseOfV(i.vehicleId)))}</div></td>
  <td><button class="btn link" data-act="open-issue" data-id="${esc(i.id)}" id="oi-${esc(i.id)}"><b>${esc(i.title)}</b></button>${attChip(i)}${i.source==='bus_check_report'?' <span class="badge acc">Bus check</span>':''}<div class="small muted">${esc(i.description||'')}</div>${thumbStrip(i)}</td><td>${pill(i.severity==='critical'?'bad':i.severity==='major'?'warn':'res',SEV[i.severity])}</td>
  <td>${esc(ISSUE_ST[i.status]||i.status)}${i.woId&&D.workOrders[i.woId]?`<div><button class="btn link mono-s" data-act="open-wo" data-id="${esc(i.woId)}">${esc(D.workOrders[i.woId].number)}</button></div>`:''}</td>
  <td>${fmtDate(i.reportedAt)}<div class="tiny muted">${esc(nameOf(i.by))}</div></td>
  ${can('issues')?`<td>${i.status==='open'?`<button class="btn sm ghost danger" data-act="dismiss-issue" data-id="${esc(i.id)}" id="dis-${esc(i.id)}">Dismiss</button>`:''}</td>`:''}</tr>`).join('')||`<tr><td colspan="7" class="muted">No problems match these filters.</td></tr>`}
  </tbody></table></div></div>`;
};
export const UPLOADS_OFF_NOTE='Photo and PDF uploads are turned off for now.';
export const UPLOADS_NOPERM_NOTE='You don’t have permission to upload photos or PDFs.';
export const UPLOADS_DEMO_NOTE='Photo and PDF uploads are not available in the demo.';
const offMsg=()=>isDemo()?UPLOADS_DEMO_NOTE:uploadState()==='noperm'?UPLOADS_NOPERM_NOTE:UPLOADS_OFF_NOTE;
/** Upload buttons stay on screen when uploads are off, so people know the capability exists; they are just disabled. */
const offBtn=(ico,label,sm='')=>`<button type="button" class="btn${sm} attlabel" disabled aria-disabled="true" title="${esc(offMsg())}">${icon(ico)}${label}</button>`;
const offNote=()=>`<p class="tiny muted upnote" id="upnote" role="note">${icon('info')}<span>${esc(offMsg())}</span></p>`;
function photoBlockHtml(){
  if(!uploadsOn())return `<div style="margin-bottom:12px"><div class="row">${offBtn('image','Add photo')}${offBtn('file','Attach PDF')}</div>${offNote()}</div>`;
  return `<div style="margin-bottom:12px"><div class="row"><input class="sr" type="file" id="ri-photos" accept="image/jpeg,image/png,image/webp" multiple><label class="btn attlabel" for="ri-photos">${icon('image')}Add photo</label>
    <input class="sr" type="file" id="ri-pdf" accept="application/pdf,.pdf" multiple><label class="btn attlabel" for="ri-pdf">${icon('file')}Attach PDF</label></div>
    <div id="ri-thumbs" class="pths" aria-live="polite"></div><div class="tiny muted" style="margin-top:4px">Photos are shrunk before they are sent. Files up to 20 MB each.</div></div>`;
}
export function renderThumbs(){
  const box=$('#ri-thumbs');if(!box)return;
  box.innerHTML=pending.map((p,i)=>`<div class="pth">${p.preview?`<img src="${esc(p.preview)}" alt="Photo ${i+1}">`:`<span class="ficon">PDF</span>`}<span class="tiny nm">${esc(p.file.name)}</span><button type="button" class="btn sm" data-act="ri-rm" data-i="${i}" id="ri-rm-${i}" aria-label="Remove ${esc(p.file.name)}">${icon('x')}</button></div>`).join('');
}
export async function addPending(files){
  for(const f of files){
    try{const p=await normalizeFile(f);pending.push({file:p,preview:/^image\//.test(fileType(p)||'')?URL.createObjectURL(p):null});}
    catch(e){toast(e&&e.user?e.message:'Could not read that file.',true);}
  }
  renderThumbs();
}
export function clearPending(){pending.forEach(p=>{if(p.preview)URL.revokeObjectURL(p.preview);});pending.length=0;}
export function issueFormHtml(vid){
  const vs=vehOpts();
  return `<form data-form="issue" id="issueForm" novalidate>
    ${field('Unit',selHtml('ri-vehicle',vs,vid||vs[0]?.[0],'required'))}
    <div id="ri-dup"></div>
    ${field('What is wrong?',inp('ri-title','','text','required maxlength="120" autocomplete="off" placeholder="Short description"'))}
    ${field('More detail (optional)','<textarea id="ri-desc" name="ri-desc" rows="3"></textarea>')}
    ${photoBlockHtml()}
    <fieldset style="border:none;padding:0;margin:0 0 10px"><legend class="small" style="font-weight:600;margin-bottom:4px">How serious is it?</legend>
      ${[['critical','Critical','Unit is unsafe to drive. It is taken out of service right away.'],['major','Major','Needs repair soon. Unit can run with care.'],['minor','Minor','Small fault. Fix at the next service.']].map(([k,l,d],n)=>
        `<label class="chk"><input type="radio" id="ri-sev-${k}" name="severity" value="${k}" ${n===1?'checked':''}><span><b>${l}</b><br><span class="small muted">${d}</span></span></label>`).join('')}</fieldset>
    ${field('Engine hours now',inp('ri-hours','','number','inputmode="numeric" min="0" step="1"'),'Leave as is if you did not check the meter.')}
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="ri-cancel">Cancel</button><button class="btn primary" type="submit" id="ri-submit">Send report</button></div></form>`;
}
export function updateIssueDup(setHours){
  const sel=$('#ri-vehicle');if(!sel)return;
  const v=D.vehicles[sel.value],box=$('#ri-dup');
  if(setHours&&v)$('#ri-hours').value=v.engineHours??'';
  const open=v?openIssues(v.id):[];
  box.innerHTML=open.length?`<div class="warnbox"><b>${open.length} open ${open.length===1?'problem':'problems'} already on ${esc(v.unit)}:</b><ul>${open.map(i=>`<li>${esc(i.title)} (${esc(SEV[i.severity])}, ${fmtDate(i.reportedAt)})</li>`).join('')}</ul>Only send a new report if this is a different problem.</div>`:'';
}

/* ---- work order create form ---- */
export function woChecksHtml(vid,preIssues=[],prePm=null){
  const v=D.vehicles[vid];if(!v)return '';
  const sm=vsum(v),iss=openIssues(v.id).filter(i=>i.status==='open'),warn=coverageAfterRemoval(v);
  const pm=prePm||sm.due.map(s=>s.task.id);
  return `${warn?`<div class="warnbox bad" role="alert">Taking ${esc(v.unit)} out would leave ${esc(warn.base)} with ${warn.avail} of ${warn.total} available. The minimum is ${warn.min}.</div>`:''}
  <fieldset style="border:none;padding:0;margin:0 0 10px"><legend class="small" style="font-weight:600">PM tasks to include</legend>
  ${sm.tasks.map(s=>`<label class="chk"><input type="checkbox" id="wf-pm-${esc(s.task.id)}" name="pm" value="${esc(s.task.id)}" ${pm.includes(s.task.id)?'checked':''}><span>${esc(s.task.name)} ${s.state!=='ok'?pmPill(s.state):''} <span class="tiny muted">${esc(remText(s))}</span></span></label>`).join('')||'<span class="muted small">No PM program.</span>'}</fieldset>
  <fieldset style="border:none;padding:0;margin:0 0 10px"><legend class="small" style="font-weight:600">Problems to fix</legend>
  ${iss.map(i=>`<label class="chk"><input type="checkbox" id="wf-is-${esc(i.id)}" name="iss" value="${esc(i.id)}" ${preIssues.includes(i.id)?'checked':''}><span>${esc(i.title)} <span class="tiny muted">${esc(SEV[i.severity])}</span></span></label>`).join('')||'<span class="muted small">No open problems on this unit.</span>'}</fieldset>`;
}
export function woFormHtml({vehicleId,issueIds=[],pmTaskIds=null,type}){
  const vs=vehOpts(),vid=vehicleId||vs[0]?.[0];
  const t=type||(issueIds.length?'corrective':(pmTaskIds&&pmTaskIds.length?'preventive':'corrective'));
  return `<form data-form="wo" id="woForm" novalidate>
    ${field('Unit',selHtml('wf-vehicle',vs,vid))}
    <div class="fgrid">${field('Type',selHtml('wf-type',Object.entries(WO_TYPES),t))}${field('Priority',selHtml('wf-priority',Object.entries(PRIO),'normal'))}</div>
    <div class="fgrid">${field('Mechanic',selHtml('wf-mech',[['','Not assigned'],...LST.mechanics.map(m=>[m.id,m.name])],''))}${field('Planned date (optional)',inp('wf-sched','','date'))}</div>
    <div id="wf-checks">${woChecksHtml(vid,issueIds,pmTaskIds)}</div>
    ${field('Notes (optional)','<textarea id="wf-notes" name="wf-notes" rows="2"></textarea>')}
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="wf-cancel">Cancel</button><button class="btn primary" type="submit" id="wf-submit">Create work order</button></div></form>`;
}

/* ---- work orders ---- */
VIEWS['work-orders']=function(){
  const f=ui.f.wo;
  const list=LST.workOrders.filter(w=>f.status==='all'||(f.status==='active'?WO_ACTIVE.includes(w.status)||w.status==='completed':w.status===f.status)).sort((a,b)=>Date.parse(b.openedAt)-Date.parse(a.openedAt));
  const cols=['open','approved','scheduled','in_progress','on_hold','completed'].concat(f.status==='all'||f.status==='closed'?['closed']:[]).concat(f.status==='all'||f.status==='cancelled'?['cancelled']:[]);
  const cb=w=>(isComeback(w,LST.workOrders,settings().comebackDays)?' <span class="badge warn">Comeback</span>':'')+attChip(w);
  return `${pageHead('Work orders',{acts:can('createWO')?actBtn('New work order',{id:'newWo',act:'new-wo',primary:true,icon:'plus'}):''})}
  <div class="filters"><div class="f2"><label for="f-wo-status">Status</label>${selHtml('f-wo-status',[['active','Active and awaiting close'],['all','All'],...Object.entries(WO_STATUS)],f.status,'data-filter="wo.status"')}</div>
  <div class="f2 fix"><label id="wo-view-l">View</label><div class="seg" role="group" aria-labelledby="wo-view-l"><button type="button" id="woViewT" data-act="wo-view" data-v="table" aria-pressed="${f.view==='table'}">Table</button><button type="button" id="woViewB" data-act="wo-view" data-v="board" aria-pressed="${f.view==='board'}">Board</button></div></div></div>
  ${f.view==='board'?`<div class="kan">${cols.map(c=>{const ws=list.filter(w=>w.status===c);return `<div class="kcol"><h3>${WO_STATUS[c]} <span class="muted">${ws.length}</span></h3>${ws.map(w=>`<button type="button" class="kcard" data-act="open-wo" data-id="${esc(w.id)}" id="kc-${esc(w.id)}"><span class="wn">${esc(w.number)}</span> <span class="small mono-s">${esc(unitOf(w.vehicleId))}</span>${cb(w)}
    <div class="small muted">${esc(WO_TYPES[w.type])} · ${esc(PRIO[w.priority])}</div><div class="small">${gyd(woTotal(w))}</div></button>`).join('')||'<p class="tiny muted" style="margin:4px">None</p>'}</div>`;}).join('')}</div>`
  :`<div class="panel"><div class="tscroll"><table class="t">${woHead(true)}<tbody>${woRows(list,true)||'<tr><td colspan="8" class="muted">No work orders match.</td></tr>'}</tbody></table></div></div>`}`;
};
export const woEditable=w=>w&&w.status!=='closed'&&w.status!=='cancelled';
/* attachments */
export const canAttach=(coll:string,doc:any)=>coll==='issues'?can('report',D.vehicles[doc.vehicleId]):(canWo(doc)||can('createWO',D.vehicles[doc.vehicleId]));
export function attHtml(coll,doc){
  const list=doc.attachments||[],up=UP[coll+':'+doc.id]||[];
  const rows=list.map(a=>{
    const ok=safeAsset(a.assetId),img=isImgAtt(a);
    return `<li>${img?`<img class="thumb" src="${esc(fileUrl(a.assetId))}" alt="Photo: ${esc(a.name)}" width="48" height="48" loading="lazy">`:`<span class="ficon" aria-hidden="true">${/pdf/.test(a.type||'')?'PDF':'FILE'}</span>`}
    <div class="info"><b>${esc(a.name)}</b><div class="tiny muted">${/pdf/.test(a.type||'')?'PDF':esc((a.type||'file').replace('image/','').toUpperCase())} · ${esc(fmtSize(a.size))} · ${fmtDate(a.at)} · ${esc(nameOf(a.by))}</div></div>
    ${ok?`<a class="btn sm" href="${esc(fileUrl(a.assetId))}" target="_blank" rel="noopener">Open</a>`:''}
    ${can('delAttach')?`<button type="button" class="btn sm ghost danger" data-act="att-rm" data-coll="${coll}" data-id="${esc(doc.id)}" data-asset="${esc(a.assetId)}" id="attrm-${esc(a.assetId)}" aria-label="Remove ${esc(a.name)}">Remove</button>`:''}</li>`;}).join('');
  let ctl='';
  if(canAttach(coll,doc)&&!uploadsOn()){
    ctl=`<div class="row">${offBtn('clip','Attach file',' sm')}</div>${offNote()}`;
  }else if(canAttach(coll,doc)){
    ctl=`<div class="row"><input class="sr" type="file" id="att-file" data-att="${coll}:${esc(doc.id)}" accept=".pdf,image/jpeg,image/png,image/webp" multiple><label class="btn sm attlabel" for="att-file">${icon('clip')}Attach file</label><span class="tiny muted">PDF, JPEG, PNG or WebP, up to 20 MB each</span></div>`;
  }
  return `${list.length?`<ul class="att">${rows}</ul>`:'<p class="small muted">No files attached.</p>'}${up.map(u=>`<p class="small" role="status">${esc(u.name)}: ${esc(u.state)}</p>`).join('')}${ctl}`;
}
export function refreshAtt(){
  const s=$('#attSec');if(!s||!ui.drawer)return;
  const coll=ui.drawer.type==='wo'?'workOrders':ui.drawer.type==='issue'?'issues':null;if(!coll)return;
  const d=D[coll][ui.drawer.id];if(d)s.innerHTML=attHtml(coll,d);
}
export function issueHtml(i){
  const v=D.vehicles[i.vehicleId],wo=i.woId&&D.workOrders[i.woId];
  return `<div class="row tight" style="margin-bottom:10px">${pill(i.severity==='critical'?'bad':i.severity==='major'?'warn':'res',SEV[i.severity])}<span class="badge">${esc(ISSUE_ST[i.status]||i.status)}</span></div>
  <h3 class="ititle">${esc(i.title)}</h3><p style="white-space:pre-wrap">${esc(i.description||'No description.')}</p>
  <dl class="dl" style="margin:12px 0 16px">${kv('Unit',v?`<button class="btn link mono-s" data-act="open-vehicle" data-id="${esc(v.id)}">${esc(v.unit)}</button> <span class="muted small">${esc(baseName(v.baseId))}</span>`:'Unknown')}
  ${kv('Reported',fmtDT(i.reportedAt))}${kv('Reported by',esc(nameOf(i.by)))}${kv('Engine hours at report',i.hours!=null?num(i.hours)+' h':'–')}
  ${i.busCheckId&&can('busCheckReports')?kv('Found by',`<button class="btn link" data-act="bc-open" data-id="${esc(i.busCheckId)}" id="issue-bc">The crew, in a bus check</button>`):i.source?kv('Found by','The crew, in a bus check'):''}${kv('Work order',wo?`<button class="btn link mono-s" data-act="open-wo" data-id="${esc(wo.id)}">${esc(wo.number)}</button> ${pill(WO_KIND[wo.status],WO_STATUS[wo.status])}`:'None')}</dl>
  <h3>Attachments</h3><div id="attSec">${attHtml('issues',i)}</div>
  ${can('issues')&&i.status==='open'?`<div class="dfoot"><button class="btn primary" data-act="issue-wo" data-id="${esc(i.id)}" id="issue-wo">Create work order</button></div>`:''}`;
}
export function woHtml(wo){
  const v=D.vehicles[wo.vehicleId],S=settings(),total=woTotal(wo),ed=woEditable(wo),work=canWo(wo)&&ed;
  const by={labor:0,part:0,outside:0};(wo.lines||[]).forEach(l=>{if(!l.warranty)by[l.kind]=(by[l.kind]||0)+lineCost(l);});
  const cb=isComeback(wo,LST.workOrders,S.comebackDays);
  const apprChip=wo.approvalNeeded?(wo.approvedBy||['approved','scheduled','in_progress','on_hold','completed','closed'].includes(wo.status)?'<span class="badge ok">Approved</span>':'<span class="badge bad">Needs approval</span>'):'';
  const lineRows=(wo.lines||[]).map(l=>`<tr><td>${esc(({labor:'Labor',part:'Part',outside:'Outside'})[l.kind]||l.kind)}</td><td>${esc(l.description)}${l.warranty?' <span class="badge">Warranty</span>':''}</td><td>${esc(l.repairCode)}</td><td class="n">${num(l.qty)}</td><td class="n">${gyd(l.unitCost)}</td><td class="n">${l.warranty?'<s>'+gyd(lineCost(l))+'</s>':gyd(lineCost(l))}</td>
    <td>${work?`<button class="btn sm ghost danger" data-act="wo-rmline" data-line="${esc(l.id)}" id="rm-${esc(l.id)}" aria-label="Remove line ${esc(l.description)}">Remove</button>`:''}</td></tr>`).join('');
  const addLine=work?`<form data-form="line" id="lineForm" class="panel pad inline" style="background:var(--surface-2);margin-top:12px" novalidate><h3 style="margin-bottom:8px">Add a line</h3>
    <div class="fgrid">${field('Kind',selHtml('ln-kind',[['labor','Labor'],['part','Part'],['outside','Outside work']],'labor'))}
    <div id="ln-partwrap" hidden>${field('Part',selHtml('ln-part',[['','Pick a part'],...LST.parts.map(p=>[p.id,`${p.number} ${p.description} (${p.onHand} in stock)`])],''),'Stock is deducted when the work order is completed.')}</div></div>
    ${field('Description',inp('ln-desc','','text','required maxlength="140" autocomplete="off"'))}
    <div class="fgrid">${field('System',selHtml('ln-code',REPAIR_CODES.map(c=>[c,c]),'Other'))}${field('Quantity or hours',inp('ln-qty','1','number','min="0" step="0.5" required inputmode="decimal"'))}${field(`Unit cost (${cur().symbol})`,inp('ln-cost',cur().code==='GYD'?'6000':'','number',`min="0" step="${cur().code==='GYD'?'100':moneyStep()}" required inputmode="decimal"`))}</div>
    <label class="chk"><input type="checkbox" id="ln-warranty" name="ln-warranty"><span>Covered by warranty (not charged to the agency)</span></label>
    <div class="dfoot"><button class="btn primary" type="submit" id="ln-add">Add line</button></div></form>`:'';
  return `<div class="row tight" style="margin-bottom:10px">${pill(WO_KIND[wo.status],WO_STATUS[wo.status])}${wo.status==='on_hold'&&wo.holdReason?`<span class="badge bad">${esc(HOLD[wo.holdReason])}</span>`:''}${cb?'<span class="badge warn">Comeback</span>':''}${apprChip}</div>
  <dl class="dl" style="margin-bottom:14px">
    ${kv('Unit',v?`<button class="btn link mono-s" data-act="open-vehicle" data-id="${esc(v.id)}">${esc(v.unit)}</button> <span class="muted small">${esc(baseName(v.baseId))}</span>`:'Unknown')}
    ${kv('Type',esc(WO_TYPES[wo.type]))}
    ${kv('Priority',can('createWO',v)&&ed?selHtml('wo-prio',Object.entries(PRIO),wo.priority,'data-wo-field="priority" aria-label="Priority"'):esc(PRIO[wo.priority]))}
    ${kv('Mechanic',can('createWO',v)&&ed?selHtml('wo-mech',[['','Not assigned'],...LST.mechanics.map(m=>[m.id,m.name])],wo.mechanicId||'','data-wo-field="mechanicId" aria-label="Mechanic"'):esc(mechName(wo.mechanicId)))}
    ${kv('Opened',fmtDT(wo.openedAt))}${kv('Scheduled for',wo.scheduledFor?fmtDate(wo.scheduledFor):'–')}${kv('Started',wo.startedAt?fmtDT(wo.startedAt):'–')}
    ${kv('Completed',wo.completedAt?fmtDT(wo.completedAt):'–')}${kv('Closed',wo.closedAt?fmtDT(wo.closedAt):'–')}
    ${kv('Hours at open',num(wo.hoursAtOpen)+' h')}${kv('Hours at completion',wo.hoursAtComplete!=null?num(wo.hoursAtComplete)+' h':'–')}</dl>
  ${(wo.pmTaskIds||[]).length?`<h3>PM tasks</h3><ul class="ul">${wo.pmTaskIds.map(t=>`<li>${esc((prog(v||{})?.tasks||[]).find(x=>x.id===t)?.name||t)}</li>`).join('')}</ul>`:''}
  ${(wo.issueIds||[]).length?`<h3>Problems</h3><ul class="ul">${wo.issueIds.map(i=>`<li>${esc(D.issues[i]?.title||'Removed problem')} <span class="muted small">${esc(SEV[D.issues[i]?.severity]||'')}</span></li>`).join('')}</ul>`:''}
  ${(wo.holdLog||[]).length?`<h3>Hold history</h3><ul class="ul">${wo.holdLog.map(h=>`<li>${esc(HOLD[h.reason]||h.reason)}: ${fmtDate(h.from)} to ${h.to?fmtDate(h.to):'now'}</li>`).join('')}</ul>`:''}
  <h3 class="sec">Lines</h3>${!ed?'<p class="small muted">This work order is locked. Lines cannot be changed.</p>':''}
  <div class="tscroll"><table class="t lines"><thead><tr><th>Kind</th><th>Description</th><th>System</th><th class="n">Qty</th><th class="n">Unit cost</th><th class="n">Total</th><th></th></tr></thead><tbody>${lineRows||'<tr><td colspan="7" class="muted">No lines yet.</td></tr>'}</tbody></table></div>
  <dl class="dl" style="margin:10px 0"><div><dt>Labor</dt><dd>${gyd(by.labor)}</dd></div><div><dt>Parts</dt><dd>${gyd(by.part)}</dd></div><div><dt>Outside work</dt><dd>${gyd(by.outside)}</dd></div>${woWarranty(wo)?`<div><dt>Warranty (not charged)</dt><dd>${gyd(woWarranty(wo))}</dd></div>`:''}<div><dt>Total</dt><dd><b>${gyd(total)}</b></dd></div></dl>
  <p class="tiny muted">Work orders of ${gyd(S.approvalThresholdGYD)} or more need fleet manager approval.</p>
  ${addLine}
  <h3 class="sec">Attachments</h3><div id="attSec">${attHtml('workOrders',wo)}</div>
  <h3 class="sec">Notes</h3>${work||can('createWO',v)&&ed?`<textarea id="wo-notes" aria-label="Notes">${esc(wo.notes||'')}</textarea><div class="dfoot" style="margin-top:6px"><button class="btn sm" data-act="wo-notes" id="wo-save-notes">Save notes</button></div>`:`<p>${esc(wo.notes||'–')}</p>`}
  <h3 class="sec">Next step</h3>${woActions(wo,v)}`;
}
function woActions(wo,v){
  const S=settings(),out=[];
  if(wo.status==='closed')return '<p class="muted small">Closed. Nothing more to do.</p>';
  if(wo.status==='cancelled')return '<p class="muted small">Cancelled.</p>';
  const sched=`<div class="row" style="align-items:flex-end"><div style="flex:1 1 150px">${field('Schedule for',inp('wo-sched',wo.scheduledFor||todayStr(),'date'))}</div><button class="btn primary" style="margin-bottom:10px" data-act="wo-act" data-a="schedule" id="wo-btn-schedule">Schedule</button></div>`;
  const noPerm=m=>`<p class="small muted">${esc(m)}</p>`;
  switch(wo.status){
    case 'open':
      if(wo.approvalNeeded)out.push(can('approve',v)?`<button class="btn primary" data-act="wo-act" data-a="approve" id="wo-btn-approve">Approve ${gyd(woTotal(wo))}</button>`:noPerm(`Needs approval from a fleet manager (total is over ${gyd(S.approvalThresholdGYD)}).`));
      else out.push(can('createWO',v)?sched:noPerm('A supervisor schedules this work order.'));break;
    case 'approved':out.push(can('createWO',v)?sched:noPerm('A supervisor schedules this work order.'));break;
    case 'scheduled':
      out.push(canWo(wo)?`${v&&isAvail(v.status)?`<div class="warnbox">Starting work takes ${esc(v.unit)} out of service.</div>`:''}<div class="row" style="align-items:flex-end"><div style="flex:1 1 150px">${field('Expected back (optional)',inp('wo-eta','','date'))}</div><button class="btn primary" style="margin-bottom:10px" data-act="wo-act" data-a="start" id="wo-btn-start">Start work</button></div>`:noPerm('A mechanic or supervisor starts the work.'));break;
    case 'in_progress':
      if(canWo(wo)){
        out.push(`<div class="row" style="align-items:flex-end"><div style="flex:1 1 170px">${field('Put on hold because',selHtml('wo-hold',[['','Choose a reason'],...Object.entries(HOLD)],''))}</div><button class="btn" style="margin-bottom:10px" data-act="wo-act" data-a="hold" id="wo-btn-hold">Put on hold</button></div>`);
        out.push(`<div class="panel pad" style="background:var(--surface-2)"><h3>Complete work order</h3><p class="small muted">This resets the PM tasks above, resolves the linked problems, takes used parts out of stock, logs a meter reading and returns the unit to service.</p>
          <div class="fgrid">${field('Engine hours now',inp('wo-hrs',v?.engineHours??'','number','min="0" step="1" inputmode="numeric" required'))}${field('Kilometres (optional)',inp('wo-km','','number','min="0" step="1" inputmode="numeric"'))}</div>
          <button class="btn primary" data-act="wo-act" data-a="complete" id="wo-btn-complete">Mark completed</button></div>`);
      }else out.push(noPerm('A mechanic or supervisor updates this work order.'));break;
    case 'on_hold':out.push(canWo(wo)?`<button class="btn primary" data-act="wo-act" data-a="resume" id="wo-btn-resume">Resume work</button>`:noPerm('A mechanic or supervisor updates this work order.'));break;
    case 'completed':out.push(can('closeWO',v)?`<button class="btn primary" data-act="wo-act" data-a="close" id="wo-btn-close">Close work order</button><p class="tiny muted" style="margin-top:6px">Closing locks the lines.</p>`:noPerm('A supervisor closes this work order.'));break;
  }
  if(can('cancelWO',v))out.push(`<div style="margin-top:12px"><button class="btn danger" data-act="wo-act" data-a="cancel" id="wo-btn-cancel">Cancel work order</button></div>`);
  return out.join('');
}

/* ---- parts and mechanics ---- */
VIEWS.parts=function(){
  const spend={},open={};
  LST.workOrders.forEach(w=>{if(w.status==='cancelled')return;spend[w.mechanicId]=(spend[w.mechanicId]||0)+woTotal(w);if(WO_ACTIVE.includes(w.status))open[w.mechanicId]=(open[w.mechanicId]||0)+1;});
  const parts=LST.parts.slice().sort((a,b)=>String(a.number).localeCompare(String(b.number)));
  return `${pageHead('Parts and mechanics')}
  <div class="panel"><div class="ph"><h2>Parts</h2>${can('parts')?'<button class="btn sm" data-act="add-part" id="addPart">'+icon('plus')+'Add part</button>':''}</div>
  <div class="tscroll"><table class="t"><thead><tr><th>Number</th><th>Description</th><th>Fits</th><th class="n">On hand</th><th class="n">Reorder at</th><th class="n">Unit cost</th><th>Stock</th><th></th></tr></thead><tbody>
  ${parts.map(p=>`<tr><td>${esc(p.number)}</td><td>${esc(p.description)}</td><td class="small">${esc(p.fits)}</td><td class="n">${num(p.onHand)}</td><td class="n">${num(p.reorderPoint)}</td><td class="n">${gyd(p.unitCost)}</td>
  <td>${p.onHand<=0?'<span class="badge bad">Out of stock</span>':p.onHand<=p.reorderPoint?'<span class="badge warn">Low stock</span>':'<span class="badge ok">OK</span>'}</td>
  <td class="c-act">${can('parts')?`<div class="row tight"><button class="btn sm" data-act="receive-part" data-id="${esc(p.id)}" id="rcv-${esc(p.id)}">Receive</button><button class="btn sm ghost" data-act="edit-part" data-id="${esc(p.id)}" id="ep-${esc(p.id)}">Edit</button></div>`:''}</td></tr>`).join('')||'<tr><td colspan="8" class="muted">No parts yet.</td></tr>'}</tbody></table></div></div>
  <div class="panel"><div class="ph"><h2>MOH-approved mechanics</h2>${can('mechanics')?'<button class="btn sm" data-act="add-mech" id="addMech">'+icon('plus')+'Add mechanic</button>':''}</div>
  <div class="tscroll"><table class="t"><thead><tr><th>Name</th><th>Location</th><th>Region</th><th>Phone</th><th class="n">Open work orders</th><th class="n">Spend to date</th><th></th></tr></thead><tbody>
  ${LST.mechanics.map(m=>`<tr><td><b>${esc(m.name)}</b></td><td>${esc(m.shop)}</td><td>${esc(m.region)}</td><td>${esc(m.phone)}</td><td class="n">${open[m.id]||0}</td><td class="n">${gyd(spend[m.id]||0)}</td>
  <td class="c-act">${can('mechanics')?`<button class="btn sm ghost" data-act="edit-mech" data-id="${esc(m.id)}" id="em-${esc(m.id)}">Edit</button>`:''}</td></tr>`).join('')||'<tr><td colspan="7" class="muted">No mechanics yet.</td></tr>'}</tbody></table></div></div>`;
};
