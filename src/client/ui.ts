/** Forms, button actions and global event wiring. */
import { RANK, checkReading, toCsv } from '../shared/pure';
import { STATUS, isAvail, isOos } from '../shared/constants';
import { D, LST, ui, S, can, canWo, settings, uploadsOn, vehiclesSorted, basesSorted, baseName, unitOf, readingsOf, wosOf, vsum, hasSample, coverageAfterRemoval, coverageEffect, saveUi } from './state';
import { $, $$, esc, num, gyd, todayStr, toast, selHtml, field, inp, nv, val, run } from './util';
import { statusPill, statusSw, baseOpts, loanChip } from './bits';
import { layoutActs, closeMenus, escLayout, navRoot } from './layout';
import { showDrawer, closeDrawer, confirmUI, cfDone, drawerBack } from './dom';
import * as nav from './nav';
import { go, route, openVehicle, goBack, viewChanged, applyNav, restoreNav, setSkipNext, setPendingRestore, clearNavStack } from './nav';
import { pending, attachFiles, removeAttachment } from './files';
import { addPending, clearPending, renderThumbs, issueFormHtml, updateIssueDup, woFormHtml, woChecksHtml } from './views-b';
import { CSV } from './views-c';
import { openDrawer } from './drawers';
import { render } from './shell';
import * as A from './actions';
import { setVehicleStatus, recordReading, acceptReading, submitIssue, dismissIssue, createWorkOrder, addLine, removeLine, patchWo, woAction, moveUnits, removeSample, saveVehicle, savePart, receivePart, saveMech, saveBase, saveProgram, saveSettings, saveFeatures } from './actions';
import { userForms, userActs, syncPermsForm } from './users-ui';

export const FORMS:Record<string,any>={};
function saveBlob(name,blob){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),2000);}
export function openVehicleForm(v?){
  const e=!!v;v=v||{status:'in_service',type:'Type II ambulance'};
  const progs=LST.pmPrograms.map(p=>[p.id,p.name]);
  showDrawer(e?`Edit ${v.unit}`:'Add vehicle',`<form data-form="vehicle" data-id="${e?esc(v.id):''}" id="vehForm" novalidate>
    <div class="fgrid">${field('Unit name',inp('vf-unit',v.unit,'text','required placeholder="GEMA-21" maxlength="30"'))}${field('Plate',inp('vf-plate',v.plate,'text','maxlength="20"'))}</div>
    ${field('VIN',inp('vf-vin',v.vin,'text','maxlength="24"'))}
    <div class="fgrid">${field('Make',inp('vf-make',v.make,'text','required'))}${field('Model',inp('vf-model',v.model,'text','required'))}${field('Year',inp('vf-year',v.year,'number','min="1990" max="2100"'))}</div>
    <div class="fgrid">${field('Type',inp('vf-type',v.type,'text'))}${field('Base',selHtml('vf-base',baseOpts(false),v.baseId||'','required'))}</div>
    <div class="fgrid">${field('In service since',inp('vf-ins',v.inServiceDate,'date'))}${field('Warranty ends',inp('vf-war',v.warrantyEnd,'date'))}</div>
    <div class="fgrid">${field('Engine hours',inp('vf-hours',v.engineHours??0,'number','min="0" step="1" required inputmode="numeric"'))}${field('Odometer (km)',inp('vf-km',v.odometerKm??0,'number','min="0" step="1" inputmode="numeric"'))}</div>
    ${field('PM program',selHtml('vf-prog',progs.length?progs:[['','No program yet']],v.pmProgramId||progs[0]?.[0]||''))}
    ${e?'':field('PM starting point',selHtml('vf-pmstart',[['today','Treat as freshly serviced today'],['never','Mark every PM task as never done']],'today'))}
    ${field('Notes','<textarea id="vf-notes" name="vf-notes" rows="2">'+esc(v.notes||'')+'</textarea>')}
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="vf-cancel">Cancel</button><button class="btn primary" type="submit" id="vf-save">${e?'Save changes':'Add vehicle'}</button></div></form>`);
}
FORMS.vehicle=async f=>{
  if(!f.reportValidity())return;
  const id=f.dataset.id,unit=val('vf-unit');
  if(LST.vehicles.some(v=>v.unit.toLowerCase()===unit.toLowerCase()&&v.id!==id)){toast('Another unit already uses that name.',true);return;}
  const o={unit,plate:val('vf-plate'),vin:val('vf-vin'),make:val('vf-make'),model:val('vf-model'),year:nv(val('vf-year')),type:val('vf-type'),baseId:val('vf-base'),inServiceDate:val('vf-ins')||null,warrantyEnd:val('vf-war')||null,
    engineHours:nv(val('vf-hours'))??0,odometerKm:nv(val('vf-km'))??0,pmProgramId:val('vf-prog'),notes:$('#vf-notes').value.trim()};
  o.pmProgramId=o.pmProgramId||null;
  if(id){if(await run(()=>saveVehicle(id,o))){toast('Vehicle saved');closeDrawer();}return;}
  let nid=null;
  const ok=await run(async()=>{const r=await saveVehicle(null,{...o,pmStart:val('vf-pmstart')==='never'?'never':'today'});nid=r.id;});
  if(ok){toast(`${unit} added`);closeDrawer();ui.vehicleId=nid;saveUi();}
};

export function statusWarnHtml(v,to){
  let h='';
  if(isAvail(v.status)&&!isAvail(to)){const w=coverageAfterRemoval(v);if(w)h+=`<div class="warnbox bad" role="alert">This leaves ${esc(w.base)} with ${w.avail} of ${w.total} available. The minimum is ${w.min}.</div>`;}
  if(to==='in_service'&&wosOf(v.id).some(w=>w.status==='in_progress'||w.status==='on_hold'))h+='<div class="warnbox">This unit still has a work order in progress.</div>';
  return h;
}
export function openStatusForm(v,to){
  const t=to||(isAvail(v.status)?'oos_repair':'in_service');
  showDrawer(`${v.unit}: change status`,`<form data-form="status" data-id="${esc(v.id)}" id="statusForm" novalidate>
    <p class="muted small">Now: ${statusPill(v.status)}</p>
    ${field('New status',selHtml('sc-to',Object.entries(STATUS).filter(([k])=>k!==v.status).map(([k,x])=>[k,x.label]),t))}
    <div id="sc-warn">${statusWarnHtml(v,t)}</div>
    ${field('Reason',inp('sc-reason','','text','maxlength="160" autocomplete="off"'),'Say why, in plain words.')}
    <div id="sc-etawrap" ${t==='in_service'?'hidden':''}>${field('Expected back (optional)',inp('sc-eta','','date'))}</div>
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="sc-cancel">Cancel</button><button class="btn primary" type="submit" id="sc-save">Save status</button></div></form>`);
}
FORMS.status=async f=>{
  const v=D.vehicles[f.dataset.id],to=val('sc-to'),reason=val('sc-reason');
  if(!v)return;if(to!=='in_service'&&!reason){toast('Add a reason so the crews know why.',true);$('#sc-reason').focus();return;}
  if(await run(()=>setVehicleStatus(v,to,reason,val('sc-eta')||null))){toast('Status updated');closeDrawer();}
};

export function openHoursForm(v){
  showDrawer(`${v.unit}: log engine hours`,`<form data-form="hours" data-id="${esc(v.id)}" id="hoursForm" novalidate>
    <p class="muted small">Current: <b>${num(v.engineHours)} h</b>, ${num(v.odometerKm)} km</p>
    ${field('Engine hours now',inp('lh-hours',v.engineHours??'','number','min="0" step="1" required inputmode="numeric"'))}
    ${field('Kilometres (optional)',inp('lh-km','','number','min="0" step="1" inputmode="numeric"'))}
    <div id="lh-warn"></div>
    <div class="dfoot" id="lh-foot"><button class="btn" type="button" data-act="close-drawer" id="lh-cancel">Cancel</button><button class="btn primary" type="submit" id="lh-save">Save reading</button></div></form>`);
}
FORMS.hours=async f=>{
  const v=D.vehicles[f.dataset.id],h=nv(val('lh-hours')),km=nv(val('lh-km'));
  if(!v)return;if(h==null||h<0){toast('Enter the hours shown on the meter.',true);return;}
  const rs=readingsOf(v.id).filter(r=>!r.flagged),warn=checkReading(v.engineHours||0,rs[rs.length-1],h,Date.now(),v.odometerKm,km);
  if(warn.length&&can('confirmReading')&&!f.dataset.warned){
    f.dataset.warned='1';
    $('#lh-warn').innerHTML=`<div class="warnbox bad" role="alert"><b>Check this reading</b><ul>${warn.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>A supervisor can confirm it. If confirmed, the unit’s hours change to this value.</div>`;
    $('#lh-foot').innerHTML='<button class="btn" type="button" data-act="close-drawer" id="lh-cancel">Cancel</button><button class="btn" type="button" data-act="lh-flag" id="lh-flag">Save as flagged</button><button class="btn primary" type="button" data-act="lh-confirm" id="lh-confirm">Confirm and update</button>';
    $('#lh-hours').setAttribute('readonly','');return;
  }
  await saveReading(v,h,km,false);
};
async function saveReading(v,h,km,accept){
  let res;
  const ok=await run(async()=>{res=await recordReading(v,h,km,accept);});
  if(!ok)return;
  toast(res.flagged?'Reading flagged for a supervisor. The unit’s hours were not changed.':'Reading saved');closeDrawer();
}

export function openIssueForm(vid?){
  clearPending();
  showDrawer('Report a problem',issueFormHtml(vid||(ui.vehicleId&&route()==='vehicle'?ui.vehicleId:null)));
  updateIssueDup(true);renderThumbs();
}
FORMS.issue=async f=>{
  if(!f.reportValidity())return;
  const sev=(f.querySelector('input[name=severity]:checked')||{}).value||'major';
  const o={vehicleId:val('ri-vehicle'),title:val('ri-title'),description:val('ri-desc'),severity:sev,hours:nv(val('ri-hours'))};
  let nid=null;
  if(await run(async()=>{nid=await submitIssue(o);})){
    const files=pending.map(p=>p.file);
    toast(sev==='critical'?'Reported. The unit is now out of service.':'Problem reported');closeDrawer();clearPending();
    if(files.length&&nid)await attachFiles('issues',nid,files);
  }
};
export function openWoForm(opts){
  showDrawer('New work order',woFormHtml(opts||{}));
}
FORMS.wo=async f=>{
  if(!f.reportValidity())return;
  const g=n=>[...f.querySelectorAll(`input[name=${n}]:checked`)].map(x=>x.value);
  const o={vehicleId:val('wf-vehicle'),type:val('wf-type'),priority:val('wf-priority'),mechanicId:val('wf-mech')||null,scheduledFor:val('wf-sched')||null,notes:val('wf-notes'),pmTaskIds:g('pm'),issueIds:g('iss')};
  if(o.type==='preventive'&&!o.pmTaskIds.length){toast('Pick at least one PM task for a preventive work order.',true);return;}
  let r;if(await run(async()=>{r=await createWorkOrder(o);})){toast(`${r.number} created`);closeDrawer();ui.f.wo.status='active';saveUi();go('work-orders');}
};
FORMS.line=async f=>{
  if(!f.reportValidity())return;
  const wo=D.workOrders[ui.drawer?.id];if(!wo)return;
  const kind=val('ln-kind'),qty=nv(val('ln-qty')),cost=nv(val('ln-cost'));
  if(qty==null||qty<=0||cost==null||cost<0){toast('Enter a quantity and a unit cost.',true);return;}
  if(kind==='part'&&!val('ln-part')){toast('Pick the part used.',true);return;}
  const line={kind,description:val('ln-desc'),repairCode:val('ln-code'),qty,unitCost:cost,partId:kind==='part'?(val('ln-part')||null):null,warranty:$('#ln-warranty').checked};
  if(await run(()=>addLine(wo.id,line)))toast('Line added');
};

export function openPartForm(p?){
  const e=!!p;p=p||{};
  showDrawer(e?`Edit ${p.number}`:'Add part',`<form data-form="part" data-id="${e?esc(p.id):''}" id="partForm" novalidate>
    <div class="fgrid">${field('Part number',inp('pt-num',p.number||('P-'+(1001+LST.parts.length)),'text','required'))}${field('Unit cost (G$)',inp('pt-cost',p.unitCost??0,'number','min="0" step="1" required'))}</div>
    ${field('Description',inp('pt-desc',p.description,'text','required'))}${field('Fits',inp('pt-fits',p.fits,'text'))}
    <div class="fgrid">${field('On hand',inp('pt-on',p.onHand??0,'number','min="0" step="1" required'))}${field('Reorder point',inp('pt-rp',p.reorderPoint??0,'number','min="0" step="1" required'))}</div>
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="pt-cancel">Cancel</button><button class="btn primary" type="submit" id="pt-save">Save part</button></div></form>`);
}
FORMS.part=async f=>{
  if(!f.reportValidity())return;
  const o={number:val('pt-num'),description:val('pt-desc'),fits:val('pt-fits'),onHand:nv(val('pt-on'))??0,reorderPoint:nv(val('pt-rp'))??0,unitCost:nv(val('pt-cost'))??0};
  if(await run(()=>savePart(f.dataset.id||null,o))){toast('Part saved');closeDrawer();}
};
export function openReceiveForm(p){
  showDrawer(`Receive stock: ${p.number}`,`<form data-form="receive" data-id="${esc(p.id)}" id="rcvForm" novalidate><p class="muted small">${esc(p.description)}. On hand: <b>${num(p.onHand)}</b> at ${gyd(p.unitCost)} each.</p>
    ${field('Quantity received',inp('rc-qty','','number','min="1" step="1" required inputmode="numeric"'))}
    ${field('Cost per unit on this delivery (G$)',inp('rc-cost',p.unitCost,'number','min="0" step="1" required'),'The part’s unit cost becomes the weighted average of old stock and this delivery.')}
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="rc-cancel">Cancel</button><button class="btn primary" type="submit" id="rc-save">Receive stock</button></div></form>`);
}
FORMS.receive=async f=>{
  if(!f.reportValidity())return;
  const p=D.parts[f.dataset.id],q=nv(val('rc-qty')),c=nv(val('rc-cost'));if(!p||!(q>0)||c==null)return;
  let r;
  if(await run(async()=>{r=await receivePart(p.id,q,c);})){toast(`${q} received. New unit cost ${gyd(r.unitCost)}.`);closeDrawer();}
};
export function openMechForm(m?){
  const e=!!m;m=m||{};
  showDrawer(e?'Edit mechanic':'Add mechanic',`<form data-form="mech" data-id="${e?esc(m.id):''}" id="mechForm" novalidate>
    ${field('Name',inp('mc-name',m.name,'text','required'))}${field('Location',inp('mc-shop',m.shop,'text'))}
    <div class="fgrid">${field('Phone',inp('mc-phone',m.phone,'tel'))}${field('Region',inp('mc-region',m.region,'text'))}</div>
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="mc-cancel">Cancel</button><button class="btn primary" type="submit" id="mc-save">Save mechanic</button></div></form>`);
}
FORMS.mech=async f=>{
  if(!f.reportValidity())return;
  const o={name:val('mc-name'),shop:val('mc-shop'),phone:val('mc-phone'),region:val('mc-region')};
  if(await run(()=>saveMech(f.dataset.id||null,o))){toast('Mechanic saved');closeDrawer();}
};
export function openBaseForm(b?){
  const e=!!b;b=b||{};
  showDrawer(e?`Edit ${b.name}`:'Add base',`<form data-form="base" data-id="${e?esc(b.id):''}" id="baseForm" novalidate>
    ${field('Base name',inp('bs-name',b.name,'text','required'))}${field('Region',inp('bs-region',b.region,'text'))}
    ${field('Minimum available units',inp('bs-min',b.minUnits??1,'number','min="0" step="1" required'),'The board flags the base when fewer units than this are available.')}
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="bs-cancel">Cancel</button><button class="btn primary" type="submit" id="bs-save">Save base</button></div></form>`);
}
FORMS.base=async f=>{
  if(!f.reportValidity())return;
  const o={name:val('bs-name'),region:val('bs-region'),minUnits:nv(val('bs-min'))??0};
  if(await run(()=>saveBase(f.dataset.id||null,o))){toast('Base saved');closeDrawer();}
};
let pfN=0;
const taskRow=t=>{const n=++pfN;return `<div class="panel trow" data-tid="${esc(t.id||'')}" style="padding:10px;background:var(--surface-2)">
  <div class="fgrid">${field('Task',`<input id="pf-n-${n}" name="tn" type="text" value="${esc(t.name||'')}" required>`)}${field('Group',`<input id="pf-g-${n}" name="tg" type="text" value="${esc(t.group||'')}">`)}</div>
  <div class="fgrid">${field('Every (hours)',`<input id="pf-h-${n}" name="th" type="number" min="0" value="${esc(t.intervalHours??'')}" inputmode="numeric">`)}${field('Every (days)',`<input id="pf-d-${n}" name="td" type="number" min="0" value="${esc(t.intervalDays??'')}" inputmode="numeric">`)}${field('Every (km)',`<input id="pf-k-${n}" name="tk" type="number" min="0" value="${esc(t.intervalKm??'')}" inputmode="numeric">`)}</div>
  <button class="btn sm danger" type="button" data-act="prog-rmtask" id="pf-rm-${n}">Remove task</button></div>`;};
export function openProgramForm(p?){
  const e=!!p;p=p||{name:'',appliesTo:'Type II ambulance',tasks:[]};
  showDrawer(e?'Edit PM program':'Add PM program',`<form data-form="program" data-id="${e?esc(p.id):''}" id="progForm" novalidate>
    <div class="warnbox">Confirm intervals with the manufacturer’s schedule. A task is due at whichever limit (hours, days or km) comes first.</div>
    ${field('Program name',inp('pf-name',p.name,'text','required'))}${field('Applies to (vehicle type)',inp('pf-applies',p.appliesTo,'text'))}
    <div id="pf-rows">${(p.tasks||[]).map(taskRow).join('')}</div>
    <button class="btn" type="button" data-act="prog-addtask" id="pf-add">Add task</button>
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="pf-cancel">Cancel</button><button class="btn primary" type="submit" id="pf-save">Save program</button></div></form>`,{wide:true});
}
FORMS.program=async f=>{
  if(!f.reportValidity())return;
  const tasks=[...f.querySelectorAll('.trow')].map(r=>{const g=n=>r.querySelector(`[name=${n}]`).value.trim();
    return{id:r.dataset.tid||null,name:g('tn'),group:g('tg')||'General',intervalHours:nv(g('th')),intervalDays:nv(g('td')),intervalKm:nv(g('tk'))};});
  if(!tasks.length){toast('Add at least one task.',true);return;}
  const o={name:val('pf-name'),appliesTo:val('pf-applies'),tasks};
  if(await run(()=>saveProgram(f.dataset.id||null,o))){toast('Program saved');closeDrawer();}
};
FORMS.settings=async f=>{
  if(!can('setup'))return;
  const o={approvalThresholdGYD:nv(val('st-thr'))??150000,dueSoonHours:nv(val('st-h'))??25,dueSoonDays:nv(val('st-d'))??14,comebackDays:nv(val('st-cb'))??30};
  if(await run(()=>saveSettings(o)))toast('Settings saved');
};

FORMS.features=async f=>{
  if(!(S.me&&S.me.isSuperuser))return;
  const on=!!(document.getElementById('ft-uploads') as HTMLInputElement|null)?.checked;
  if(await run(()=>saveFeatures({uploads:on})))toast(on?'Photo and PDF uploads turned on':'Photo and PDF uploads turned off');
};

/* ---- move units ---- */
export function openMoveDrawer(pre){
  const vs=vehiclesSorted().filter(v=>v.status!=='decommissioned');
  if(!vs.length){toast('There are no units to move.',true);return;}
  const groups=basesSorted().concat([{id:'',name:'Unassigned'}]).filter(b=>vs.some(v=>(v.baseId||'')===b.id));
  showDrawer(pre.length===1?`Move ${unitOf(pre[0])}`:'Move units',`<form data-form="move" id="moveForm" novalidate>
    <p class="small muted" id="mv-l">Pick the units to move, then the base they move to.</p>
    <div class="mvlist" role="group" aria-labelledby="mv-l">${groups.map(b=>`<h3>${esc(b.name)}</h3>${vs.filter(v=>(v.baseId||'')===b.id).map(v=>
      `<label class="chk"><input type="checkbox" id="mv-u-${esc(v.id)}" name="mvu" value="${esc(v.id)}" ${pre.includes(v.id)?'checked':''}><span><b>${esc(v.unit)}</b> <span class="muted small">${esc(v.make)} ${esc(v.model)}</span> ${statusSw(v.status)} ${loanChip(v)}</span></label>`).join('')}`).join('')}</div>
    ${field('Move to',selHtml('mv-to',[['','Choose a base'],...baseOpts(false)],''))}
    ${field('Reason (optional)',inp('mv-reason','','text','maxlength="160" autocomplete="off"'))}
    <label class="chk"><input type="checkbox" id="mv-temp" name="mv-temp"><span>Temporary move (the unit goes back later)</span></label>
    <div id="mv-untilwrap" hidden>${field('Temporary until',inp('mv-until','','date'))}</div>
    <div id="mv-cov" aria-live="polite" style="margin:8px 0"></div>
    <div class="dfoot"><button class="btn" type="button" data-act="close-drawer" id="mv-cancel">Cancel</button><button class="btn primary" type="submit" id="mv-submit" disabled>Move 0 units</button></div></form>`);
  updateMoveForm();
}
function updateMoveForm(){
  const f=$('#moveForm');if(!f)return;
  const to=val('mv-to'),ids=$$('input[name=mvu]:checked',f).map(x=>x.value).filter(id=>D.vehicles[id]&&D.vehicles[id].baseId!==to&&to);
  const same=$$('input[name=mvu]:checked',f).length-ids.length;
  $('#mv-untilwrap').hidden=!$('#mv-temp').checked;
  const eff=coverageEffect(ids,to);
  $('#mv-cov').innerHTML=(to&&ids.length?(eff.length?eff.map(e=>`<div class="cov-line${e.after<e.min&&e.after<e.before?' low':''}">${esc(e.name)}: ${e.before} \u2192 ${e.after} available (minimum ${e.min})${e.after<e.min&&e.after<e.before?' \u2014 below minimum':''}</div>`).join(''):'<div class="cov-line muted">No change in available units (the selected units are out of service).</div>'):'')
    +(to&&same?`<div class="cov-line muted">${same} selected ${same===1?'unit is':'units are'} already in ${esc(baseName(to))} and will be skipped.</div>`:'');
  const b=$('#mv-submit');b.textContent=`Move ${ids.length} ${ids.length===1?'unit':'units'}`;b.disabled=!ids.length;
}
FORMS.move=async f=>{
  const to=val('mv-to'),ids=$$('input[name=mvu]:checked',f).map(x=>x.value).filter(id=>D.vehicles[id]&&D.vehicles[id].baseId!==to);
  if(!to||!ids.length){toast('Pick at least one unit and a base to move to.',true);return;}
  const temp=$('#mv-temp').checked,until=val('mv-until');
  if(temp&&(!until||until<=todayStr())){toast('Pick a date in the future for the temporary move.',true);$('#mv-until').focus();return;}
  let n=0;
  if(await run(async()=>{n=await moveUnits(ids,to,val('mv-reason'),temp?until:null);},'Could not move the units. Some may have moved already.')){toast(`${n} ${n===1?'unit':'units'} moved to ${baseName(to)}`);closeDrawer();}
};


/* ---- actions ---- */
const dataId=el=>el.dataset.id;
export const acts:Record<string,any>={
  'close-drawer':()=>closeDrawer(),
  'cf-yes':()=>cfDone(true),'cf-no':()=>cfDone(false),
  'open-vehicle':el=>openVehicle(dataId(el)),
  'open-full':el=>openVehicle(dataId(el)),
  'nav-back':()=>goBack(),
  'drawer-back':()=>{const p=drawerBack.pop();if(p)openDrawer(p.type,p.id,'pop');else closeDrawer();},
  'open-issue':el=>openDrawer('issue',dataId(el),el.closest('#drawerRoot')?'push':'fresh'),
  'open-unit':el=>openDrawer('unit',dataId(el),'fresh'),
  'issue-wo':el=>{const i=D.issues[dataId(el)];if(!i)return;closeDrawer();openWoForm({vehicleId:i.vehicleId,issueIds:[i.id],pmTaskIds:[],type:'corrective'});},
  'move-units':el=>openMoveDrawer(el.dataset.id?[el.dataset.id]:[]),
  'ri-rm':el=>{const p=pending.splice(Number(el.dataset.i),1)[0];if(p&&p.preview)URL.revokeObjectURL(p.preview);renderThumbs();},
  'att-rm':async el=>{
    const coll=el.dataset.coll,id=el.dataset.id,asset=el.dataset.asset,a=((D[coll][id]||{}).attachments||[]).find(x=>x.assetId===asset);if(!a)return;
    if(!await confirmUI({title:'Remove this file?',message:`"${a.name}" will be removed from this record.`,label:'Remove file',danger:true}))return;
    if(await run(()=>removeAttachment(coll,id,asset)))toast('File removed');},
  'vtab':el=>{ui.vtab=el.dataset.tab;render();},
  'add-vehicle':()=>openVehicleForm(),
  'edit-vehicle':()=>openVehicleForm(D.vehicles[ui.vehicleId]),
  'change-status':el=>openStatusForm(D.vehicles[ui.vehicleId],el.dataset.to),
  'log-hours':()=>openHoursForm(D.vehicles[ui.vehicleId]),
  'report-issue':el=>openIssueForm(dataId(el)),
  'new-wo':el=>openWoForm({vehicleId:dataId(el)}),
  'pm-wo':el=>{const v=D.vehicles[dataId(el)];if(v)openWoForm({vehicleId:v.id,pmTaskIds:vsum(v).due.map(s=>s.task.id),type:'preventive'});},
  'wo-from-issues':()=>{const ids=ui.selIssues.filter(i=>D.issues[i]?.status==='open');if(!ids.length)return;openWoForm({vehicleId:D.issues[ids[0]].vehicleId,issueIds:ids,pmTaskIds:[],type:'corrective'});},
  'open-wo':el=>openDrawer('wo',dataId(el),el.closest('#drawerRoot')?'push':'fresh'),
  'wo-view':el=>{ui.f.wo.view=el.dataset.v;saveUi();render();},
  'accept-reading':el=>{const r=D.meterReadings[dataId(el)];if(r)run(()=>acceptReading(r)).then(ok=>ok&&toast('Reading accepted. Hours updated.'));},
  'dismiss-issue':async el=>{const i=D.issues[dataId(el)];if(!i)return;
    if(await confirmUI({title:'Dismiss this problem?',message:`"${i.title}" on ${unitOf(i.vehicleId)} will be marked dismissed and no work will be planned for it.`,label:'Dismiss',danger:true})){if(await run(()=>dismissIssue(i)))toast('Dismissed');}},
  'add-part':()=>openPartForm(),'edit-part':el=>openPartForm(D.parts[dataId(el)]),'receive-part':el=>openReceiveForm(D.parts[dataId(el)]),
  'add-mech':()=>openMechForm(),'edit-mech':el=>openMechForm(D.mechanics[dataId(el)]),
  'add-base':()=>openBaseForm(),'edit-base':el=>openBaseForm(D.bases[dataId(el)]),
  'add-program':()=>openProgramForm(),'edit-program':el=>openProgramForm(D.pmPrograms[dataId(el)]),
  'prog-addtask':()=>{const d=document.createElement('div');d.innerHTML=taskRow({});$('#pf-rows').appendChild(d.firstElementChild);const last=$('#pf-rows .trow:last-child input');if(last)last.focus();},
  'prog-rmtask':el=>el.closest('.trow').remove(),
  'lh-confirm':async()=>{const v=D.vehicles[$('#hoursForm').dataset.id];await saveReading(v,nv(val('lh-hours')),nv(val('lh-km')),true);},
  'lh-flag':async()=>{const v=D.vehicles[$('#hoursForm').dataset.id];await saveReading(v,nv(val('lh-hours')),nv(val('lh-km')),false);},
  'wo-rmline':async el=>{const wo=D.workOrders[ui.drawer.id];if(!wo)return;await run(()=>removeLine(wo.id,el.dataset.line));},
  'wo-notes':async()=>{if(await run(()=>patchWo(ui.drawer.id,{notes:$('#wo-notes').value})))toast('Notes saved');},
  'wo-act':async el=>{
    const id=ui.drawer.id,wo=D.workOrders[id],a=el.dataset.a,p:any={};if(!wo)return;
    if(a==='schedule')p.date=val('wo-sched');
    if(a==='start')p.expectedReturn=val('wo-eta')||null;
    if(a==='hold')p.reason=val('wo-hold');
    if(a==='complete'){p.hours=nv(val('wo-hrs'));p.km=nv(val('wo-km'));}
    if(a==='cancel'&&!await confirmUI({title:`Cancel ${wo.number}?`,message:'Linked problems go back to open. The unit’s status is not changed; use Return to service if it is ready.',label:'Cancel work order',danger:true}))return;
    el.disabled=true;
    const ok=await run(()=>woAction(id,a,p));
    el.disabled=false;
    if(ok)toast({approve:'Approved',schedule:'Scheduled',start:'Work started',hold:'Put on hold',resume:'Work resumed',complete:'Completed. PM records and stock updated.',close:'Closed',cancel:'Cancelled'}[a]);
  },
  'remove-sample':async el=>{
    if(!await confirmUI({title:'Remove sample data?',message:'Every record marked as sample data will be deleted. Records you added yourself stay.',label:'Remove sample data',danger:true}))return;
    el.disabled=true;if(await run(removeSample,'Could not remove all sample data.')){toast('Sample data removed');ui.vehicleId=D.vehicles[ui.vehicleId]?ui.vehicleId:null;}el.disabled=false;},
  'export-csv':el=>{const c=CSV[el.dataset.key];if(!c)return;saveBlob(c.filename,new Blob(['\ufeff'+toCsv(c.rows)],{type:'text/csv;charset=utf-8'}));}
};


export function wireEvents(){
/* ---- events ---- */
document.addEventListener('click',(e:any)=>{
  const el=e.target.closest('[data-act]');if(!el||el.disabled)return;
  const f=acts[el.dataset.act];if(f){if(el.tagName==='A')e.preventDefault();Promise.resolve(f(el,e)).catch(err=>console.error(err));}
});
document.addEventListener('submit',async (e:any)=>{
  const f=e.target.closest('form[data-form]');if(!f)return;e.preventDefault();
  const h=FORMS[f.dataset.form];if(!h)return;
  const b=f.querySelector('button[type=submit]');if(b)b.disabled=true;
  try{await h(f);}catch(err){console.error(err);toast('Something went wrong. Please try again.',true);}
  if(b&&document.contains(b))b.disabled=false;
});
document.addEventListener('input',(e:any)=>{
  const el=e.target,d=el.dataset||{};
  if(el.closest&&el.closest('#moveForm')){updateMoveForm();return;}
  if(d.filter){
    const [a,b]=d.filter.split('.');
    if(a==='period')ui.period=Number(el.value);else if(a==='hist')ui.f.hist=el.value;else ui.f[a][b]=el.value;
    saveUi();render();return;}
  if(d.sel!==undefined){const i=ui.selIssues.indexOf(d.sel);if(el.checked&&i<0)ui.selIssues.push(d.sel);if(!el.checked&&i>=0)ui.selIssues.splice(i,1);render();return;}
  if(d.woField){const id=ui.drawer?.id;if(id)run(()=>patchWo(id,{[d.woField]:el.value||null}));return;}
  switch(el.id){
    case 'ri-vehicle':updateIssueDup(true);break;
    case 'wf-vehicle':$('#wf-checks').innerHTML=woChecksHtml(el.value);break;
    case 'sc-to':{const v=D.vehicles[$('#statusForm').dataset.id];$('#sc-warn').innerHTML=statusWarnHtml(v,el.value);$('#sc-etawrap').hidden=el.value==='in_service';break;}
    case 'ln-kind':{$('#ln-partwrap').hidden=el.value!=='part';if(el.value==='labor'){$('#ln-cost').value=6000;}break;}
    case 'ln-part':{const p=D.parts[el.value];if(p){$('#ln-desc').value=p.description;$('#ln-cost').value=p.unitCost;}break;}
  }
});
document.addEventListener('keydown',(e:any)=>{
  if(e.key==='Escape'){if(closeMenus())return;if($('#confirmRoot .dlg'))cfDone(false);else if($('#drawerRoot .drawer'))closeDrawer();else escLayout();return;}
  if(e.key==='Tab'){
    const root=$('#confirmRoot .dlg')||$('#drawerRoot .drawer')||navRoot();if(!root)return;
    const f=$$('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',root).filter(x=>!x.closest('[hidden]'));
    if(!f.length)return;const first=f[0],last=f[f.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    else if(!root.contains(document.activeElement)){e.preventDefault();first.focus();}
  }
});
document.addEventListener('change',(e:any)=>{
  const el=e.target;if(el&&el.dataset&&el.dataset.perm!==undefined){syncPermsForm();return;}
  if(!el||el.type!=='file')return;
  const files=[...(el.files||[])];
  if(el.id==='ri-photos'||el.id==='ri-pdf'){el.value='';if(uploadsOn())addPending(files);return;}
  if(el.dataset.att){if(!uploadsOn()){el.value='';return;}const [coll,id]=el.dataset.att.split(':');el.value='';attachFiles(coll,id,files);}
});
document.addEventListener('click',(e:any)=>{if(e.target.closest&&e.target.closest('#nav a, .brand'))clearNavStack();},true);
window.addEventListener('hashchange',()=>{
  if(nav.skipNext){setSkipNext(false);viewChanged();return;}
  if(nav.pendingRestore){const e=nav.pendingRestore;setPendingRestore(null);if(route()===e.route)applyNav(e);else restoreNav(e);return;}
  const top=nav.navStack[nav.navStack.length-1];
  if(top&&top.route===route()){nav.navStack.pop();applyNav(top);return;}
  viewChanged();
});


}

Object.assign(FORMS,userForms);
Object.assign(acts,userActs);
Object.assign(acts,layoutActs);
