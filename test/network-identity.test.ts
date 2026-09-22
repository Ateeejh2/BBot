import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NetworkIdentityMonitor,
  assessNetworkIdentityRisk,
  summarizeRecentNetworkChanges,
  type NetworkIdentityLookup,
  type NetworkIdentityPoint
} from '../src/runtime/network-identity.js';

const lookup = (ip:string, asn=64500, countryCode='JP'):NetworkIdentityLookup =>
  async () => ({ ip, asn, country:'Japan', countryCode, region:'Tokyo', city:'Tokyo', organization:'Example Network' });

test('network identity persists a baseline and detects a later public network change', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bbot-network-'));
  try{
    const first=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.10'));
    await first.refresh();
    const initial=first.snapshot();
    assert.equal(initial.status,'OK');
    assert.equal(initial.current?.ip,'203.0.113.10');
    assert.equal(initial.current?.country,'Japan');
    assert.equal(initial.previous,undefined);
    assert.equal(initial.ipChanged,undefined);
    assert.equal(initial.changed,false);
    first.close();

    const second=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.11',64501));
    await second.refresh();
    const changed=second.snapshot();
    assert.equal(changed.previous?.ip,'203.0.113.10');
    assert.equal(changed.current?.ip,'203.0.113.11');
    assert.equal(changed.changed,true);
    assert.equal(changed.ipChanged,true);
    assert.equal(changed.recentChanges?.ip,1);
    assert.equal(changed.recentChanges?.asn,1);
    second.close();

    const third=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.11',64501));
    await third.refresh();
    const stable=third.snapshot();
    assert.equal(stable.previous?.ip,'203.0.113.11');
    assert.equal(stable.ipChanged,false);
    assert.equal(stable.changed,false);
    assert.equal(stable.recentChanges?.ip,1);
    third.close();
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

const point = (overrides: Partial<NetworkIdentityPoint> = {}):NetworkIdentityPoint => ({
  ip:'203.0.113.10',
  asn:64500,
  country:'Japan',
  countryCode:'JP',
  region:'Tokyo',
  city:'Tokyo',
  organization:'Example Network',
  observedAt:1,
  ...overrides
});

test('network identity risk levels are transparent and bounded', () => {
  const same=assessNetworkIdentityRisk(point(),point({observedAt:2}));
  assert.equal(same.risk.score,0);
  assert.equal(same.risk.level,'Safe');
  assert.equal(same.changes?.ip,false);

  const ipOnly=assessNetworkIdentityRisk(point(),point({ip:'203.0.113.11'}));
  assert.equal(ipOnly.risk.score,20);
  assert.equal(ipOnly.risk.level,'Caution');
  assert.deepEqual(ipOnly.risk.reasons,['Public IP changed (+20)']);

  const ipAndAsn=assessNetworkIdentityRisk(point(),point({ip:'203.0.113.11',asn:64501}));
  assert.equal(ipAndAsn.risk.score,45);
  assert.equal(ipAndAsn.risk.level,'Warning');

  const countryMove=assessNetworkIdentityRisk(point(),point({
    ip:'198.51.100.20',asn:64501,country:'United States',countryCode:'US',region:'Virginia',city:'Ashburn'
  }));
  assert.equal(countryMove.risk.score,100);
  assert.equal(countryMove.risk.level,'Dangerous');

  const unknown=assessNetworkIdentityRisk(undefined,point());
  assert.equal(unknown.risk.score,undefined);
  assert.equal(unknown.risk.level,'Unknown');
});

test('recent change summary counts transitions inside the risk window', () => {
  const hour=60*60*1000;
  const points=[
    point({ip:'203.0.113.1',observedAt:0}),
    point({ip:'203.0.113.2',observedAt:hour}),
    point({ip:'203.0.113.3',asn:64501,observedAt:2*hour}),
    point({ip:'203.0.113.3',asn:64501,observedAt:3*hour})
  ];
  const recent=summarizeRecentNetworkChanges(points,3*hour,6*hour);
  assert.equal(recent.ip,2);
  assert.equal(recent.asn,1);

  const risk=assessNetworkIdentityRisk(points[2],points[3],recent);
  assert.equal(risk.risk.score,10);
  assert.equal(risk.risk.level,'Safe');
  assert.ok(risk.risk.reasons.some(reason=>reason.includes('2 public IP changes in 6h')));
});

test('monitor compares each successful lookup with the immediately previous check', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bbot-network-sequence-'));
  try{
    let value={ip:'203.0.113.30',asn:64500,country:'Japan',countryCode:'JP',region:'Tokyo',city:'Tokyo',organization:'Example Network'};
    const monitor=new NetworkIdentityMonitor(dir,()=>{},60_000,async()=>value);
    await monitor.refresh();
    assert.equal(monitor.snapshot().risk.level,'Unknown');

    value={...value,ip:'203.0.113.31'};
    await monitor.refresh();
    const changed=monitor.snapshot();
    assert.equal(changed.previous?.ip,'203.0.113.30');
    assert.equal(changed.current?.ip,'203.0.113.31');
    assert.equal(changed.changed,true);
    assert.equal(changed.ipChanged,true);
    assert.equal(changed.risk.level,'Caution');

    await monitor.refresh();
    const stable=monitor.snapshot();
    assert.equal(stable.previous?.ip,'203.0.113.31');
    assert.equal(stable.current?.ip,'203.0.113.31');
    assert.equal(stable.ipChanged,false);
    assert.equal(stable.changed,false);
    assert.equal(stable.risk.level,'Safe');
    monitor.close();
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('short-term public IP churn survives backend restarts and contributes to risk', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bbot-network-churn-'));
  try{
    const first=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.40'));
    await first.refresh();first.close();

    const second=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.41'));
    await second.refresh();second.close();

    const third=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.42'));
    await third.refresh();
    const snapshot=third.snapshot();
    assert.equal(snapshot.previous?.ip,'203.0.113.41');
    assert.equal(snapshot.current?.ip,'203.0.113.42');
    assert.equal(snapshot.recentChanges?.ip,2);
    assert.equal(snapshot.risk.score,30);
    assert.equal(snapshot.risk.level,'Caution');
    assert.ok(snapshot.risk.reasons.some(reason=>reason.includes('2 public IP changes in 6h')));
    third.close();
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test('monitor snapshot includes scored ASN change details', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bbot-network-risk-'));
  try{
    const first=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.20',64500,'JP'));
    await first.refresh();first.close();

    const second=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.21',64501,'JP'));
    await second.refresh();
    const snapshot=second.snapshot();
    assert.equal(snapshot.changed,true);
    assert.equal(snapshot.changes?.ip,true);
    assert.equal(snapshot.changes?.asn,true);
    assert.equal(snapshot.risk.score,45);
    assert.equal(snapshot.risk.level,'Warning');
    second.close();
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});
