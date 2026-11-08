import {test} from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import WebSocket from 'ws';import {createApp} from './server.js';
test('authenticated OCPP connection, boot, meter and remote start/stop',async()=>{const app=createApp({chargerId:'test',chargerKey:'a'.repeat(24),adminKey:'b'.repeat(32)});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base='http://127.0.0.1:'+app.server.address().port;let ws;try{
 assert.equal((await fetch(base+'/api/status')).status,401);
 await new Promise((resolve,reject)=>{const bad=new WebSocket(base.replace('http','ws')+'/ocpp/test','ocpp1.6');bad.on('unexpected-response',(_,r)=>{assert.equal(r.statusCode,401);r.resume();bad.terminate();resolve()});bad.on('error',()=>{});bad.on('open',()=>reject(Error('Accepted invalid credentials')))});
 ws=new WebSocket(base.replace('http','ws')+'/ocpp/test','ocpp1.6',{headers:{Authorization:'Basic '+Buffer.from('test:'+ 'a'.repeat(24)).toString('base64')}});await once(ws,'open');
 const call=async(action,p)=>{const reply=once(ws,'message');ws.send(JSON.stringify([2,action,action,p]));return JSON.parse((await reply)[0])};
 assert.equal((await call('BootNotification',{chargePointVendor:'FoxESS',chargePointModel:'L11P'}))[2].status,'Accepted');
 await call('StatusNotification',{connectorId:1,status:'Preparing'});
 ws.on('message',raw=>{const m=JSON.parse(raw);if(m[0]===2)ws.send(JSON.stringify([3,m[1],{status:'Accepted'}]))});
 const options={method:'POST',headers:{Authorization:'Bearer '+ 'b'.repeat(32)}};
 assert.equal((await fetch(base+'/api/start',options)).status,200);
 assert.equal((await call('StartTransaction',{connectorId:1,idTag:'wrong',meterStart:0}))[2].idTagInfo.status,'Invalid');
 const start=await call('StartTransaction',{connectorId:1,idTag:'ChargeGreenTest',meterStart:0});const id=start[2].transactionId;assert.ok(id>0);
 assert.equal((await fetch(base+'/api/stop',options)).status,200);
 await call('StopTransaction',{transactionId:id,meterStop:100});
 const status=await(await fetch(base+'/api/status',{headers:{Authorization:'Bearer '+ 'b'.repeat(32)}})).json();assert.equal(status.connected,true);assert.equal(status.transactionId,null);
 }finally{ws?.terminate();await app.close()}});
