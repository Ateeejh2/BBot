import { instanceKey, type GameEvent, type Position } from '../core/types.js';
import type { CarePackageSchedule } from './brooke.js';

export type CarePackageInstanceState = 'ARMED' | 'STARTED' | 'CARRIER_DETECTED' | 'LAUNCHING' | 'DROPPED' | 'CHEST_DETECTED' | 'LAUNCH_FAILED';

interface Observation { at:number; position:Position }
interface TrackedInstance {
  timestamp:number; instanceId:string; state:CarePackageInstanceState;
  observations:Observation[]; startedAt?:number; area?:string; carrier?:Position; chest?:Position;
}

export interface CarePackageCarrierDetection { timestamp:number; instanceId:string; target:Position }
export interface CarePackageStartDetection { timestamp:number; instanceId:string; startedAt:number; area:string; target?:Position }
export interface CarePackageTrackingSnapshot {
  timestamp?:number;
  instances:Array<{instanceId:string;state:CarePackageInstanceState;startedAt?:number;area?:string;target?:Position}>;
}

export class CarePackageCoordinator {
  private tracked = new Map<string,TrackedInstance>();
  constructor(private schedule:CarePackageSchedule,
    private armLeadMs=60_000, private activeAfterMs=180_000,
    private clusterWindowMs=2_000, private clusterRadius=6, private clusterMin=3) {}

  trackingSnapshot(now:number):CarePackageTrackingSnapshot {
    this.prune(now);
    const scheduled=this.activeTimestamp(now);
    const active=[...this.tracked.values()].filter(v =>
      v.startedAt!==undefined ? now<=v.startedAt+this.activeAfterMs : scheduled!==undefined&&v.timestamp===scheduled);
    const timestamp=active.find(v=>v.startedAt!==undefined)?.timestamp??scheduled;
    return { timestamp, instances:active
      .filter(v=>timestamp===undefined||v.timestamp===timestamp)
      .map(v=>({instanceId:v.instanceId,state:v.state,startedAt:v.startedAt,area:v.area,target:v.chest??v.carrier})) };
  }

  observeAnnouncement(instanceId:string,text:string,now:number):CarePackageStartDetection|undefined {
    const announcement=parseCarePackageAnnouncement(text);
    if(!announcement)return;
    const timestamp=this.activeTimestamp(now);
    if(timestamp===undefined)return;
    const tracked=this.get(timestamp,instanceId);
    if(tracked.startedAt!==undefined)return;
    tracked.startedAt=now; tracked.area=announcement.area; tracked.state='STARTED';
    tracked.observations=tracked.observations.filter(v=>now-v.at<=this.clusterWindowMs);
    const target=this.clusterTarget(tracked.observations);
    if(target){tracked.carrier=target;tracked.state='CARRIER_DETECTED';tracked.observations=[];}
    return {timestamp,instanceId:tracked.instanceId,startedAt:now,area:announcement.area,target:target?{...target}:undefined};
  }

  observeChicken(instanceId:string, position:Position, now:number):CarePackageCarrierDetection|undefined {
    const timestamp=this.activeTimestampForInstance(instanceId,now);
    if(timestamp===undefined)return;
    const tracked=this.get(timestamp,instanceId);
    if(tracked.carrier)return;
    tracked.observations=tracked.observations.filter(v=>now-v.at<=this.clusterWindowMs);
    tracked.observations.push({at:now,position:{...position}});
    if(tracked.startedAt===undefined)return;
    const nearby=tracked.observations.filter(v=>horizontal(v.position,position)<=this.clusterRadius);
    if(nearby.length<this.clusterMin)return;
    const target=average(nearby);
    tracked.carrier=target; tracked.state='CARRIER_DETECTED'; tracked.observations=[];
    return {timestamp,instanceId:tracked.instanceId,target:{...target}};
  }

  markLaunch(instanceId:string,timestamp:number,state:'LAUNCHING'|'DROPPED'|'LAUNCH_FAILED'):void {
    const tracked=this.get(timestamp,instanceId);
    if (tracked.chest) return;
    tracked.state=state;
  }

  observeChest(instanceId:string, position:Position, now:number):GameEvent|undefined {
    const timestamp=this.activeTimestampForInstance(instanceId,now);
    if(timestamp===undefined)return;
    const tracked=this.get(timestamp,instanceId);
    if(tracked.startedAt===undefined||tracked.chest)return;
    tracked.chest={...position}; tracked.state='CHEST_DETECTED';
    return {
      id:`care-package:${timestamp}:${tracked.instanceId}`,
      instanceId:tracked.instanceId,
      type:'care-package',
      target:{...position},
      expiresAt:tracked.startedAt+this.activeAfterMs,
      metadata:{source:'brookeafk.com',scheduledAt:timestamp,startedAt:tracked.startedAt,area:tracked.area}
    };
  }

  expiresAt(instanceId:string,timestamp:number):number {
    const tracked=this.get(timestamp,instanceId);
    return (tracked.startedAt??timestamp)+this.activeAfterMs;
  }

  private activeTimestampForInstance(instanceId:string,now:number):number|undefined {
    const normalized=instanceKey(instanceId);
    const started=[...this.tracked.values()]
      .filter(v=>v.instanceId===normalized&&v.startedAt!==undefined&&now<=v.startedAt+this.activeAfterMs)
      .sort((a,b)=>(b.startedAt??0)-(a.startedAt??0))[0];
    return started?.timestamp??this.activeTimestamp(now);
  }

  private clusterTarget(observations:Observation[]):Position|undefined {
    for(const observation of observations){
      const nearby=observations.filter(v=>horizontal(v.position,observation.position)<=this.clusterRadius);
      if(nearby.length>=this.clusterMin)return average(nearby);
    }
    return;
  }

  private activeTimestamp(now:number):number|undefined {
    const source=this.schedule.eventsBetween?.(now-this.activeAfterMs,now+this.armLeadMs)??this.schedule.snapshot().events;
    return source.map(v=>v.timestamp)
      .filter(timestamp=>now>=timestamp-this.armLeadMs&&now<=timestamp+this.activeAfterMs)
      .sort((a,b)=>Math.abs(now-a)-Math.abs(now-b))[0];
  }
  private get(timestamp:number,instanceId:string):TrackedInstance {
    const normalized=instanceKey(instanceId),key=`${timestamp}:${normalized}`;
    let value=this.tracked.get(key);
    if(!value){value={timestamp,instanceId:normalized,state:'ARMED',observations:[]};this.tracked.set(key,value);}
    return value;
  }
  private prune(now:number):void {
    for(const [key,value] of this.tracked){
      const expiresAt=(value.startedAt??value.timestamp)+this.activeAfterMs;
      if(now>expiresAt)this.tracked.delete(key);
    }
  }
}
export function parseCarePackageAnnouncement(text:string):{area:string}|undefined {
  const normalized=text.replace(/§[0-9A-FK-OR]/gi,'').replace(/\s+/g,' ').trim();
  const match=/^MINOR EVENT!\s+CARE PACKAGE\s+in\s+(.+? Area)$/i.exec(normalized);
  const area=match?.[1]?.trim();
  if(!area||area.length>80)return;
  return {area};
}
function average(values:Observation[]):Position {
  return {
    x:values.reduce((sum,v)=>sum+v.position.x,0)/values.length,
    y:values.reduce((sum,v)=>sum+v.position.y,0)/values.length,
    z:values.reduce((sum,v)=>sum+v.position.z,0)/values.length
  };
}
function horizontal(a:Position,b:Position):number{return Math.hypot(a.x-b.x,a.z-b.z)}
