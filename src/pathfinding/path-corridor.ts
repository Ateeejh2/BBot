import type { Position } from '../core/types.js';

export function pathCorridorAffected(
  change:Position,
  current:Position,
  waypoints:Position[],
  fromIndex:number,
  horizontalRadius=2,
  verticalMargin=3
):boolean {
  let ax=current.x,ay=current.y,az=current.z;
  for(let i=fromIndex;i<waypoints.length;i++){
    const waypoint=waypoints[i]!;
    const horizontal=distanceToSegment2d(
      change.x+0.5,change.z+0.5,ax,az,waypoint.x,waypoint.z
    );
    const minY=Math.min(ay,waypoint.y)-verticalMargin;
    const maxY=Math.max(ay,waypoint.y)+verticalMargin;
    if(horizontal<=horizontalRadius&&change.y>=minY&&change.y<=maxY)return true;
    ax=waypoint.x;ay=waypoint.y;az=waypoint.z;
  }
  return false;
}

function distanceToSegment2d(
  px:number,pz:number,ax:number,az:number,bx:number,bz:number
):number {
  const dx=bx-ax,dz=bz-az,lengthSq=dx*dx+dz*dz;
  if(lengthSq<=1e-9)return Math.hypot(px-ax,pz-az);
  const t=Math.max(0,Math.min(1,((px-ax)*dx+(pz-az)*dz)/lengthSq));
  return Math.hypot(px-(ax+t*dx),pz-(az+t*dz));
}
