import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('src');
const routes=[];
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name==='route.ts')routes.push('/'+path.relative(path.join(root,'app/api'),path.dirname(p)).replaceAll(path.sep,'/') );}}
walk(path.join(root,'app/api'));
const text=[];
function walkText(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walkText(p);else if(/\.(ts|tsx)$/.test(e.name))text.push(fs.readFileSync(p,'utf8'));}}
walkText(path.join(root,'app/dashboard'));
const report=routes.map(r=>({route:r,frontendCaller:text.some(t=>t.includes(`'/api${r}`)||t.includes(`"/api${r}`))}));
console.log(JSON.stringify(report.filter(x=>!x.frontendCaller),null,2));
