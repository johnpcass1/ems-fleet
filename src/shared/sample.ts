// @ts-nocheck -- verbatim port of the prototype demo-data generator (dev/test only); not part of the production bundle
import { DAY, gyDate, addDays, p2 } from './pure';

/* Demo fleet from the approved prototype. Dates are relative to the moment it is built. Only used by seed:demo, the tests and the e2e run. */

export const PM_TASKS:any[]=[
  {id:'t-oil',name:'Engine oil & filter',group:'Engine & drivetrain',intervalHours:250,intervalDays:180,intervalKm:null},
  {id:'t-fuel',name:'Fuel filter',group:'Engine & drivetrain',intervalHours:500,intervalDays:365,intervalKm:null},
  {id:'t-air',name:'Air filter',group:'Engine & drivetrain',intervalHours:500,intervalDays:null,intervalKm:null},
  {id:'t-trans',name:'Transmission service',group:'Engine & drivetrain',intervalHours:1000,intervalDays:730,intervalKm:null},
  {id:'t-brake',name:'Brake inspection',group:'Brakes & tires',intervalHours:250,intervalDays:180,intervalKm:null},
  {id:'t-tire',name:'Tire rotation & check',group:'Brakes & tires',intervalHours:250,intervalDays:null,intervalKm:null},
  {id:'t-coolant',name:'Coolant service',group:'Engine & drivetrain',intervalHours:1500,intervalDays:730,intervalKm:null},
  {id:'t-battery',name:'Battery & charging test',group:'Electrical',intervalHours:null,intervalDays:90,intervalKm:null},
  {id:'t-lights',name:'Lights, siren & inverter check',group:'Electrical',intervalHours:null,intervalDays:30,intervalKm:null},
  {id:'t-ac',name:'A/C service',group:'Annual',intervalHours:null,intervalDays:365,intervalKm:null},
  {id:'t-o2',name:'Oxygen system & stretcher mount check',group:'Patient compartment',intervalHours:null,intervalDays:30,intervalKm:null},
  {id:'t-annual',name:'Annual safety inspection',group:'Annual',intervalHours:null,intervalDays:365,intervalKm:null}
];

export function buildSample():any{
  const now=Date.now(),today=gyDate(now);
  const ago=n=>new Date(now-n*DAY-3*36e5).toISOString();   // timestamp n days ago
  const dAgo=n=>addDays(today,-n);                          // date n days ago
  let seed=20261105;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const out:any={bases:[],pmPrograms:[],vehicles:[],meterReadings:[],statusEvents:[],issues:[],workOrders:[],parts:[],mechanics:[],settings:[]};
  const put=(c:string,id:string,o:any)=>out[c].push({id,...o,sample:true});

  [['b-hq','HQ','Georgetown, Region 4',4],['b-diamond','Diamond','Region 4',2],['b-linden','Linden','Region 10',2],['b-newamsterdam','New Amsterdam','Region 6',2],['b-lethem','Lethem','Region 9',1]]
    .forEach(([id,name,region,minUnits])=>put('bases',id,{name,region,minUnits}));
  put('settings','main',{approvalThresholdGYD:150000,dueSoonHours:25,dueSoonDays:14,comebackDays:30});
  put('pmPrograms','pm-type2',{name:'Type II ambulance — engine hours (example intervals)',appliesTo:'Type II ambulance',tasks:PM_TASKS});

  const mech=[['m-1','Demerara Auto Works (example)','Ruimveldt, Georgetown','592-600-0101','Region 4'],['m-2','Linden Motor Clinic (example)','Wismar, Linden','592-600-0102','Region 10'],
    ['m-3','Berbice Fleet Service (example)','New Amsterdam','592-600-0103','Region 6'],['m-4','Rupununi Garage (example)','Lethem','592-600-0104','Region 9'],['m-5','Diamond Diesel & Electrical (example)','East Bank Demerara','592-600-0105','Region 4']];
  mech.forEach(([id,name,shop,phone,region])=>put('mechanics',id,{name,shop,phone,region}));

  const P=[['p-oilf','P-1001','Engine oil filter','Toyota HiAce, Ford Transit',24,10,4500],['p-oil','P-1002','Engine oil 5W-30 (per litre)','All engines',80,40,4000],
    ['p-fuelf','P-1003','Fuel filter','Toyota HiAce, Ford Transit',12,6,12500],['p-airf','P-1004','Air filter','Toyota HiAce, Ford Transit',10,6,9800],
    ['p-pad','P-1005','Front brake pad set','Toyota HiAce, Ford Transit',3,6,38000],['p-rotor','P-1006','Front brake rotor (pair)','Toyota HiAce, Ford Transit',4,2,56000],
    ['p-tire','P-1007','Tire 235/65R16 LT','All units',8,4,48000],['p-batt','P-1008','Battery 12V 100Ah','All units',3,2,62000],
    ['p-alt','P-1009','Alternator (remanufactured)','Toyota HiAce',1,1,165000],['p-siren','P-1010','Siren controller and speaker kit','All units',2,1,165000],
    ['p-led','P-1011','Rear warning light module (LED)','All units',4,2,42000],['p-atf','P-1012','Transmission fluid (per litre)','All units',4,10,4000],
    ['p-cool','P-1013','Coolant 50/50 (per litre)','All units',30,15,4200],['p-arm','P-1014','Front suspension control arm','Toyota HiAce',0,2,78000],
    ['p-accomp','P-1015','A/C compressor','Ford Transit',1,1,180000]];
  P.forEach(([id,number,description,fits,onHand,reorderPoint,unitCost])=>put('parts',id,{number,description,fits,onHand,reorderPoint,unitCost}));

  /* vehicles */
  const baseOf=n=>n<=7?'b-hq':n<=10?'b-diamond':n<=14?'b-linden':n<=18?'b-newamsterdam':'b-lethem';
  const stat={5:['limited','Rear siren works only intermittently. Use with caution.',null],7:['reserve','Held as backup unit.',null],10:['reserve','Held as backup unit.',null],
    12:['oos_repair','Transmission slipping in drive (critical problem reported)',5],13:['oos_parts','Waiting for front suspension control arm',9],14:['oos_pm','Scheduled engine service in progress',1]};
  const rateOv={1:3.0,18:4.0};
  const V:any={};
  for(let n=1;n<=20;n++){
    const i=n-1,year=2022+(i*7)%4,toy=i%2===0;
    const rate=rateOv[n]||(2+rnd()*6+(n<=7?1.5:0));
    const engNow=n===3?4215:Math.round(300+(2025-year)*1000+rnd()*800);
    const lastD=[1,2,3][i%3];
    const hAt=d=>Math.max(0,Math.round(engNow-rate*(d-1)));
    const eng=hAt(lastD);
    const km=n===3?138500:Math.round(eng*27+rnd()*4000+300);
    const kmPerH=km/Math.max(eng,1);
    const [status,reason,ret]=stat[n]||['in_service','',null];
    V[n]={n,id:'v-'+String(n).padStart(2,'0'),year,rate,eng,km,kmPerH,hAt,lastD,status,reason,ret};
    const m=1+i%9;
    put('vehicles',V[n].id,{unit:'GEMA-'+String(n).padStart(2,'0'),plate:`P${'ABCDEFGHJKLMNPRSTUVW'[i]}${'KMNPR'[i%5]} ${1200+i*173}`,vin:`SMPL${year}${String(900000+i*37).padStart(9,'0')}`.slice(0,17).padEnd(17,'0'),
      make:toy?'Toyota':'Ford',model:toy?'HiAce Ambulance':'Transit Ambulance',year,type:'Type II ambulance',baseId:baseOf(n),inServiceDate:`${year}-${p2(m)}-15`,
      status,statusReason:reason,statusSince:null,expectedReturn:ret!=null?dAgo(-ret):null,engineHours:eng,odometerKm:km,pmProgramId:'pm-type2',pm:{},
      warrantyEnd:`${year+3}-${p2(m)}-15`,notes:''});
  }
  /* PM last records: ok by default, with scenario overrides */
  const ov={2:{'t-oil':{rem:12}},3:{'t-oil':{rem:-30}},4:{'t-battery':{dRem:9}},6:{'t-fuel':{rem:20},'t-lights':{dRem:5}},9:{'t-brake':{rem:-35},'t-tire':{rem:-12}},
    11:{'t-air':{rem:18}},14:{'t-oil':{rem:-10}},15:{'t-trans':{rem:22}},16:{'t-battery':{dRem:-8},'t-lights':{dRem:-3}},18:{'t-ac':{dRem:-12}},19:{'t-annual':{dRem:10}}};
  const fixed={1:{'t-oil':50,'t-brake':50,'t-tire':50},18:{'t-battery':19,'t-lights':19}};   // done by sample work orders N days ago
  const vObjs=out.vehicles;
  for(let n=1;n<=20;n++){
    const v=V[n],pm={};
    for(const t of PM_TASKS){
      if(n===17&&t.id==='t-o2')continue;                      // never done
      const o=(ov[n]||{})[t.id]||{};
      const f=(fixed[n]||{})[t.id];
      let lastHours=null,lastDate=null,lastKm=null;
      if(t.intervalHours){
        let rem=o.rem!=null?o.rem:Math.max(40,t.intervalHours*(0.2+rnd()*0.6));
        lastHours=Math.max(0,Math.round(v.eng-(t.intervalHours-rem)));
        if(f)lastHours=v.hAt(f);
        const elapsedH=v.eng-lastHours;
        let days=Math.round(elapsedH/v.rate);if(t.intervalDays)days=Math.min(days,Math.round(t.intervalDays*0.7));
        lastDate=dAgo(f||Math.max(days,1));
        lastKm=Math.max(0,Math.round(v.km-elapsedH*v.kmPerH));
      }else if(t.intervalDays){
        const dRem=o.dRem!=null?o.dRem:Math.min(t.intervalDays,Math.max(16,Math.round(t.intervalDays*(0.25+rnd()*0.55))));
        lastDate=f?dAgo(f):addDays(today,dRem-t.intervalDays);
        lastKm=Math.max(0,Math.round(v.km-(t.intervalDays-dRem)*v.rate*v.kmPerH));
      }
      pm[t.id]={lastHours,lastKm,lastDate};
    }
    vObjs[n-1].pm=pm;
  }
  /* meter readings */
  let mr=0;
  for(let n=1;n<=20;n++){
    const v=V[n];const days=n%5<2?[30,v.lastD]:[44,14,v.lastD];
    days.forEach((d,k)=>put('meterReadings','mr-'+String(++mr).padStart(3,'0'),{vehicleId:v.id,at:ago(d),hours:v.hAt(d),km:Math.round(v.km-(v.hAt(v.lastD)-v.hAt(d))*v.kmPerH),source:k===days.length-1&&n%4===0?'inspection':'manual',by:null,flagged:false}));
  }
  put('meterReadings','mr-flag',{vehicleId:V[9].id,at:ago(0.5),hours:V[9].eng-420,km:null,source:'manual',by:null,flagged:true});
  put('meterReadings','mr-wo5',{vehicleId:V[18].id,at:ago(19),hours:Math.max(0,V[18].hAt(19)),km:null,source:'work_order',by:null,flagged:false});

  /* issues */
  const I=(n,id,vn,title,description,severity,status,d,woId)=>put('issues',id,{vehicleId:V[vn].id,title,description,severity,status,reportedAt:ago(d),by:null,woId:woId||null,hours:V[vn].hAt(d)});
  I(1,'i-01',12,'Transmission slipping','Loses power in drive on the Linden-Mackenzie road. Engine revs but the unit does not pull.','critical','in_work_order',3,'wo-09');
  I(2,'i-02',13,'Front suspension arm cracked','Crack found on the left front control arm during a pre-trip check. Unit pulls left.','critical','in_work_order',14,'wo-10');
  I(3,'i-03',5,'Rear siren intermittent','Siren cuts out when the unit goes over bumps. Lights are fine.','major','in_work_order',6,'wo-15');
  I(4,'i-04',2,'Cab A/C weak','Air is only slightly cool even on max.','minor','open',4);
  I(5,'i-05',9,'Brake pedal feels soft','Pedal travels further than normal. Stops fine at low speed.','major','in_work_order',5,'wo-13');
  I(6,'i-06',11,'Stretcher latch sticks','Rear stretcher latch needs two tries to lock.','minor','open',2);
  I(7,'i-07',16,'Alternator warning light','Battery light on after starting.','major','resolved',34,'wo-04');
  I(8,'i-08',3,'Rattle in rear door','Crew heard a rattle; mechanic could not find anything.','minor','dismissed',40);
  I(9,'i-09',18,'Interior light out','Patient compartment ceiling light not working.','minor','resolved',25);
  I(10,'i-10',6,'Oil leak under engine','Small oil spots on the ground after a night parked.','major','open',1);

  /* work orders */
  const L=(kind,description,repairCode,qty,unitCost,partId,warranty)=>({id:'',kind,description,repairCode,qty,unitCost,partId:partId||null,warranty:!!warranty});
  const lab=(d,code,h)=>L('labor',d,code,h,6000);
  const prt=(pid,qty,code)=>{const p=P.find(x=>x[0]===pid);return L('part',p[2],code,qty,p[6],pid);};
  const WOS=[
    {n:1,vn:3,type:'corrective',pr:'high',st:'closed',op:101,sch:100,sta:100,com:94,clo:93,mech:'m-1',iss:[],pm:[],lines:[lab('Replace front brake pads and rotors','Brakes',4),prt('p-pad',1,'Brakes'),prt('p-rotor',1,'Brakes')],notes:'Brake fault reported by crew.'},
    {n:2,vn:8,type:'accident',pr:'high',st:'closed',op:76,sch:75,sta:74,com:62,clo:61,mech:'m-5',iss:[],pm:[],holds:[{reason:'approval',from:74,to:72}],appr:true,lines:[lab('Rear panel repair and re-fit','Body',24),L('outside','Panel beating and paint (outside shop)','Body',1,185000),prt('p-led',1,'Lights & siren')],notes:'Rear-end collision, no injuries.'},
    {n:3,vn:1,type:'preventive',pr:'normal',st:'closed',op:53,sch:52,sta:52,com:50,clo:50,mech:'m-1',iss:[],pm:['t-oil','t-brake','t-tire'],od:0,lines:[lab('Engine oil, brake and tire service','Engine',3),prt('p-oilf',1,'Engine'),prt('p-oil',8,'Engine')],notes:''},
    {n:4,vn:16,type:'corrective',pr:'high',st:'closed',op:34,sch:33,sta:33,com:30,clo:29,mech:'m-3',iss:['i-07'],pm:[],appr:true,lines:[lab('Replace alternator and test charging','Electrical',5),prt('p-alt',1,'Electrical')],notes:''},
    {n:5,vn:18,type:'preventive',pr:'normal',st:'completed',op:21,sch:20,sta:20,com:19,mech:'m-3',iss:[],pm:['t-battery','t-lights'],od:1,lines:[lab('Battery test and lights/siren check','Electrical',2)],notes:''},
    {n:6,vn:9,type:'preventive',pr:'normal',st:'closed',op:91,sch:90,sta:90,com:89,clo:88,mech:'m-5',iss:[],pm:['t-oil','t-brake'],od:1,lines:[lab('Oil and brake service','Engine',3),prt('p-oilf',1,'Engine'),prt('p-oil',8,'Engine')],notes:''},
    {n:7,vn:19,type:'corrective',pr:'urgent',st:'closed',op:71,sch:71,sta:70,com:66,clo:65,mech:'m-4',iss:[],pm:[],holds:[{reason:'parts',from:68,to:66}],lines:[lab('Replace control arm and align','Suspension',8),prt('p-arm',1,'Suspension')],notes:'Part flown in from Georgetown.'},
    {n:8,vn:4,type:'inspection',pr:'low',st:'cancelled',op:28,mech:null,iss:[],pm:[],lines:[],notes:'Duplicate of the annual inspection already booked.'},
    {n:9,vn:12,type:'corrective',pr:'urgent',st:'in_progress',op:3,sch:3,sta:2.5,mech:'m-2',iss:['i-01'],pm:[],appr:true,lines:[lab('Remove and repair transmission','Transmission',12),prt('p-atf',12,'Transmission'),L('outside','Valve body rebuild kit (outside shop)','Transmission',1,160000)],notes:'Diagnosed as valve body fault.'},
    {n:10,vn:13,type:'corrective',pr:'urgent',st:'on_hold',hold:'parts',op:14,sch:14,sta:13,mech:'m-2',iss:['i-02'],pm:[],holds:[{reason:'parts',from:11,to:null}],lines:[lab('Replace front control arm','Suspension',6),prt('p-arm',1,'Suspension')],notes:'Part on order. Out of stock.'},
    {n:11,vn:16,type:'corrective',pr:'normal',st:'open',op:6,mech:null,iss:[],pm:[],lines:[lab('Diagnose charging fault (estimate)','Electrical',3)],notes:'Charging warning light came back after the alternator job.'},
    {n:12,vn:14,type:'preventive',pr:'high',st:'in_progress',op:2,sch:1,sta:1,mech:'m-2',iss:[],pm:['t-oil','t-air'],od:1,lines:[lab('Engine oil and air filter service','Engine',3),prt('p-oilf',1,'Engine'),prt('p-oil',8,'Engine'),prt('p-airf',1,'Engine')],notes:''},
    {n:13,vn:9,type:'corrective',pr:'high',st:'approved',op:5,mech:'m-1',iss:['i-05'],pm:[],appr:true,lines:[lab('Inspect and repair brake system','Brakes',6),prt('p-pad',1,'Brakes'),prt('p-rotor',1,'Brakes'),L('outside','Caliper rebuild (outside shop)','Brakes',1,80000)],notes:''},
    {n:14,vn:3,type:'preventive',pr:'normal',st:'scheduled',op:3,schFor:1,mech:'m-1',iss:[],pm:['t-oil'],od:1,lines:[lab('Engine oil service','Engine',2),prt('p-oilf',1,'Engine'),prt('p-oil',8,'Engine')],notes:''},
    {n:15,vn:5,type:'corrective',pr:'high',st:'open',op:5,mech:null,iss:['i-03'],pm:[],appr:false,lines:[lab('Replace siren controller and speaker','Lights & siren',3),prt('p-siren',1,'Lights & siren')],notes:'Needs approval: over the threshold.'}
  ];
  const woId=n=>'wo-'+String(n).padStart(2,'0');
  const thr=150000;
  WOS.forEach(w=>{
    const v=V[w.vn];
    const lines=w.lines.map((l,k)=>({...l,id:`l${k+1}`}));
    const total=lines.reduce((s,l)=>s+(l.warranty?0:l.qty*l.unitCost),0);
    const needs=total>=thr;
    put('workOrders',woId(w.n),{number:'WO-'+String(w.n).padStart(4,'0'),vehicleId:v.id,type:w.type,priority:w.pr,status:w.st,holdReason:w.hold||null,mechanicId:w.mech,
      issueIds:w.iss,pmTaskIds:w.pm,openedAt:ago(w.op),scheduledFor:w.schFor!=null?dAgo(-w.schFor):(w.sch!=null?dAgo(w.sch):null),startedAt:w.sta!=null?ago(w.sta):null,
      completedAt:w.com!=null?ago(w.com):null,closedAt:w.clo!=null?ago(w.clo):null,hoursAtOpen:v.hAt(w.op),hoursAtComplete:w.com!=null?Math.max(1,v.hAt(w.com)):null,
      kmAtComplete:w.com!=null?Math.max(1,Math.round(v.km-(v.eng-v.hAt(w.com))*v.kmPerH)):null,lines,notes:w.notes,approvalNeeded:needs,approvedBy:null,by:null,
      overdueAtOpen:w.od||0,holdLog:(w.holds||[]).map(h=>({reason:h.reason,from:ago(h.from),to:h.to!=null?ago(h.to):null}))});
  });

  /* status events */
  let ev=0;
  const E=(vn,from,to,d,reason,wo)=>put('statusEvents','se-'+String(++ev).padStart(3,'0'),{vehicleId:V[vn].id,from,to,reason,at:ago(d),by:null,woId:wo?woId(wo):null});
  E(2,'in_service','oos_pm',105,'Scheduled service');E(2,'oos_pm','in_service',104,'Service done');
  E(6,'in_service','oos_repair',110,'Cooling fan fault');E(6,'oos_repair','in_service',108,'Repaired');
  E(7,'in_service','reserve',80,'Moved to reserve fleet');E(10,'in_service','reserve',60,'Moved to reserve fleet');
  E(3,'in_service','oos_repair',100,'Brake fault',1);E(3,'oos_repair','in_service',94,'Brakes repaired',1);
  E(8,'in_service','oos_accident',75,'Collision, rear damage',2);E(8,'oos_accident','in_service',61,'Repairs complete',2);
  E(1,'in_service','oos_pm',52,'Scheduled service',3);E(1,'oos_pm','in_service',50,'Service done',3);
  E(16,'in_service','oos_repair',33,'Charging fault',4);E(16,'oos_repair','in_service',30,'Alternator replaced',4);
  E(18,'in_service','oos_pm',20,'Scheduled service',5);E(18,'oos_pm','in_service',19,'Service done',5);
  E(9,'in_service','oos_pm',90,'Scheduled service',6);E(9,'oos_pm','in_service',89,'Service done',6);
  E(19,'in_service','oos_repair',70,'Suspension fault',7);E(19,'oos_repair','oos_parts',68,'Waiting for control arm',7);E(19,'oos_parts','in_service',66,'Repaired',7);
  E(15,'in_service','limited',40,'Left rear door seal worn');E(15,'limited','in_service',35,'Seal replaced');
  E(13,'in_service','oos_repair',14,'Critical: front suspension arm cracked',10);E(13,'oos_repair','oos_parts',11,'Waiting for front suspension control arm',10);
  E(12,'in_service','oos_repair',3,'Critical: transmission slipping',9);
  E(14,'in_service','oos_pm',1,'Scheduled engine service',12);
  E(5,'in_service','limited',6,'Rear siren works only intermittently. Use with caution.');
  /* statusSince from the latest event */
  vObjs.forEach(v=>{
    const es=out.statusEvents.filter(e=>e.vehicleId===v.id).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
    v.statusSince=es.length?es[0].at:v.inServiceDate+'T12:00:00.000Z';
  });
  return out;
}
export const SAMPLE_COLS=['bases','settings','pmPrograms','mechanics','parts','vehicles','meterReadings','issues','workOrders','statusEvents'];
