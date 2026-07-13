const cv = document.getElementById('c');
const x = cv.getContext('2d');
const $ = id => document.getElementById(id);

const INK = '#17170f', YELLOW = '#eef227', ORANGE = '#ff8438', DOT = '#e0e0d4';
const W = cv.width, H = cv.height, R = 22;

let playing = false, score = 0, best = 0, timeLeft = 30;
let bx = W / 2, by = H / 2, vx = 3.2, vy = 2.4;
let pops = [], flashes = 0, ticker = null;

function resetRound() {
  score = 0; timeLeft = 30;
  bx = W / 2; by = H / 2;
  vx = 3.2 * (Math.random() < .5 ? 1 : -1);
  vy = 2.4 * (Math.random() < .5 ? 1 : -1);
  pops = []; flashes = 0;
  $('score').textContent = 0;
  $('time').textContent = 30;
}

$('start').onclick = () => {
  resetRound();
  playing = true;
  $('overlay').classList.add('hidden');
  // Countdown on a real timer, not rAF - rAF freezes in hidden tabs.
  clearInterval(ticker);
  ticker = setInterval(() => {
    timeLeft--;
    $('time').textContent = Math.max(0, timeLeft);
    if (timeLeft <= 0) endRound();
  }, 1000);
};

cv.addEventListener('pointerdown', e => {
  if (!playing) return;
  const r = cv.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (W / r.width);
  const my = (e.clientY - r.top) * (H / r.height);
  if (Math.hypot(mx - bx, my - by) < R + 8) {
    score++;
    $('score').textContent = score;
    pops.push({ x: bx, y: by, r: R, a: 1 });
    const s = 1.09;
    vx *= -s; vy *= s;
    bx = Math.random() * (W - 120) + 60;
    by = Math.random() * (H - 120) + 60;
  } else {
    timeLeft = Math.max(0, timeLeft - 2);
    flashes = 6;
  }
});

function endRound() {
  playing = false;
  clearInterval(ticker);
  best = Math.max(best, score);
  $('best').textContent = best;
  $('ov-title').textContent = `SCORE ${score}`;
  $('ov-sub').textContent = score >= best && score > 0
    ? 'session best — one more?' : 'faster fingers next time';
  $('start').textContent = '↻  play again';
  $('overlay').classList.remove('hidden');
}

function draw(now) {
  requestAnimationFrame(draw);
  x.clearRect(0, 0, W, H);

  // dotted grid backdrop
  x.fillStyle = DOT;
  for (let gy = 14; gy < H; gy += 22)
    for (let gx = 14; gx < W; gx += 22) {
      x.beginPath(); x.arc(gx, gy, 1.6, 0, 7); x.fill();
    }

  if (playing) {
    bx += vx; by += vy;
    if (bx < R || bx > W - R) { vx *= -1; bx = Math.max(R, Math.min(W - R, bx)); }
    if (by < R || by > H - R) { vy *= -1; by = Math.max(R, Math.min(H - R, by)); }
  }

  // miss flash border
  if (flashes > 0) {
    flashes--;
    x.strokeStyle = ORANGE; x.lineWidth = 6;
    x.strokeRect(3, 3, W - 6, H - 6);
  }

  // pop rings
  pops = pops.filter(p => p.a > 0);
  for (const p of pops) {
    p.r += 3.5; p.a -= .06;
    x.strokeStyle = `rgba(255,132,56,${p.a})`;
    x.lineWidth = 3;
    x.beginPath(); x.arc(p.x, p.y, p.r, 0, 7); x.stroke();
  }

  // ball: yellow with ink outline + small shadow
  x.beginPath(); x.arc(bx + 3, by + 5, R, 0, 7);
  x.fillStyle = 'rgba(23,23,15,.12)'; x.fill();
  x.beginPath(); x.arc(bx, by, R, 0, 7);
  x.fillStyle = YELLOW; x.fill();
  x.lineWidth = 3; x.strokeStyle = INK; x.stroke();
  x.beginPath(); x.arc(bx - 7, by - 7, 5, 0, 7);
  x.fillStyle = '#fff'; x.fill();
}
requestAnimationFrame(draw);
