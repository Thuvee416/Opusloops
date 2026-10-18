// Controlled local UI fixture. Never deploy this server or its synthetic sign-in.
// Open http://127.0.0.1:4180/ with normal browser tooling. Production files stay unmodified.
import http from 'node:http';import {readFile,stat} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {selectionProject,compositionSelection} from './fixtures/agent-selection-project.mjs';
const root=fileURLToPath(new URL('../web-studio/',import.meta.url)),project=selectionProject(),command=(name,args)=>({type:'command',args:{name,args}});
const plans={clip:[command('select',{target:'clip',trackId:'bass',scene:1})],regions:[command('select',{target:'regions',ids:['bass-a','bass-b'],primaryId:'bass-b'})],return:[command('select',{target:'track',trackId:'room'})],recording:[command('show_panel',{panel:'recording'})],devices:[command('show_panel',{panel:'devices'})],returns:[command('show_panel',{panel:'returns'})],invalid:[{type:'project',args:{bpm:131}},command('select',{target:'regions',ids:['missing']})],compose:compositionSelection,delayed:[command('select',{target:'clip',trackId:'bass',scene:1})]};
const modelFixture=process.env.OPUS_SELECTION_MODEL_FIXTURE?JSON.parse(await readFile(process.env.OPUS_SELECTION_MODEL_FIXTURE,'utf8')):null;
const bootstrap=`sessionStorage.setItem('opus.agent.session',JSON.stringify({access_token:'LOCAL_SELECTION_TEST_ONLY',user:{id:'local-selection-test',email:'qa@opus.test'},expires_at:Date.now()/1000+3600}));await new Promise((resolve,reject)=>{const r=indexedDB.open('looproom-studio',1);r.onupgradeneeded=()=>r.result.createObjectStore('projects');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(${JSON.stringify(project)},'current');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});await import('./startup.js');`;
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1:4180');res.setHeader('Cache-Control','no-store');
 if(url.pathname==='/functions/v1/studio-agent'){
  let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text),kind=body.prompt.trim().toLowerCase(),captured=modelFixture?.cases.find(c=>c.kind===kind)?.plan;
  if(kind==='delayed')await new Promise(r=>setTimeout(r,8000));
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(captured??{summary:'Selection '+kind+' finished.',actions:plans[kind]??[]}));return;
 }
 if(url.pathname==='/qa-bootstrap.js'){res.setHeader('Content-Type','text/javascript');res.end(bootstrap);return;}
 let file=path.resolve(root,'.'+url.pathname);if(file===root.slice(0,-1))file=path.join(root,'index.html');if(!file.startsWith(root)||!(await stat(file)).isFile()){res.writeHead(404).end();return;}
 let data=await readFile(file);if(path.basename(file)==='index.html')data=Buffer.from(data.toString().replace('src="startup.js"','src="qa-bootstrap.js"'));
 if(path.basename(file)==='agent-session.js')data=Buffer.from(data.toString().replace('https://2psb3vs3pl.execute-api.us-east-1.amazonaws.com','http://127.0.0.1:4180'));
 res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json'})[path.extname(file)]??'application/octet-stream');res.end(data);
 }catch(error){if(error.code==='ENOENT'){res.writeHead(404).end();return;}res.writeHead(500).end('Local selection fixture failed.');console.error(error);}});
server.listen(4180,'127.0.0.1',()=>console.log('Controlled local selection fixture: http://127.0.0.1:4180/'));
