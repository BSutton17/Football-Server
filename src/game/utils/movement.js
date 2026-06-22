import { FIELD, PLAYER } from '../../constants.js'

// Smoothly steers a player toward (tx, ty) at up to maxSpeed yards/sec.
// accel controls how quickly the player builds up to that speed.
export function steer(player, tx, ty, maxSpeed, dt, accel = 15) {
  const dx   = tx - player.x
  const dy   = ty - player.y
  const dist = Math.sqrt(dx * dx + dy * dy)

  if (dist < 0.15) {
    player.vx *= Math.max(0, 1 - accel * dt)
    player.vy *= Math.max(0, 1 - accel * dt)
    return
  }

  const speed     = Math.min(maxSpeed, dist * 4)
  const desiredVx = (dx / dist) * speed
  const desiredVy = (dy / dist) * speed

  const alpha = Math.min(1, accel * dt)
  player.vx  += (desiredVx - player.vx) * alpha
  player.vy  += (desiredVy - player.vy) * alpha
}

// Advances a player's position by their current velocity and clamps to field bounds.
export function advance(player, dt) {
  player.x = Math.max(PLAYER.RADIUS, Math.min(FIELD.WIDTH  - PLAYER.RADIUS, player.x + player.vx * dt))
  player.y = Math.max(PLAYER.RADIUS, Math.min(FIELD.LENGTH - PLAYER.RADIUS, player.y + player.vy * dt))
}

// Returns the absolute-coordinate endpoint for a named route.
//   startX — player's x at snap time
//   losY   — absolute y of the line of scrimmage
//   dir    — +1 (north offense) or -1 (south offense)
//   scale  — routeDepthScale multiplier
export function routeEndpoint(route, startX, losY, dir, scale) {
  const s    = scale ?? 1
  const near = startX > FIELD.WIDTH / 2 ? 1 : -1

  let dx = 0
  let dd = 10

  switch (route) {
    case 'flat':       dx =  near * 8;  dd =  3 * s; break
    case 'drag':       dx = -near * 6;  dd =  5 * s; break
    case 'quick_out':  dx =  near * 6;  dd =  4 * s; break
    case 'slant':      dx = -near * 5;  dd =  8 * s; break
    case 'zig':        dx =  near * 5;  dd =  8 * s; break
    case 'curl':       dx =  0;         dd = 10 * s; break
    case 'out':        dx =  near * 7;  dd = 10 * s; break
    case 'comeback':   dx =  near * 4;  dd = 12 * s; break
    case 'dig':        dx = -near * 10; dd = 10 * s; break
    case 'return':     dx = -near * 5;  dd =  7 * s; break
    case 'cross':      dx = -near * 10; dd =  6 * s; break
    case 'go':         dx =  0;         dd = 30 * s; break
    case 'post':       dx = -near * 8;  dd = 15 * s; break
    case 'corner':     dx =  near * 6;  dd = 15 * s; break
    case 'seam':       dx =  near * 2;  dd = 22 * s; break
    case 'wheel':      dx =  near * 8;  dd = 20 * s; break
    case 'deep_cross': dx = -near * 12; dd = 18 * s; break
    case 'angle':      dx =  near * 5;  dd =  5 * s; break
    case 'delay':      dx =  0;         dd =  8 * s; break
    case 'swing':      dx =  near * 8;  dd =  4 * s; break
    case 'check_down': dx =  0;         dd =  3 * s; break
    case 'flare':      dx =  near * 7;  dd =  4 * s; break
    case 'texas':      dx = -near * 8;  dd = 12 * s; break
    case 'screen':     dx =  near * 5;  dd = -2;      break
    case 'block':      dx =  0;         dd =  0;      break
    default:           dx =  0;         dd = 10 * s; break
  }

  return {
    x: Math.max(1, Math.min(FIELD.WIDTH - 1, startX + dx)),
    y: losY + dir * dd,
  }
}
