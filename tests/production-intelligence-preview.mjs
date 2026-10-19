// Local verification only. Never serves or modifies a user's saved project.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../web-studio/',import.meta.url));
http.createServer(async(req,res)=>{try{
 const pathname=new URL(req.url,'http://127.0.0.1:4213').pathname;res.setHeader('Cache-Control','no-store');
 if(pathname==='/analysis-check.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Odesa Production Verification</title><style>body{background:#222;color:#ddd;font:15px system-ui;padding:40px}button{padding:12px}pre{white-space:pre-wrap}</style><h1>Processed Mix Verification</h1><p>Synthetic local audio only. No account, upload, playback, or project storage.</p><button>Run Audio Checks</button><pre role="status">Ready</pre><script type="module" src="/qa-analysis.js"></script>');return;}
 if(pathname==='/qa-analysis.js'){res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('./production-intelligence-browser.mjs',import.meta.url)));return;}
 const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(root)){res.writeHead(403).end();return;}
 res.setHeader('Content-Type',({'.js':'text/javascript','.json':'application/json','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'})[path.extname(file)]??'application/octet-stream');res.end(await readFile(file));
 }catch{res.writeHead(404).end();}
}).listen(4213,'127.0.0.1',()=>console.log('Odesa production preview: http://127.0.0.1:4213/'));
