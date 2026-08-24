# Clayfall

A top-down wave-survival arena shooter that runs in the browser. No build step, no
dependencies, no install — two files and a canvas.

Survive each wave, then draft one of three upgrades. The upgrades stack, so every
run turns into a different build: a piercing railgun, a shotgun that melts anything
at knife range, or a glass-cannon crit machine that dies to one bad dash.

## Play

Open `index.html` in a browser. That's it.

If your browser blocks local scripts, serve the folder instead:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Controls

| Input | Action |
| --- | --- |
| `WASD` / arrows | Move |
| Mouse | Aim |
| Left click (hold) | Fire |
| `Space` / right click | Dash — a short burst with brief invulnerability |
| `P` / `Esc` | Pause |
| `M` | Mute |
| `1` `2` `3` | Pick an upgrade |
| `R` | Restart after a death |

## Enemies

| | Enemy | Behaviour |
| --- | --- | --- |
| 🔴 | **Grunt** | Walks straight at you. Cheap, and never stops coming. |
| 🔶 | **Darter** | Fast and fragile, weaves as it closes so leading it is guesswork. |
| 🔷 | **Spitter** | Holds ~430px, strafes, and lobs slow projectiles. Ignore it and it chips you to death. |
| 🟣 | **Brute** | Heavy and slow. Splits into three grunts when it dies. |

Enemy hit points scale with the wave number, new types unlock as you get deeper,
and each wave trickles its enemies in rather than dumping them at once. Enemies
spawn just past the edge of your view, and off-screen ones show up as coloured
chevrons at the screen border.

## Upgrades

Twelve of them, three offered per wave: fire rate, damage, extra projectiles,
piercing, move speed, max HP, healing, lifesteal, bullet velocity and range, crit
chance, dash cooldown, and a shockwave that fires when you get hit.

## Scoring

Kills are worth their enemy's base value multiplied by the current wave, so late
waves are where runs are actually won. Your best score is kept in `localStorage`.

## Layout

- `index.html` — page shell, overlay styling (menu, upgrade draft, pause, game over)
- `game.js` — the whole game: loop, entities, AI, collisions, particles, HUD, audio

Sound is generated at runtime with a few `OscillatorNode`s, so there are no audio
assets to load.
