import http from 'node:http';
import {randomBytes, createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const PORT=Number(process.env.PORT||3000);
const HOST=process.env.HOST||'127.0.0.1';
const ORIGIN=process.env.APP_ORIGIN||`http://localhost:${PORT}`;
const ISSUER=process.env.OIDC_ISSUER||'https://keycloak-maas-keycloak.apps.cluster-6hk7k.6hk7k.sandbox3854.opentlc.com/realms/maas';
const CLIENT=process.env.OIDC_CLIENT_ID||'maas-oidc';
const MAAS=(process.env.MAAS_URL||'https://maas.apps.cluster-6hk7k.6hk7k.sandbox3854.opentlc.com').replace(/\/$/,'');
const sessions=new Map(), pending=new Map();
const rand=()=>randomBytes(32).toString('base64url');
const cookie=(name,value,age)=>`${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${ORIGIN.startsWith('https:')?'; Secure':''}`;
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=')));
class Failure extends Error {constructor(status,message){super(message);this.status=status;}}
async function upstream(url,options={}){
 const response=await fetch(url,{...options,signal:AbortSignal.timeout(60000)});
 const raw=await response.text(); let data;try{data=JSON.parse(raw)}catch{data={}}
 if(!response.ok){const message=response.status===429?'This subscription’s usage limit has been reached. Try again later.':response.status===401?'Your credentials have expired. Sign in again.':response.status===403?'Access was denied. Check the selected subscription and API key.':data.error_description||data.error?.message||(typeof data.error==='string'?data.error:null)||data.message||`The service returned HTTP ${response.status}.`;throw new Failure(response.status,message)}
 return data;
}
const tokens=params=>upstream(`${ISSUER}/protocol/openid-connect/token`,{method:'POST',body:new URLSearchParams({client_id:CLIENT,...params})});
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>65536)throw new Failure(413,'Request too large.')}try{return JSON.parse(text||'{}')}catch{throw new Failure(400,'Invalid JSON.')}}
async function session(req){const s=sessions.get(cookies(req).session);if(!s||s.until<Date.now())throw new Failure(401,'Please sign in to continue.');if(s.expiry<Date.now()+30000){try{const t=await tokens({grant_type:'refresh_token',refresh_token:s.refresh});s.access=t.access_token;s.refresh=t.refresh_token||s.refresh;s.expiry=Date.now()+t.expires_in*1000}catch{sessions.delete(cookies(req).session);throw new Failure(401,'Your session expired. Please sign in again.')}}return s;}
const manage=(s,path,method='GET',data)=>upstream(`${MAAS}/maas-api/v1${path}`,{method,headers:{Authorization:`Bearer ${s.access}`,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const redirect=(res,url,c)=>{res.writeHead(302,{Location:url,...(c?{'Set-Cookie':c}:{})});res.end();};
setInterval(()=>{for(const [k,v] of pending)if(v.until<Date.now())pending.delete(k);for(const [k,v] of sessions)if(v.until<Date.now())sessions.delete(k);},60000).unref();
http.createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 try{
 const url=new URL(req.url,ORIGIN), path=url.pathname;
 if(path==='/healthz'&&req.method==='GET')return json(res,200,{ok:true});
 if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==ORIGIN)throw new Failure(403,'Request origin is not allowed.');
 if(path==='/auth/login'&&req.method==='GET'){
 const state=rand(),verifier=rand();pending.set(state,{verifier,until:Date.now()+600000});
 const auth=new URL(`${ISSUER}/protocol/openid-connect/auth`);auth.search=new URLSearchParams({client_id:CLIENT,redirect_uri:`${ORIGIN}/auth/callback`,response_type:'code',scope:'openid groups',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();return redirect(res,auth.toString(),cookie('login_state',state,600));
 }
 if(path==='/auth/callback'&&req.method==='GET'){
 const state=url.searchParams.get('state'),p=pending.get(state);pending.delete(state);
 if(!p||p.until<Date.now()||cookies(req).login_state!==state)throw new Failure(400,'Sign-in expired. Return to the portal and try again.');
 if(url.searchParams.has('error'))return redirect(res,'/?login=cancelled',cookie('login_state','',0));
 const t=await tokens({grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:`${ORIGIN}/auth/callback`,code_verifier:p.verifier});
 // Identity is confirmed by Keycloak's authenticated userinfo endpoint.
 const user=await upstream(`${ISSUER}/protocol/openid-connect/userinfo`,{headers:{Authorization:`Bearer ${t.access_token}`}});
 const id=rand();sessions.set(id,{access:t.access_token,refresh:t.refresh_token,expiry:Date.now()+t.expires_in*1000,until:Date.now()+8*3600000,user:user.preferred_username||user.sub,keys:new Map()});
 return redirect(res,'/',[cookie('session',id,28800),cookie('login_state','',0)]);
 }
 if(path==='/api/logout'&&req.method==='POST'){sessions.delete(cookies(req).session);res.setHeader('Set-Cookie',cookie('session','',0));return json(res,200,{ok:true});}
 if(path.startsWith('/api/')){
 const s=await session(req);
 if(path==='/api/me'&&req.method==='GET')return json(res,200,{username:s.user,endpoint:`${MAAS}/v1`});
 if(path==='/api/catalog'&&req.method==='GET'){const [models,subscriptions]=await Promise.all([manage(s,'/models'),manage(s,'/subscriptions')]);return json(res,200,{models:models.data||[],subscriptions});}
 if(path==='/api/keys'&&req.method==='GET'){const result=await manage(s,'/api-keys/search','POST',{});return json(res,200,{result,usableIds:[...s.keys.keys()]});}
 if(path==='/api/keys'&&req.method==='POST'){
 const b=await body(req);if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100||typeof b.subscription!=='string'||!['1h','1d','7d','30d'].includes(b.expiresIn))throw new Failure(400,'Choose a name, subscription, and expiration.');
 const k=await manage(s,'/api-keys','POST',{name:b.name.trim(),subscription:b.subscription,expiresIn:b.expiresIn});s.keys.set(k.id,{secret:k.key,subscription:k.subscription});return json(res,201,k);
 }
 if(path.startsWith('/api/keys/')&&req.method==='DELETE'){const id=decodeURIComponent(path.slice('/api/keys/'.length));const result=await manage(s,`/api-keys/${encodeURIComponent(id)}`,'DELETE');s.keys.delete(id);return json(res,200,result);}
 if(path==='/api/chat'&&req.method==='POST'){
 const b=await body(req),k=s.keys.get(b.keyId);if(!k)throw new Failure(400,'Create a key in this session to use the playground.');
 if(typeof b.model!=='string'||!Array.isArray(b.messages)||b.messages.length>30||b.messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>12000))throw new Failure(400,'Invalid conversation.');
 const result=await upstream(`${MAAS}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${k.secret}`,'Content-Type':'application/json'},body:JSON.stringify({model:b.model,messages:b.messages,max_tokens:256,stream:false})});return json(res,200,{message:result.choices?.[0]?.message?.content||'',usage:result.usage});
 }
 throw new Failure(404,'Not found.');
 }
 const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
 if(req.method!=='GET'||!files[path])throw new Failure(404,'Not found.');
 const [file,type]=files[path];res.setHeader('Content-Type',type);res.end(await readFile(new URL(`./public/${file}`,import.meta.url)));
 }catch(e){json(res,e.status||502,{error:e.status?e.message:'Cannot reach the service. Please try again.'});}
}).listen(PORT,HOST,()=>console.log(`Model portal ready at ${ORIGIN}`));
