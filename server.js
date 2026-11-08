import http from 'node:http';
import {validateSchedule,scheduleDecision} from './scheduler.js';
import {WebSocketServer} from 'ws';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y)};
export function createApp(config){
 const {chargerId,chargerKey,adminKey}=config;
 if(!chargerId||!chargerKey||!adminKey||chargerKey.length<16||adminKey.length<24)throw Error('Missing secure server configuration');
 let socket=null,lastSeen=null,status='Unknown',meter=null,transactionId=null,boot=null,sequence=1;
 const pending=new Map();
 let activePlan=null,planDelivered=0,transactionStart=null,currentSessionEnergy=0,recoverySession=null,scheduleBusy=false,lastAttempt=0,persistenceOk=!config.eventSink,persistentReady=!config.getState;
 const snapshot=()=>({connected:socket?.readyState===1,lastSeen,status,meter,transactionId,boot,commissioned:config.commissioned===true,alwaysOn:config.alwaysOn===true,persistentHistory:!!config.eventSink,persistenceOk,activePlan:activePlan?{id:activePlan.id,end:activePlan.end,energy:activePlan.energy,delivered:planDelivered+currentSessionEnergy}:null});
 const persist=async event=>{if(!config.eventSink)return;try{const saved=await config.eventSink({id:randomUUID(),chargerId,...event,snapshot:snapshot()});persistenceOk=true;return saved}catch{persistenceOk=false;throw Error('History storage unavailable')}};
 const record=event=>persist(event).catch(()=>{});
 const restore=async()=>{if(!config.getState)return;try{const state=await config.getState();sequence=Math.max(sequence,state.nextTransactionId||1);persistentReady=true;persistenceOk=true;recoverySession=state.openSession||null;/* Do not silently resume after restart: operator must re-activate a saved plan. */if(state.plan)await record({type:'plan',planId:state.plan.id,status:'failed'});}catch{persistentReady=false;persistenceOk=false}};
 const ready=restore();

 const send=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
 const command=(action,payload)=>new Promise((resolve,reject)=>{if(!socket||socket.readyState!==1)return reject(Error('Charger offline'));const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('Charger response timed out'))},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify([2,id,action,payload]))});
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health')return send(res,200,{ok:true,service:'Charge Green OCPP',mode:'connection-test'});
  if(!equal(req.headers.authorization,'Bearer '+adminKey))return send(res,401,{error:'Unauthorized'});
  if(req.method==='GET'&&url.pathname==='/api/status')return send(res,200,{...snapshot(),testMode:!config.commissioned,ready:persistentReady});
  if(req.method!=='POST'||!['/api/start','/api/stop','/api/plan','/api/cancel'].includes(url.pathname))return send(res,404,{error:'Not found'});
  try{
   if(!persistentReady&&!['/api/stop','/api/cancel'].includes(url.pathname))throw Error('History storage is not ready');
   if(url.pathname==='/api/plan'){
    if(!config.commissioned||!config.alwaysOn)throw Error('Automation awaits commissioning and always-on hosting');
    if(socket?.readyState!==1)throw Error('Charger offline');
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)throw Error('Schedule too large')}
    const plan=validateSchedule(JSON.parse(raw));if(activePlan)await persist({type:'plan',planId:activePlan.id,status:'cancelled'});activePlan=plan;planDelivered=0;lastAttempt=0;await persist({type:'plan',planId:plan.id,status:'active'});return send(res,200,{ok:true});
   }
   if(url.pathname==='/api/cancel'){if(activePlan)await record({type:'plan',planId:activePlan.id,status:'cancelled'});activePlan=null;if(transactionId!==null)await command('RemoteStopTransaction',{transactionId});return send(res,200,{ok:true})}
   if(url.pathname==='/api/start'){
    if(activePlan){await record({type:'plan',planId:activePlan.id,status:'cancelled'});activePlan=null}
    if(transactionId!==null)return send(res,409,{error:'Transaction already running'});
    if(status!=='Preparing')return send(res,409,{error:'Charger must report Preparing before a test start'});
    return send(res,200,{response:await command('RemoteStartTransaction',{connectorId:1,idTag:'ChargeGreenTest'})});
   }
   if(activePlan){await record({type:'plan',planId:activePlan.id,status:'cancelled'});activePlan=null}
   if(transactionId===null)return send(res,409,{error:'No known transaction. Wait for charger transaction data.'});
   return send(res,200,{response:await command('RemoteStopTransaction',{transactionId})});
  }catch(err){send(res,503,{error:err.message})}
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:65536,handleProtocols:protocols=>protocols.has('ocpp1.6')?'ocpp1.6':false});
 server.on('upgrade',(req,net,head)=>{
  let path;try{path=new URL(req.url,'http://localhost').pathname}catch{return net.destroy()}
  let user='',password='';const auth=req.headers.authorization||'';if(auth.startsWith('Basic ')){const decoded=Buffer.from(auth.slice(6),'base64').toString();const i=decoded.indexOf(':');user=decoded.slice(0,i);password=decoded.slice(i+1)}
  const protocols=(req.headers['sec-websocket-protocol']||'').split(',').map(x=>x.trim());
  if(!['/ocpp','/ocpp/','/ocpp/'+encodeURIComponent(chargerId),'/ocpp/'+chargerId].includes(path)||!equal(user,chargerId)||!equal(password,chargerKey)||!protocols.includes('ocpp1.6')){console.log('OCPP connection rejected: path, credentials or protocol mismatch');net.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}
  if(socket?.readyState===1){net.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');return}
  wss.handleUpgrade(req,net,head,ws=>wss.emit('connection',ws));
 });
 wss.on('connection',ws=>{
  console.log('OCPP charger connected');socket=ws;lastSeen=new Date().toISOString();status='Unknown';meter=null;boot=null;ws.alive=true;
  ws.on('pong',()=>{ws.alive=true});
  ws.on('error',()=>{});
  ws.on('message',async raw=>{
   lastSeen=new Date().toISOString();let m;try{m=JSON.parse(raw)}catch{ws.close(1007,'Invalid JSON');return}
   if(!Array.isArray(m)||![2,3,4].includes(m[0])||typeof m[1]!=='string'){ws.close(1007,'Invalid OCPP message');return}
   if(m[0]===3||m[0]===4){let p=pending.get(m[1]);if(p){clearTimeout(p.timer);pending.delete(m[1]);m[0]===3?p.resolve(m[2]):p.reject(Error('Charger rejected command'))}return}
   const [,id,action,p]=m;if(typeof action!=='string'||!p||typeof p!=='object'||Array.isArray(p)){ws.send(JSON.stringify([4,id,'FormationViolation','Invalid payload',{}]));return}
   const reply=data=>ws.readyState===1&&ws.send(JSON.stringify([3,id,data]));
   try{switch(action){
    case 'BootNotification':boot={vendor:String(p.chargePointVendor||'').slice(0,80),model:String(p.chargePointModel||'').slice(0,80)};reply({status:'Accepted',currentTime:new Date().toISOString(),interval:60});await record({type:'snapshot'});break;
    case 'Heartbeat':reply({currentTime:new Date().toISOString()});await record({type:'snapshot'});break;
    case 'StatusNotification':if(p.connectorId===1)status=String(p.status||'Unknown').slice(0,40);reply({});await record({type:status==='Faulted'?'alert':'snapshot',code:'charger_fault',message:'Laderen melder fejl. Kontrollér FoxSwitch.'});break;
    case 'Authorize':reply({idTagInfo:{status:p.idTag==='ChargeGreenTest'?'Accepted':'Invalid'}});break;
    case 'StartTransaction':if(p.idTag!=='ChargeGreenTest'||p.connectorId!==1){reply({transactionId:0,idTagInfo:{status:'Invalid'}});break}await ready;if(!persistentReady)throw Error('History storage not ready');const nextId=sequence++;const saved=await persist({type:'start',requestKey:id,transactionId:nextId,meterStart:p.meterStart,timestamp:p.timestamp});transactionId=saved?.transactionId||nextId;transactionStart=p.meterStart;currentSessionEnergy=0;meter={meterStart:p.meterStart,timestamp:p.timestamp};reply({transactionId,idTagInfo:{status:'Accepted'}});break;
    case 'StopTransaction':await persist({type:'stop',transactionId:p.transactionId,meterStop:p.meterStop,timestamp:p.timestamp});if(p.transactionId===transactionId){if(activePlan&&transactionStart!==null&&Number.isFinite(p.meterStop)&&p.meterStop>=transactionStart)planDelivered+=(p.meterStop-transactionStart)/1000;transactionId=null;transactionStart=null;currentSessionEnergy=0}reply({idTagInfo:{status:'Accepted'}});break;
    case 'MeterValues':meter={timestamp:p.meterValue?.at(-1)?.timestamp,samples:p.meterValue?.at(-1)?.sampledValue||[]};if(Number.isInteger(p.transactionId)&&p.transactionId>0){transactionId=p.transactionId;if(transactionStart===null&&recoverySession?.transaction_id===p.transactionId)transactionStart=recoverySession.meter_start;sequence=Math.max(sequence,transactionId+1)}const energySample=meter.samples.find(s=>(!s.measurand||s.measurand==='Energy.Active.Import.Register')&&!s.phase);if(energySample&&transactionStart!==null){let wh=Number(energySample.value)*(energySample.unit==='kWh'?1000:1);if(Number.isFinite(wh)&&wh>=transactionStart)currentSessionEnergy=Math.max(currentSessionEnergy,(wh-transactionStart)/1000)}reply({});await record({type:'snapshot'});break;
    case 'DataTransfer':reply({status:'UnknownVendorId'});break;
    case 'DiagnosticsStatusNotification':case 'FirmwareStatusNotification':reply({});break;
    default:ws.send(JSON.stringify([4,id,'NotSupported','Not supported by connection-test server',{}]));
   }}catch{if(ws.readyState===1)ws.send(JSON.stringify([4,id,'InternalError','Persistent storage unavailable',{}]))}
  });
  ws.on('close',()=>{if(socket===ws){socket=null;status='Offline';console.log('OCPP charger disconnected');record({type:'alert',code:'offline',message:'Laderen mistede forbindelsen.'})}for(const [id,p]of pending){clearTimeout(p.timer);p.reject(Error('Charger disconnected'));pending.delete(id)}});
 });
 const scheduling=setInterval(async()=>{if(scheduleBusy||!activePlan||!config.commissioned||!config.alwaysOn)return;const decision=scheduleDecision(activePlan,Date.now(),planDelivered+currentSessionEnergy);if(Date.now()-lastAttempt<30000)return;scheduleBusy=true;try{if(decision==='complete'){if(transactionId!==null){lastAttempt=Date.now();const r=await command('RemoteStopTransaction',{transactionId});if(r.status!=='Accepted')throw Error('Stop rejected')}await persist({type:'plan',planId:activePlan.id,status:'completed'});activePlan=null}else if(decision==='charge'&&transactionId===null&&status==='Preparing'){lastAttempt=Date.now();const r=await command('RemoteStartTransaction',{connectorId:1,idTag:'ChargeGreenTest'});if(r.status!=='Accepted')throw Error('Start rejected')}else if(decision==='pause'&&transactionId!==null){lastAttempt=Date.now();const r=await command('RemoteStopTransaction',{transactionId});if(r.status!=='Accepted')throw Error('Pause rejected')}}catch{await record({type:'alert',code:'command_failed',message:'Ladeplanen kunne ikke udføres. Kontrollér laderen.'})}finally{scheduleBusy=false}},5000);scheduling.unref();
 const recovery=setInterval(()=>{if(!persistentReady)restore()},60000);recovery.unref();
 const ping=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue}ws.alive=false;ws.ping()}},30000);ping.unref();
 return {server,close:async()=>{clearInterval(ping);clearInterval(scheduling);clearInterval(recovery);for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r))}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const base=process.env.SITE_URL,key=process.env.EVENT_KEY,bypass=process.env.SITE_ACCESS_KEY;
 const siteRequest=async(path,event)=>{if(!base||!key||!bypass)throw Error('Persistent site configuration missing');const r=await fetch(base+path,{method:event?'POST':'GET',headers:{Authorization:'Bearer '+key,'OAI-Sites-Authorization':'Bearer '+bypass,'Content-Type':'application/json'},...(event?{body:JSON.stringify(event)}:{}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('History persistence unavailable');return r.json()};
 const app=createApp({chargerId:process.env.CHARGER_ID,chargerKey:process.env.CHARGER_KEY,adminKey:process.env.ADMIN_KEY,commissioned:process.env.CHARGER_COMMISSIONED==='true',alwaysOn:process.env.SERVER_ALWAYS_ON==='true',eventSink:e=>siteRequest('/api/service/event',e),getState:()=>siteRequest('/api/service/state')});app.server.listen(Number(process.env.PORT||10000),'0.0.0.0',()=>console.log('Charge Green OCPP ready'));process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)))}
