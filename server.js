import http from 'node:http';
import {WebSocketServer} from 'ws';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y)};
export function createApp(config){
 const {chargerId,chargerKey,adminKey}=config;
 if(!chargerId||!chargerKey||!adminKey||chargerKey.length<16||adminKey.length<24)throw Error('Missing secure server configuration');
 let socket=null,lastSeen=null,status='Unknown',meter=null,transactionId=null,boot=null,sequence=1;
 const pending=new Map();
 const send=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
 const command=(action,payload)=>new Promise((resolve,reject)=>{if(!socket||socket.readyState!==1)return reject(Error('Charger offline'));const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('Charger response timed out'))},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify([2,id,action,payload]))});
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health')return send(res,200,{ok:true,service:'Charge Green OCPP',mode:'connection-test'});
  if(!equal(req.headers.authorization,'Bearer '+adminKey))return send(res,401,{error:'Unauthorized'});
  if(req.method==='GET'&&url.pathname==='/api/status')return send(res,200,{connected:socket?.readyState===1,lastSeen,status,meter,transactionId,boot,testMode:true,persistentHistory:false});
  if(req.method!=='POST'||!['/api/start','/api/stop'].includes(url.pathname))return send(res,404,{error:'Not found'});
  try{
   if(url.pathname==='/api/start'){
    if(transactionId!==null)return send(res,409,{error:'Transaction already running'});
    if(status!=='Preparing')return send(res,409,{error:'Charger must report Preparing before a test start'});
    return send(res,200,{response:await command('RemoteStartTransaction',{connectorId:1,idTag:'ChargeGreenTest'})});
   }
   if(transactionId===null)return send(res,409,{error:'No known transaction. Wait for charger transaction data.'});
   return send(res,200,{response:await command('RemoteStopTransaction',{transactionId})});
  }catch(err){send(res,503,{error:err.message})}
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:65536,handleProtocols:protocols=>protocols.has('ocpp1.6')?'ocpp1.6':false});
 server.on('upgrade',(req,net,head)=>{
  let path;try{path=new URL(req.url,'http://localhost').pathname}catch{return net.destroy()}
  let user='',password='';const auth=req.headers.authorization||'';if(auth.startsWith('Basic ')){const decoded=Buffer.from(auth.slice(6),'base64').toString();const i=decoded.indexOf(':');user=decoded.slice(0,i);password=decoded.slice(i+1)}
  const protocols=(req.headers['sec-websocket-protocol']||'').split(',').map(x=>x.trim());
  if(![ '/ocpp/'+encodeURIComponent(chargerId),'/ocpp/'+chargerId].includes(path)||!equal(user,chargerId)||!equal(password,chargerKey)||!protocols.includes('ocpp1.6')){net.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return}
  if(socket?.readyState===1){net.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');return}
  wss.handleUpgrade(req,net,head,ws=>wss.emit('connection',ws));
 });
 wss.on('connection',ws=>{
  socket=ws;lastSeen=new Date().toISOString();status='Unknown';meter=null;boot=null;ws.alive=true;
  ws.on('pong',()=>{ws.alive=true});
  ws.on('error',()=>{});
  ws.on('message',raw=>{
   lastSeen=new Date().toISOString();let m;try{m=JSON.parse(raw)}catch{ws.close(1007,'Invalid JSON');return}
   if(!Array.isArray(m)||![2,3,4].includes(m[0])||typeof m[1]!=='string'){ws.close(1007,'Invalid OCPP message');return}
   if(m[0]===3||m[0]===4){let p=pending.get(m[1]);if(p){clearTimeout(p.timer);pending.delete(m[1]);m[0]===3?p.resolve(m[2]):p.reject(Error('Charger rejected command'))}return}
   const [,id,action,p]=m;if(typeof action!=='string'||!p||typeof p!=='object'||Array.isArray(p)){ws.send(JSON.stringify([4,id,'FormationViolation','Invalid payload',{}]));return}
   const reply=data=>ws.send(JSON.stringify([3,id,data]));
   switch(action){
    case 'BootNotification':boot={vendor:String(p.chargePointVendor||'').slice(0,80),model:String(p.chargePointModel||'').slice(0,80)};reply({status:'Accepted',currentTime:new Date().toISOString(),interval:60});break;
    case 'Heartbeat':reply({currentTime:new Date().toISOString()});break;
    case 'StatusNotification':if(p.connectorId===1)status=String(p.status||'Unknown').slice(0,40);reply({});break;
    case 'Authorize':reply({idTagInfo:{status:p.idTag==='ChargeGreenTest'?'Accepted':'Invalid'}});break;
    case 'StartTransaction':if(p.idTag!=='ChargeGreenTest'||p.connectorId!==1){reply({transactionId:0,idTagInfo:{status:'Invalid'}});break}transactionId=sequence++;meter={meterStart:p.meterStart,timestamp:p.timestamp};reply({transactionId,idTagInfo:{status:'Accepted'}});break;
    case 'StopTransaction':if(p.transactionId===transactionId)transactionId=null;reply({idTagInfo:{status:'Accepted'}});break;
    case 'MeterValues':meter={timestamp:p.meterValue?.at(-1)?.timestamp,samples:p.meterValue?.at(-1)?.sampledValue||[]};if(Number.isInteger(p.transactionId)&&p.transactionId>0){transactionId=p.transactionId;sequence=Math.max(sequence,transactionId+1)}reply({});break;
    case 'DataTransfer':reply({status:'UnknownVendorId'});break;
    case 'DiagnosticsStatusNotification':case 'FirmwareStatusNotification':reply({});break;
    default:ws.send(JSON.stringify([4,id,'NotSupported','Not supported by connection-test server',{}]));
   }
  });
  ws.on('close',()=>{if(socket===ws){socket=null;status='Offline'}for(const [id,p]of pending){clearTimeout(p.timer);p.reject(Error('Charger disconnected'));pending.delete(id)}});
 });
 const ping=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue}ws.alive=false;ws.ping()}},30000);ping.unref();
 return {server,close:async()=>{clearInterval(ping);for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r))}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const app=createApp({chargerId:process.env.CHARGER_ID,chargerKey:process.env.CHARGER_KEY,adminKey:process.env.ADMIN_KEY});app.server.listen(Number(process.env.PORT||10000),'0.0.0.0',()=>console.log('Charge Green OCPP ready'));process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)))}
