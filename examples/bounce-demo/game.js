const c = document.getElementById("c"), x = c.getContext("2d");
let bx=200, by=130, vx=3, vy=2, score=0;
c.onclick = e => { const r=c.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
  if (Math.hypot(mx-bx,my-by)<18) { score++; document.getElementById("score").textContent="score: "+score; vx*=-1.1; vy*=1.05; } };
(function loop(){ x.clearRect(0,0,400,260); bx+=vx; by+=vy;
  if(bx<18||bx>382)vx*=-1; if(by<18||by>242)vy*=-1;
  x.beginPath(); x.arc(bx,by,18,0,7); x.fillStyle="#d9f24b"; x.fill(); requestAnimationFrame(loop); })();
