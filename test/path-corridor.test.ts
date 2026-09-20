import test from 'node:test';
import assert from 'node:assert/strict';
import { pathCorridorAffected } from '../src/pathfinding/path-corridor.js';

test('dynamic block on the remaining path corridor requests a replan', () => {
  const current={x:2.5,y:64,z:2.5};
  const waypoints=[
    {x:8.5,y:64,z:2.5},
    {x:12.5,y:64,z:6.5}
  ];
  assert.equal(pathCorridorAffected({x:5,y:64,z:2},current,waypoints,0),true);
});

test('dynamic block far from the remaining path corridor is ignored', () => {
  const current={x:2.5,y:64,z:2.5};
  const waypoints=[
    {x:8.5,y:64,z:2.5},
    {x:12.5,y:64,z:6.5}
  ];
  assert.equal(pathCorridorAffected({x:5,y:64,z:20},current,waypoints,0),false);
});

test('already completed path segments are not considered', () => {
  const current={x:8.5,y:64,z:2.5};
  const waypoints=[
    {x:8.5,y:64,z:2.5},
    {x:12.5,y:64,z:6.5}
  ];
  assert.equal(pathCorridorAffected({x:4,y:64,z:2},current,waypoints,1),false);
});
