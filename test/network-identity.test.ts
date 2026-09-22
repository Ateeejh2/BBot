import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NetworkIdentityMonitor, type NetworkIdentityLookup } from '../src/runtime/network-identity.js';

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
