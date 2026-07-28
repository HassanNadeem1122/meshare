// Generic runner: serve this directory, open one page, wait for __done, dump __results.
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const puppeteer=require('C:/Users/Hassan/AppData/Local/Temp/claude/C--Users-Hassan-Desktop/2884ee6f-0a54-40a3-b3db-7e62478d57d5/scratchpad/node_modules/puppeteer-core');
const PAGE=process.argv[2], QUERY=process.argv[3]||'', TIMEOUT=Number(process.argv[4]||300000);
const HERE=__dirname;
const server=http.createServer((req,res)=>{
  const f=path.join(HERE,req.url.split('?')[0].replace(/^\//,''));
  fs.readFile(f,(e,b)=>{ if(e){res.writeHead(404);return res.end('nf');} res.writeHead(200,{'Content-Type':'text/html'});res.end(b); });
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'gossip-'));
  const b=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless:'new',userDataDir:prof,args:['--no-first-run','--disable-gpu','--max-web-media-player-count=1000']});
  const p=await b.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(`http://127.0.0.1:${port}/${PAGE}?${QUERY}`,{waitUntil:'domcontentloaded'});
  try{ await p.waitForFunction('window.__done===true',{timeout:TIMEOUT}); }catch{ console.error('TIMEOUT'); }
  const r=await p.evaluate(()=>window.__results);
  console.log(JSON.stringify(r,null,1));
  if(errs.length) console.error('page errors:',errs.slice(0,3));
  await b.close(); fs.rmSync(prof,{recursive:true,force:true}); server.close();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
