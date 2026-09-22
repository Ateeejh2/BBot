import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkIdentityMonitor, assessNetworkIdentityRisk, type NetworkIdentityLookup, type NetworkIdentityPoint } from '../src/runtime/network-identity.js';

const lookup = (ip:string, asn=64500, countryCode='JP'):NetworkIdentityLookup =>
  async () => ({ ip, asn, countryCode, region:'Tokyo', city:'Tokyo', organization:'Example Network' });

test('network identity persists a baseline and detects a later public network change', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bbot-network-'));
  try{
    const first=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.10'));
    await first.refresh();
    const initial=first.snapshot();
    assert.equal(initial.status,'OK');
    assert.equal(initial.current?.ip,'203.0.113.10');
    assert.equal(initial.previous,undefined);
    assert.equal(initial.changed,false);
    first.close();

    const second=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.11',64501));
    await second.refresh();
    const changed=second.snapshot();
    assert.equal(changed.status,'OK');
    assert.equal(changed.previous?.ip,'203.0.113.10');
    assert.equal(changed.current?.ip,'203.0.113.11');
    assert.equal(changed.changed,true);
    second.close();

    const third=new NetworkIdentityMonitor(dir,()=>{},60_000,lookup('203.0.113.11',64501));
    await third.refresh();
    const stable=third.snapshot();
    assert.equal(stable.previous?.ip,'203.0.113.11');
    assert.equal(stable.changed,false);
    third.close();
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});


const point = (overrides: Partial<NetworkIdentityPoint> = {}):NetworkIdentityPoint => ({
  ip:'203.0.113.10',
  asn:64500,
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
  assert.equal(ipOnly.risk.score,25);
  assert.equal(ipOnly.risk.level,'Caution');
  assert.deepEqual(ipOnly.risk.reasons,['Public IP changed (+25)']);

  const ipAndAsn=assessNetworkIdentityRisk(point(),point({ip:'203.0.113.11',asn:64501}));
  assert.equal(ipAndAsn.risk.score,55);
  assert.equal(ipAndAsn.risk.level,'Warning');

  const countryMove=assessNetworkIdentityRisk(point(),point({
    ip:'198.51.100.20',asn:64501,countryCode:'US',region:'Virginia',city:'Ashburn'
  }));
  assert.equal(countryMove.risk.score,100);
  assert.equal(countryMove.risk.level,'Dangerous');

  const unknown=assessNetworkIdentityRisk(undefined,point());
  assert.equal(unknown.risk.score,undefined);
  assert.equal(unknown.risk.level,'Unknown');
});

test('monitor snapshot includes scored change details', async () => {
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
    assert.equal(snapshot.risk.score,55);
    assert.equal(snapshot.risk.level,'Warning');
    second.close();
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});
