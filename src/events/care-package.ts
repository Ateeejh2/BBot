import { instanceKey, type GameEvent, type Position } from '../core/types.js';
import type { CarePackageSchedule } from './brooke.js';

export type CarePackageInstanceState = 'ARMED' | 'CARRIER_DETECTED' | 'LAUNCHING' | 'DROPPED' | 'CHEST_DETECTED' | 'LAUNCH_FAILED';

interface Observation { at:number; position:Position }
interface TrackedInstance {
  timestamp:number; instanceId:string; state:CarePackageInstanceState;
  observations:Observation[]; carrier?:Position; chest?:Position;
}

export interface CarePackageCarrierDetection { timestamp:number; instanceId:string; target:Position }
export interface CarePackageTrackingSnapshot {
  timestamp?:number;
  instances:Array<{instanceId:string;state:CarePackageInstanceState;target?:Position}>;
}

export class CarePackageCoordinator {
  private tracked = new Map<string,TrackedInstance>();
  constructor(private schedule:CarePackageSchedule,
    private armLeadMs=60_000, private activeAfterMs=180_000,
    private clusterWindowMs=2_000, private clusterRadius=6, private clusterMin=3) {}

  trackingSnapshot(now:number):CarePackageTrackingSnapshot {
    this.prune(now);
    const timestamp=this.activeTimestamp(now);
    return { timestamp, instances:[...this.tracked.values()]
      .filter(v=>timestamp!==undefined&&v.timestamp===timestamp)
      .map(v=>({instanceId:v.instanceId,state:v.state,target:v.chest??v.carrier})) };
  }

  observeChicken(instanceId:string, position:Position, now:number):CarePackageCarrierDetection|undefined {
    const timestamp=this.activeTimestamp(now);
    if(timestamp===undefined)return;
    const tracked=this.get(timestamp,instanceId);
    if(tracked.carrier)return;
    tracked.observations=tracked.observations.filter(v=>now-v.at<=this.clusterWindowMs);
    tracked.observations.push({at:now,position:{...position}});
    const nearby=tracked.observations.filter(v=>horizontal(v.position,position)<=this.clusterRadius);
    if(nearby.length<this.clusterMin)return;
    const target={
      x:nearby.reduce((sum,v)=>sum+v.position.x,0)/nearby.length,
      y:nearby.reduce((sum,v)=>sum+v.position.y,0)/nearby.length,
      z:nearby.reduce((sum,v)=>sum+v.position.z,0)/nearby.length
    };
    tracked.carrier=target; tracked.state='CARRIER_DETECTED'; tracked.observations=[];
    return {timestamp,instanceId:tracked.instanceId,target:{...target}};
  }

  markLaunch(instanceId:string,timestamp:number,state:'LAUNCHING'|'DROPPED'|'LAUNCH_FAILED'):void {
    const tracked=this.get(timestamp,instanceId);
    if (tracked.chest) return;
    tracked.state=state;
  }

  observeChest(instanceId:string, position:Position, now:number):GameEvent|undefined {
    const timestamp=this.activeTimestamp(now);
    if(timestamp===undefined)return;
    const tracked=this.get(timestamp,instanceId);
    if(tracked.chest)return;
    tracked.chest={...position}; tracked.state='CHEST_DETECTED';
    return {
      id:`care-package:${timestamp}:${tracked.instanceId}`,
      instanceId:tracked.instanceId,
      type:'care-package',
      target:{...position},
      expiresAt:timestamp+this.activeAfterMs,
      metadata:{source:'brookeafk.com',scheduledAt:timestamp}
    };
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
    for(const [key,value] of this.tracked)if(now>value.timestamp+this.activeAfterMs)this.tracked.delete(key);
  }
}
function horizontal(a:Position,b:Position):number{return Math.hypot(a.x-b.x,a.z-b.z)}
