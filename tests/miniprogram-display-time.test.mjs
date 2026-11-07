import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {dateTime}=createRequire(import.meta.url)('../miniprogram/services/display-time.js');
test('native order and audit times use Beijing time across dates and respect explicit offsets',()=>{
 assert.equal(dateTime('2026-11-07T18:05:09.000Z'),'2026-11-08 02:05');
 assert.equal(dateTime('2026-11-07T18:05:09.000Z',true),'2026-11-08 02:05:09');
 assert.equal(dateTime('2026-11-08T02:05:09+08:00',true),'2026-11-08 02:05:09');
 assert.equal(dateTime('invalid'),'');assert.equal(dateTime(null),'');assert.equal(dateTime(''),'');
});
