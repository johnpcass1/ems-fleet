import { test, describe, it, expect } from 'vitest';
import assert from 'node:assert';
import { pmTaskStatus, avgHoursPerDay, projectDue, computeAvailability, checkReading, nextWoNumber, woTotal, isComeback, hoursAt, addDays, daysBetween, gyDate, toCsv } from '../../src/shared/pure';

// Ported from the prototype's pure-function tests (34 tests), unchanged in meaning.
const t=(name:string,fn:()=>void)=>test(name,fn);
const S={dueSoonHours:25,dueSoonDays:14,dueSoonKm:1000};
const oil={id:'o',intervalHours:250,intervalDays:180,intervalKm:null};
const cur={hours:1000,km:30000,date:'2026-11-05'};
t('ok state',()=>{const r=pmTaskStatus(oil,{lastHours:900,lastDate:'2026-10-01'},cur,S);assert.equal(r.state,'ok');assert.equal(r.nextDueHours,1150);assert.equal(r.hoursRemaining,150);assert.equal(r.nextDueDate,'2027-03-30');});
t('due soon by hours',()=>{const r=pmTaskStatus(oil,{lastHours:775,lastDate:'2026-10-01'},cur,S);assert.equal(r.hoursRemaining,25);assert.equal(r.state,'due_soon');});
t('26 h left is ok',()=>assert.equal(pmTaskStatus(oil,{lastHours:776,lastDate:'2026-10-01'},cur,S).state,'ok'));
t('overdue at exactly due',()=>assert.equal(pmTaskStatus(oil,{lastHours:750,lastDate:'2026-10-01'},cur,S).state,'overdue'));
t('overdue negative remaining',()=>{const r=pmTaskStatus(oil,{lastHours:700,lastDate:'2026-10-01'},cur,S);assert.equal(r.state,'overdue');assert.equal(r.hoursRemaining,-50);});
t('worst across bases (days overdue, hours ok)',()=>{const r=pmTaskStatus(oil,{lastHours:900,lastDate:'2026-05-01'},cur,S);assert.equal(r.state,'overdue');assert.equal(r.bases.hours,'ok');assert.equal(r.bases.days,'overdue');});
t('due soon by days',()=>{const bat={id:'b',intervalDays:90};const r=pmTaskStatus(bat,{lastDate:addDays('2026-11-05',-80)},cur,S);assert.equal(r.daysRemaining,10);assert.equal(r.state,'due_soon');assert.equal(r.hoursRemaining,null);});
t('km window 1000',()=>{const k={id:'k',intervalKm:10000};assert.equal(pmTaskStatus(k,{lastKm:20500},cur,S).state,'due_soon');assert.equal(pmTaskStatus(k,{lastKm:21001},cur,S).state,'ok');assert.equal(pmTaskStatus(k,{lastKm:20000},cur,S).state,'overdue');});
t('never done',()=>{const r=pmTaskStatus(oil,null,cur,S);assert.equal(r.never,true);assert.equal(r.state,'overdue');assert.equal(r.hoursRemaining,0);});
t('projection hours',()=>{const r=pmTaskStatus(oil,{lastHours:800,lastDate:'2026-10-01'},cur,S);assert.equal(r.hoursRemaining,50);assert.equal(projectDue(r,5,'2026-11-05'),'2026-11-15');});
t('projection picks earlier of date/hours',()=>{const r=pmTaskStatus(oil,{lastHours:900,lastDate:'2026-05-10'},cur,S);assert.equal(projectDue(r,1,'2026-11-05'),r.nextDueDate);});
t('projection null without rate',()=>{const r=pmTaskStatus({id:'x',intervalHours:100},{lastHours:950},cur,S);assert.equal(projectDue(r,null,'2026-11-05'),null);});
const now=Date.parse('2026-11-05T16:00:00Z');const D=864e5;
const rd=(d:number,h:number,f?:boolean)=>({at:new Date(now-d*D).toISOString(),hours:h,flagged:!!f});
t('avg rate 30 days',()=>assert.equal(avgHoursPerDay([rd(25,100),rd(5,200),rd(0,220)],now),4.8));
t('avg ignores flagged',()=>assert.equal(avgHoursPerDay([rd(20,100),rd(10,9999,true),rd(0,200)],now),5));
t('avg fallback overall',()=>assert.equal(avgHoursPerDay([rd(100,100),rd(0,300)],now),2));
t('avg null',()=>assert.equal(avgHoursPerDay([rd(0,100)],now),null));
t('checkReading lower',()=>assert.equal(checkReading(500,null,490,now).length,1));
t('checkReading >24h/day',()=>assert.equal(checkReading(500,{hours:500,at:new Date(now-2*D).toISOString()},560,now).length,1));
t('checkReading ok 24h/day boundary',()=>assert.equal(checkReading(500,{hours:500,at:new Date(now-2*D).toISOString()},548,now).length,0));
t('checkReading same day',()=>assert.equal(checkReading(500,{hours:500,at:new Date(now-3600e3).toISOString()},530,now).length,1));
t('nextWoNumber',()=>{assert.equal(nextWoNumber([]),'WO-0001');assert.equal(nextWoNumber([{number:'WO-0012'},{number:'WO-0003'}]),'WO-0013');});
t('woTotal excludes warranty',()=>assert.equal(woTotal({lines:[{qty:2,unitCost:6000},{qty:1,unitCost:100000,warranty:true}]}),12000));
// availability
const day=D,start=now-10*day,end=now;
const ev=(v:string,from:string,to:string,d:number)=>({vehicleId:v,from,to,at:new Date(now-d*day).toISOString()});
t('availability: no events uses current status',()=>{const r=computeAvailability([{id:'a',status:'in_service'},{id:'b',status:'oos_repair'}],[],start,end);assert.equal(Math.round(r.pct!),50);});
t('availability: replay events',()=>{ // a: in service 10d, out last 4d => 60%
  const r=computeAvailability([{id:'a',status:'oos_repair'}],[ev('a','in_service','oos_repair',4)],start,end);assert.ok(Math.abs(r.pct!-60)<1e-6,String(r.pct));assert.ok(Math.abs(r.downByStatus.oos_repair-4*day)<1);});
t('availability: state before period from earlier event',()=>{
  const r=computeAvailability([{id:'a',status:'in_service'}],[ev('a','in_service','oos_pm',20),ev('a','oos_pm','in_service',5)],start,end);assert.ok(Math.abs(r.pct!-50)<1e-6,String(r.pct));});
t('availability: decommissioned excluded',()=>{
  const r=computeAvailability([{id:'a',status:'decommissioned'}],[ev('a','in_service','decommissioned',5)],start,end);assert.ok(Math.abs(r.pct!-100)<1e-6);assert.equal(r.totalMs,5*day);});
t('availability: reserve/limited count as available',()=>{
  const r=computeAvailability([{id:'a',status:'limited'}],[ev('a','reserve','limited',5)],start,end);assert.equal(r.pct!,100);});
t('availability: all decommissioned -> null',()=>assert.equal(computeAvailability([{id:'a',status:'decommissioned'}],[],start,end).pct,null));
// comeback
const wo=(id:string,o?:any)=>({id,vehicleId:'v',type:'corrective',status:'open',openedAt:new Date(now-5*D).toISOString(),lines:[{repairCode:'Electrical'}],...o});
t('comeback within window',()=>assert.ok(isComeback(wo('b'),[wo('a',{status:'completed',completedAt:new Date(now-30*D).toISOString(),openedAt:new Date(now-33*D).toISOString()})],30)));
t('comeback outside window',()=>assert.ok(!isComeback(wo('b'),[wo('a',{status:'closed',completedAt:new Date(now-40*D).toISOString()})],30)));
t('comeback different code',()=>assert.ok(!isComeback(wo('b'),[wo('a',{status:'closed',completedAt:new Date(now-10*D).toISOString(),lines:[{repairCode:'Brakes'}]})],30)));
t('hoursAt interpolates',()=>assert.equal(hoursAt([rd(10,100),rd(0,200)],now-5*D),150));
t('Guyana date is UTC-4',()=>assert.equal(gyDate(Date.parse('2026-11-05T02:00:00Z')),'2026-11-04'));
t('csv quoting',()=>assert.equal(toCsv([['a','b,c','d"e']]),'a,"b,c","d""e"'));

import { fmtMoney, roundMoney, currencyOf } from '../../src/shared/constants';
describe('money formatting by currency', () => {
  it('formats G$ without cents and other currencies with cents', () => {
    expect(fmtMoney(150000, 'GYD')).toBe('G$ 150,000');
    expect(fmtMoney(1234.5, 'USD')).toBe('$ 1,234.50');
    expect(fmtMoney(12, 'EUR')).toBe('€ 12.00');
    expect(fmtMoney(99.6)).toBe('G$ 100');
    expect(fmtMoney('x', 'USD')).toBe('$ 0.00');
  });
  it('unknown codes fall back to the Guyana dollar; rounding follows the currency', () => {
    expect(currencyOf('ZZZ').code).toBe('GYD');
    expect(roundMoney(10.37125, 'USD')).toBe(10.37);
    expect(roundMoney(100.67, 'GYD')).toBe(101);
  });
});
