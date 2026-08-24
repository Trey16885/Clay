'use strict';

/* ------------------------------------------------------------------ *
 * Clayfall - a top-down wave-survival arena shooter.
 * No dependencies. Everything lives in this file.
 * ------------------------------------------------------------------ */

const cvs = document.getElementById('game');
const ctx = cvs.getContext('2d');
const overlay = document.getElementById('overlay');

const ARENA_W = 2400, ARENA_H = 1600;
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  cvs.width = Math.round(W * DPR); cvs.height = Math.round(H * DPR);
  cvs.style.width = W + 'px'; cvs.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/* ---------------------------------- utils */
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[(Math.random() * arr.length) | 0];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

/* ---------------------------------- audio (tiny synth, no assets) */
let actx = null, muted = false;
function beep(freq, dur, type, vol) {
  if (muted) return;
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.5), t + dur);
    g.gain.setValueAtTime(vol == null ? 0.05 : vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch (e) { /* audio is optional */ }
}
const sfx = {
  shoot: () => beep(rand(600, 680), 0.06, 'square', 0.035),
  hit:   () => beep(rand(200, 260), 0.05, 'triangle', 0.045),
  kill:  () => beep(rand(110, 150), 0.16, 'sawtooth', 0.05),
  hurt:  () => beep(90, 0.24, 'sawtooth', 0.08),
  dash:  () => beep(420, 0.12, 'sine', 0.05),
  wave:  () => beep(880, 0.22, 'sine', 0.06),
  pickUp:() => beep(1040, 0.18, 'sine', 0.06),
};

/* ---------------------------------- input */
const keys = Object.create(null);
const mouse = { x: 0, y: 0, down: false };

window.addEventListener('keydown', e => {
  if (e.repeat) { keys[e.code] = true; return; }
  keys[e.code] = true;
  if (e.code === 'KeyM') muted = !muted;
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (state === 'playing') { state = 'paused'; showPause(); }
    else if (state === 'paused') { state = 'playing'; hideOverlay(); }
  }
  if (state === 'upgrade' && /^Digit[123]$/.test(e.code)) {
    takeUpgrade(+e.code.slice(5) - 1);
  }
  if ((state === 'dead' || state === 'menu') && (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyR')) {
    startRun();
  }
  if ([ 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight' ].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  mouse.down = false;
  if (state === 'playing') { state = 'paused'; showPause(); }
});

cvs.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
cvs.addEventListener('mousedown', e => {
  if (e.button === 0) mouse.down = true;
  if (e.button === 2 && state === 'playing') tryDash();
});
window.addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; });
cvs.addEventListener('contextmenu', e => e.preventDefault());

/* ---------------------------------- world state */
let state = 'menu';           // menu | playing | upgrade | paused | dead
let player, enemies, bullets, foeShots, parts, texts, spawnQueue;
let cam = { x: 0, y: 0 }, shake = 0, time = 0;
let wave = 0, score = 0, kills = 0, waveBanner = 0;
let best = +(localStorage.getItem('clayfall.best') || 0);

function newPlayer() {
  return {
    x: ARENA_W / 2, y: ARENA_H / 2, r: 15, vx: 0, vy: 0,
    hp: 100, maxHp: 100, speed: 250, aim: 0,
    dmg: 12, fireRate: 0.22, shots: 1, pierce: 0, bulletSpeed: 720, range: 620,
    crit: 0.05, lifesteal: 0, nova: false,
    nextShot: 0, iframes: 0, flash: 0,
    dashCd: 2.2, dashReady: 0, dashing: 0, dashDir: 0,
  };
}

function startRun() {
  player = newPlayer();
  enemies = []; bullets = []; foeShots = []; parts = []; texts = []; spawnQueue = [];
  wave = 0; score = 0; kills = 0; time = 0; shake = 0;
  cam.x = player.x - W / 2; cam.y = player.y - H / 2;
  hideOverlay();
  state = 'playing';
  nextWave();
}

/* ---------------------------------- enemies */
const FOES = {
  grunt:   { r: 15, hp: 22,  spd: 78,  dmg: 9,  score: 10, col: '#ff6b6b', cost: 1, from: 1 },
  darter:  { r: 10, hp: 12,  spd: 185, dmg: 6,  score: 14, col: '#ffa94d', cost: 1, from: 2 },
  spitter: { r: 17, hp: 38,  spd: 62,  dmg: 11, score: 26, col: '#74c0fc', cost: 3, from: 4 },
  brute:   { r: 27, hp: 95,  spd: 48,  dmg: 20, score: 45, col: '#b197fc', cost: 5, from: 5 },
};

function spawnFoe(kind, x, y) {
  const d = FOES[kind];
  const scale = 1 + (wave - 1) * 0.17;
  if (x == null) {
    // Spawn on a ring just past the edge of the view: off-screen, but close
    // enough that the enemy is a threat within a few seconds rather than a
    // long walk across an empty arena.
    const ring = Math.hypot(W, H) * 0.5 * rand(1.05, 1.3);
    for (let tries = 0; tries < 24; tries++) {
      const a = rand(0, TAU);
      x = clamp(player.x + Math.cos(a) * ring, 30, ARENA_W - 30);
      y = clamp(player.y + Math.sin(a) * ring, 30, ARENA_H - 30);
      // Clamping into the arena can drag a point back toward a cornered
      // player, so keep rolling until it lands a safe distance out.
      if (Math.hypot(x - player.x, y - player.y) > Math.min(ring, 400)) break;
    }
  }
  enemies.push({
    kind, x, y, r: d.r, spd: d.spd * rand(0.9, 1.1), dmg: d.dmg, col: d.col,
    hp: Math.round(d.hp * scale), maxHp: Math.round(d.hp * scale),
    touchCd: 0, flash: 0, shotCd: rand(0.6, 1.8), wob: rand(0, TAU), kb: { x: 0, y: 0 },
  });
}

function nextWave() {
  wave++;
  waveBanner = 2.2;
  sfx.wave();
  let budget = 4 + wave * 3;
  const roster = Object.keys(FOES).filter(k => wave >= FOES[k].from);
  const queue = [];
  let guard = 500;
  while (budget > 0 && guard-- > 0) {
    const affordable = roster.filter(k => FOES[k].cost <= budget);
    if (!affordable.length) break;
    const k = pick(affordable);
    queue.push(k);
    budget -= FOES[k].cost;
  }
  // Drip enemies in rather than dumping the whole wave at once.
  const gap = clamp(1.6 / Math.sqrt(wave), 0.18, 0.9);
  spawnQueue = queue.map((k, i) => ({ kind: k, at: time + 0.35 + i * gap }));
}

/* ---------------------------------- fx */
function burst(x, y, col, n, spd, life) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU), s = rand(spd * 0.3, spd);
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: rand(1.5, 3.6),
                 life: rand(life * 0.5, life), max: life, col });
  }
}
function floatText(x, y, msg, col) {
  texts.push({ x, y, msg, col, life: 0.75, max: 0.75 });
}

/* ---------------------------------- player actions */
function tryDash() {
  if (time < player.dashReady || player.dashing > 0) return;
  let dx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  let dy = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
  if (!dx && !dy) { dx = Math.cos(player.aim); dy = Math.sin(player.aim); }
  player.dashDir = Math.atan2(dy, dx);
  player.dashing = 0.17;
  player.dashReady = time + player.dashCd;
  sfx.dash();
  burst(player.x, player.y, '#7cf9d0', 12, 200, 0.35);
}

function fire() {
  const p = player;
  p.nextShot = time + p.fireRate;
  const n = p.shots, spread = 0.085;
  for (let i = 0; i < n; i++) {
    const a = p.aim + (i - (n - 1) / 2) * spread + rand(-0.02, 0.02);
    const crit = Math.random() < p.crit;
    bullets.push({
      x: p.x + Math.cos(a) * (p.r + 6), y: p.y + Math.sin(a) * (p.r + 6),
      vx: Math.cos(a) * p.bulletSpeed, vy: Math.sin(a) * p.bulletSpeed,
      r: crit ? 6 : 4, dmg: p.dmg * (crit ? 3 : 1), crit,
      pierce: p.pierce, gone: 0, hitList: [],
    });
  }
  shake = Math.min(shake + 1.2, 14);
  sfx.shoot();
}

function hurtPlayer(amount) {
  const p = player;
  if (p.iframes > 0 || p.dashing > 0) return;
  p.hp -= amount;
  p.iframes = 0.55;
  p.flash = 0.25;
  shake = Math.min(shake + 9, 26);
  sfx.hurt();
  burst(p.x, p.y, '#ff6b6b', 14, 250, 0.5);
  if (p.nova) {
    for (const e of enemies) {
      const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy) || 1;
      if (d < 260) {
        e.kb.x += (dx / d) * 520; e.kb.y += (dy / d) * 520;
        damageFoe(e, 18, false);
      }
    }
    burst(p.x, p.y, '#7cf9d0', 26, 420, 0.5);
  }
  if (p.hp <= 0) die();
}

function damageFoe(e, dmg, crit) {
  e.hp -= dmg;
  e.flash = 0.12;
  if (e.hp <= 0 && !e.dead) {
    e.dead = true;
    kills++;
    score += FOES[e.kind].score * wave;
    burst(e.x, e.y, e.col, 18, 300, 0.6);
    sfx.kill();
    if (player.lifesteal) player.hp = Math.min(player.maxHp, player.hp + player.lifesteal);
    if (e.kind === 'brute') for (let i = 0; i < 3; i++) {
      spawnFoe('grunt', e.x + rand(-30, 30), e.y + rand(-30, 30));
    }
  } else if (crit) {
    floatText(e.x, e.y - e.r - 6, 'CRIT', '#ffe066');
  }
}

function die() {
  state = 'dead';
  burst(player.x, player.y, '#7cf9d0', 60, 420, 1.0);
  shake = 30;
  if (score > best) { best = score; localStorage.setItem('clayfall.best', String(best)); }
  showGameOver();
}

/* ---------------------------------- upgrades */
const UPGRADES = [
  { n: 'Overclock',   d: '+22% fire rate',                     f: p => p.fireRate *= 0.78 },
  { n: 'Hollow Point',d: '+28% bullet damage',                 f: p => p.dmg *= 1.28 },
  { n: 'Split Barrel',d: '+1 projectile, -12% damage',         f: p => { p.shots++; p.dmg *= 0.88; } },
  { n: 'Railcore',    d: 'Bullets pierce 1 more enemy',        f: p => p.pierce++ },
  { n: 'Light Frame', d: '+15% move speed',                    f: p => p.speed *= 1.15 },
  { n: 'Plating',     d: '+30 max HP, and heal 30',            f: p => { p.maxHp += 30; p.hp += 30; } },
  { n: 'Field Repair',d: 'Heal 60 HP right now',               f: p => p.hp = Math.min(p.maxHp, p.hp + 60), rep: true },
  { n: 'Siphon',      d: '+2 HP per kill',                     f: p => p.lifesteal += 2 },
  { n: 'Accelerator', d: '+25% bullet speed, +15% range',      f: p => { p.bulletSpeed *= 1.25; p.range *= 1.15; } },
  { n: 'Weak Point',  d: '+12% crit chance (3x damage)',       f: p => p.crit += 0.12 },
  { n: 'Blink Drive', d: '-35% dash cooldown',                 f: p => p.dashCd *= 0.65 },
  { n: 'Kickback',    d: 'Blast enemies away when you are hit',f: p => p.nova = true, once: true },
];
let offered = [];

function rollUpgrades() {
  const pool = UPGRADES.filter(u => !(u.once && player.nova && u.n === 'Kickback'));
  offered = [];
  while (offered.length < 3 && offered.length < pool.length) {
    const u = pick(pool);
    if (!offered.includes(u)) offered.push(u);
  }
}

function takeUpgrade(i) {
  const u = offered[i];
  if (!u) return;
  u.f(player);
  player.hp = Math.min(player.hp, player.maxHp);
  sfx.pickUp();
  hideOverlay();
  state = 'playing';
  nextWave();
}

/* ---------------------------------- update */
function update(dt) {
  time += dt;
  const p = player;

  // --- aim & movement
  p.aim = Math.atan2(mouse.y + cam.y - p.y, mouse.x + cam.x - p.x);
  let dx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  let dy = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
  const m = Math.hypot(dx, dy);
  if (m) { dx /= m; dy /= m; }
  if (keys.Space) tryDash();

  if (p.dashing > 0) {
    p.dashing -= dt;
    p.vx = Math.cos(p.dashDir) * p.speed * 3.4;
    p.vy = Math.sin(p.dashDir) * p.speed * 3.4;
    if (Math.random() < 0.7) burst(p.x, p.y, '#3ad0a5', 1, 40, 0.3);
  } else {
    p.vx += (dx * p.speed - p.vx) * Math.min(1, dt * 14);
    p.vy += (dy * p.speed - p.vy) * Math.min(1, dt * 14);
  }
  p.x = clamp(p.x + p.vx * dt, p.r, ARENA_W - p.r);
  p.y = clamp(p.y + p.vy * dt, p.r, ARENA_H - p.r);
  p.iframes -= dt; p.flash -= dt;

  if (mouse.down && time >= p.nextShot) fire();

  // --- spawn drip
  while (spawnQueue.length && spawnQueue[0].at <= time) spawnFoe(spawnQueue.shift().kind);

  // --- enemies
  for (const e of enemies) {
    const ddx = p.x - e.x, ddy = p.y - e.y;
    const d = Math.hypot(ddx, ddy) || 1;
    let ax = ddx / d, ay = ddy / d;

    if (e.kind === 'darter') {           // weaves as it charges
      e.wob += dt * 7;
      const s = Math.sin(e.wob) * 0.55;
      const c = Math.cos(s), sn = Math.sin(s);
      [ax, ay] = [ax * c - ay * sn, ax * sn + ay * c];
    } else if (e.kind === 'spitter') {   // holds range and lobs shots
      if (d < 300) { ax = -ax; ay = -ay; }
      else if (d < 430) { const t = ax; ax = -ay; ay = t; }   // strafe at preferred range
      e.shotCd -= dt;
      if (e.shotCd <= 0 && d < 640) {
        e.shotCd = rand(1.5, 2.3);
        const a = Math.atan2(ddy, ddx);
        foeShots.push({ x: e.x, y: e.y, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, r: 6, dmg: e.dmg, life: 3.5 });
      }
    }

    e.x += (ax * e.spd + e.kb.x) * dt;
    e.y += (ay * e.spd + e.kb.y) * dt;
    e.kb.x *= Math.pow(0.001, dt); e.kb.y *= Math.pow(0.001, dt);
    e.x = clamp(e.x, e.r, ARENA_W - e.r); e.y = clamp(e.y, e.r, ARENA_H - e.r);
    e.flash -= dt; e.touchCd -= dt;

    if (d < e.r + p.r && e.touchCd <= 0) {
      e.touchCd = 0.6;
      hurtPlayer(e.dmg);
      e.kb.x -= ax * 340; e.kb.y -= ay * 340;
    }
  }

  // --- keep enemies from stacking into one blob
  for (let i = 0; i < enemies.length; i++) {
    for (let j = i + 1; j < enemies.length; j++) {
      const a = enemies[i], b = enemies[j];
      const ox = b.x - a.x, oy = b.y - a.y, need = a.r + b.r;
      const d2 = ox * ox + oy * oy;
      if (d2 > 0 && d2 < need * need) {
        const d = Math.sqrt(d2), push = (need - d) * 0.5;
        const nx = ox / d * push, ny = oy / d * push;
        a.x -= nx; a.y -= ny; b.x += nx; b.y += ny;
      }
    }
  }

  // --- player bullets
  for (const b of bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt;
    b.gone += Math.hypot(b.vx, b.vy) * dt;
    if (b.gone > p.range || b.x < 0 || b.y < 0 || b.x > ARENA_W || b.y > ARENA_H) { b.dead = true; continue; }
    for (const e of enemies) {
      if (e.dead || b.hitList.includes(e)) continue;
      const rr = e.r + b.r;
      if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < rr * rr) {
        damageFoe(e, b.dmg, b.crit);
        burst(b.x, b.y, b.crit ? '#ffe066' : '#ffd43b', 5, 180, 0.3);
        sfx.hit();
        b.hitList.push(e);
        if (b.hitList.length > b.pierce) { b.dead = true; break; }
      }
    }
  }

  // --- enemy shots
  for (const s of foeShots) {
    s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
    const rr = s.r + p.r;
    if ((p.x - s.x) ** 2 + (p.y - s.y) ** 2 < rr * rr) { hurtPlayer(s.dmg); s.life = 0; }
    if (s.x < 0 || s.y < 0 || s.x > ARENA_W || s.y > ARENA_H) s.life = 0;
  }

  // --- particles & text
  for (const q of parts) {
    q.x += q.vx * dt; q.y += q.vy * dt;
    q.vx *= Math.pow(0.06, dt); q.vy *= Math.pow(0.06, dt);
    q.life -= dt;
  }
  for (const t of texts) { t.y -= 34 * dt; t.life -= dt; }

  // --- cull
  enemies = enemies.filter(e => !e.dead);
  bullets = bullets.filter(b => !b.dead);
  foeShots = foeShots.filter(s => s.life > 0);
  parts = parts.filter(q => q.life > 0);
  texts = texts.filter(t => t.life > 0);

  // --- camera & shake
  const tx = clamp(p.x - W / 2, 0, Math.max(0, ARENA_W - W));
  const ty = clamp(p.y - H / 2, 0, Math.max(0, ARENA_H - H));
  cam.x += (tx - cam.x) * Math.min(1, dt * 9);
  cam.y += (ty - cam.y) * Math.min(1, dt * 9);
  shake *= Math.pow(0.02, dt);
  waveBanner -= dt;

  // --- wave clear
  if (state === 'playing' && !enemies.length && !spawnQueue.length) {
    state = 'upgrade';
    rollUpgrades();
    showUpgrades();
  }
}

/* ---------------------------------- render */
function render() {
  const sx = shake > 0.2 ? rand(-shake, shake) * 0.35 : 0;
  const sy = shake > 0.2 ? rand(-shake, shake) * 0.35 : 0;

  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, W, H);
  if (!player) return;

  ctx.save();
  ctx.translate(-cam.x + sx, -cam.y + sy);

  // grid + arena bounds
  const step = 80;
  ctx.lineWidth = 1; ctx.strokeStyle = '#141a26';
  ctx.beginPath();
  for (let x = Math.floor(cam.x / step) * step; x < cam.x + W + step; x += step) {
    if (x < 0 || x > ARENA_W) continue;
    ctx.moveTo(x, Math.max(0, cam.y)); ctx.lineTo(x, Math.min(ARENA_H, cam.y + H));
  }
  for (let y = Math.floor(cam.y / step) * step; y < cam.y + H + step; y += step) {
    if (y < 0 || y > ARENA_H) continue;
    ctx.moveTo(Math.max(0, cam.x), y); ctx.lineTo(Math.min(ARENA_W, cam.x + W), y);
  }
  ctx.stroke();
  ctx.strokeStyle = '#28324a'; ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, ARENA_W, ARENA_H);

  // particles
  for (const q of parts) {
    ctx.globalAlpha = clamp(q.life / q.max, 0, 1);
    ctx.fillStyle = q.col;
    ctx.fillRect(q.x - q.r, q.y - q.r, q.r * 2, q.r * 2);
  }
  ctx.globalAlpha = 1;

  // enemy shots
  for (const s of foeShots) {
    ctx.fillStyle = '#74c0fc';
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 2.1, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // enemies
  for (const e of enemies) {
    const a = Math.atan2(player.y - e.y, player.x - e.x);
    ctx.save();
    ctx.translate(e.x, e.y); ctx.rotate(a);
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.col;
    ctx.beginPath();
    if (e.kind === 'darter') {                 // arrowhead
      ctx.moveTo(e.r * 1.4, 0); ctx.lineTo(-e.r, e.r * 0.8); ctx.lineTo(-e.r * 0.4, 0); ctx.lineTo(-e.r, -e.r * 0.8);
    } else if (e.kind === 'brute') {           // heavy hexagon
      for (let i = 0; i < 6; i++) { const t = i / 6 * TAU; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(t) * e.r, Math.sin(t) * e.r); }
    } else if (e.kind === 'spitter') {         // diamond
      ctx.moveTo(e.r, 0); ctx.lineTo(0, e.r); ctx.lineTo(-e.r, 0); ctx.lineTo(0, -e.r);
    } else {                                   // grunt: rounded blob
      ctx.arc(0, 0, e.r, 0, TAU);
    }
    ctx.closePath(); ctx.fill();
    ctx.restore();

    if (e.hp < e.maxHp) {
      const w = e.r * 2;
      ctx.fillStyle = '#00000088'; ctx.fillRect(e.x - w / 2, e.y - e.r - 9, w, 4);
      ctx.fillStyle = e.col; ctx.fillRect(e.x - w / 2, e.y - e.r - 9, w * clamp(e.hp / e.maxHp, 0, 1), 4);
    }
  }

  // bullets
  for (const b of bullets) {
    ctx.strokeStyle = b.crit ? '#ffe066' : '#ffd43b';
    ctx.lineWidth = b.r;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - b.vx * 0.018, b.y - b.vy * 0.018);
    ctx.stroke();
  }

  // player
  const p = player;
  ctx.save();
  ctx.translate(p.x, p.y);
  if (p.iframes > 0 && Math.floor(time * 22) % 2 === 0) ctx.globalAlpha = 0.35;
  ctx.rotate(p.aim);
  ctx.fillStyle = '#1d2b3a';
  ctx.strokeStyle = p.flash > 0 ? '#ff6b6b' : '#7cf9d0';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, p.r, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.fillStyle = p.flash > 0 ? '#ff6b6b' : '#7cf9d0';
  ctx.fillRect(p.r - 3, -3.5, 16, 7);
  ctx.restore();
  ctx.globalAlpha = 1;

  // floating text
  ctx.textAlign = 'center';
  ctx.font = '700 13px ui-monospace, monospace';
  for (const t of texts) {
    ctx.globalAlpha = clamp(t.life / t.max, 0, 1);
    ctx.fillStyle = t.col;
    ctx.fillText(t.msg, t.x, t.y);
  }
  ctx.globalAlpha = 1;

  ctx.restore();
  drawEdgeMarkers();
  drawHud();
}

// Chevrons at the screen edge pointing at enemies you cannot see yet.
function drawEdgeMarkers() {
  const pad = 26;
  for (const e of enemies) {
    const sx = e.x - cam.x, sy = e.y - cam.y;
    if (sx > -e.r && sx < W + e.r && sy > -e.r && sy < H + e.r) continue;
    const cx = clamp(sx, pad, W - pad), cy = clamp(sy, pad, H - pad);
    const a = Math.atan2(sy - cy, sx - cx);
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(a);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = e.col;
    ctx.beginPath();
    ctx.moveTo(9, 0); ctx.lineTo(-5, 6); ctx.lineTo(-5, -6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawHud() {
  const p = player;
  ctx.textAlign = 'left';
  ctx.font = '700 12px ui-monospace, monospace';

  // health
  const bw = 260, bh = 16;
  ctx.fillStyle = '#00000066'; ctx.fillRect(18, 18, bw, bh);
  ctx.fillStyle = p.hp / p.maxHp < 0.3 ? '#ff6b6b' : '#7cf9d0';
  ctx.fillRect(18, 18, bw * clamp(p.hp / p.maxHp, 0, 1), bh);
  ctx.strokeStyle = '#2b3548'; ctx.lineWidth = 1; ctx.strokeRect(18.5, 18.5, bw - 1, bh - 1);
  ctx.fillStyle = '#e6edf3';
  ctx.fillText(Math.max(0, Math.ceil(p.hp)) + ' / ' + p.maxHp, 18 + bw + 10, 30);

  // dash meter
  const dr = clamp(1 - (p.dashReady - time) / p.dashCd, 0, 1);
  ctx.fillStyle = '#00000066'; ctx.fillRect(18, 42, bw, 6);
  ctx.fillStyle = dr >= 1 ? '#ffd43b' : '#46557a';
  ctx.fillRect(18, 42, bw * dr, 6);

  ctx.fillStyle = '#8b97a8';
  ctx.fillText('DASH', 18, 62);

  // right side stats
  ctx.textAlign = 'right';
  ctx.fillStyle = '#e6edf3';
  ctx.font = '700 20px ui-monospace, monospace';
  ctx.fillText(String(score), W - 18, 34);
  ctx.font = '700 12px ui-monospace, monospace';
  ctx.fillStyle = '#8b97a8';
  ctx.fillText('SCORE   BEST ' + best, W - 18, 52);
  ctx.fillText('WAVE ' + wave + '   KILLS ' + kills + '   LEFT ' + (enemies.length + spawnQueue.length), W - 18, 70);
  ctx.fillText(muted ? 'MUTED [M]' : '[M] MUTE   [P] PAUSE', W - 18, 88);

  if (waveBanner > 0 && state === 'playing') {
    ctx.textAlign = 'center';
    ctx.globalAlpha = clamp(waveBanner, 0, 1);
    ctx.fillStyle = '#7cf9d0';
    ctx.font = '700 46px ui-monospace, monospace';
    ctx.fillText('WAVE ' + wave, W / 2, H * 0.24);
    ctx.globalAlpha = 1;
  }
}

/* ---------------------------------- overlays */
function hideOverlay() { overlay.hidden = true; overlay.innerHTML = ''; }

function showMenu() {
  overlay.hidden = false;
  overlay.innerHTML =
    '<div class="panel">' +
      '<h1>CLAYFALL</h1>' +
      '<p class="sub">Survive the waves. Draft an upgrade after each one.</p>' +
      '<p class="keys"><kbd>WASD</kbd> move &nbsp; <kbd>Mouse</kbd> aim &nbsp; <kbd>Click</kbd> shoot<br>' +
      '<kbd>Space</kbd> / <kbd>Right click</kbd> dash (brief invulnerability)<br>' +
      '<kbd>P</kbd> pause &nbsp; <kbd>M</kbd> mute</p>' +
      '<button class="btn" id="go">START</button>' +
      (best ? '<p class="stat">best run <b>' + best + '</b></p>' : '') +
    '</div>';
  document.getElementById('go').onclick = startRun;
}

function showUpgrades() {
  overlay.hidden = false;
  overlay.innerHTML =
    '<div class="panel">' +
      '<h2>WAVE ' + wave + ' CLEARED</h2>' +
      '<p class="sub">Pick one upgrade &mdash; click, or press 1 / 2 / 3</p>' +
      '<div class="cards">' +
        offered.map((u, i) =>
          '<button class="card" data-i="' + i + '"><div class="k">0' + (i + 1) + '</div>' +
          '<div class="n">' + u.n + '</div><div class="d">' + u.d + '</div></button>').join('') +
      '</div>' +
      '<p class="stat">score <b>' + score + '</b> &nbsp; hp <b>' + Math.ceil(player.hp) + '/' + player.maxHp + '</b></p>' +
    '</div>';
  overlay.querySelectorAll('.card').forEach(el => { el.onclick = () => takeUpgrade(+el.dataset.i); });
}

function showPause() {
  overlay.hidden = false;
  overlay.innerHTML = '<div class="panel"><h2>PAUSED</h2><p class="sub">Press <kbd>P</kbd> to resume</p></div>';
}

function showGameOver() {
  overlay.hidden = false;
  overlay.innerHTML =
    '<div class="panel">' +
      '<h2>YOU FELL ON WAVE ' + wave + '</h2>' +
      '<p class="sub">' + kills + ' kills &nbsp;&middot;&nbsp; score ' + score +
        (score >= best ? ' &nbsp;&middot;&nbsp; <b style="color:#7cf9d0">NEW BEST</b>' : ' &nbsp;&middot;&nbsp; best ' + best) +
      '</p>' +
      '<button class="btn" id="go">RUN IT BACK</button>' +
      '<p class="stat">or press <kbd>R</kbd></p>' +
    '</div>';
  document.getElementById('go').onclick = startRun;
}

/* ---------------------------------- loop */
let last = performance.now();
function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.05);
  if (state === 'playing') update(dt);
  render();
  requestAnimationFrame(frame);
}

player = newPlayer();
enemies = []; bullets = []; foeShots = []; parts = []; texts = []; spawnQueue = [];
showMenu();
requestAnimationFrame(frame);
