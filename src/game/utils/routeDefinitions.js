// Route definitions as ordered arrays of waypoints.
//
// Each segment: [nearFactor, dd]
//   nearFactor — horizontal offset multiplied by `near` (+1 = receiver's side, -1 = opposite)
//   dd         — yards downfield from the line of scrimmage (scaled by routeDepthScale)
//
// The route engine walks through segments in order:
//   • Intermediate segments are cut-through points (transition on approach)
//   • The final segment is the endpoint (player continues or stops based on STOP_ROUTES)
//
// Routes with two segments have a natural breakpoint (cut point) at the first waypoint.
// Simple routes have one segment (no break — straight to the endpoint).

export const ROUTE_DEF = {
  // Simple routes — one segment, straight to the endpoint
  flat:       [[ 8,  3]],
  drag:       [[0, 3], [-8, 4]],
  quick_out:  [[ 6,  4]],
  return:     [[0, 1], [6, 3], [-4, 3]],
  cross:      [[0, 8], [-10, 8]],
  go:         [[ 0, 30]],
  seam:       [[ 2, 22]],
  angle:      [[ 5,  5]],
  delay:      [[ 0,  8]],
  swing:      [[8, 1], [8, 4]],
  check_down: [[ 0,  3]],
  flare:      [[ 7,  4]],
  screen:     [[ 5, -2]],
  block:      [[ 0,  0]],

  // Two-segment routes — receiver runs to the first point, then cuts to the second
  slant:      [[0, 3], [-6, 4]],   // stem up, break inside
  zig:        [[0, 1], [-4, 3], [6, 3]],   // stem up, break outside
  curl:       [[0, 7], [-1, 5]],   // run straight, settle (stop)
  out:        [[0, 10], [6, 10]],   // stem up, break flat to the sideline
  comeback:   [[ 2,12], [ 4, 10]],   // go deep outside, come back (stop)
  dig:        [[ 0,10], [-9,10]],   // stem up, cut flat across the field
  post:       [[0, 10], [-9, 20]],   // run upfield, break to post angle
  corner:     [[0, 10], [8, 20]],   // run upfield, break to corner
  wheel:      [[6, 0], [6, 14]],   // swing out then go deep
  deep_cross: [[0, 12], [-14, 18]],   // stem then cross deep
  texas:      [[6, 5], [-2, 11]],  // stem then post-ish angle
}

// Routes whose final waypoint is a stop (player settles and waits for the ball).
export const STOP_ROUTES = new Set(['curl', 'comeback', 'block'])
