// The paths Agents walk on a Floor (PRD §8: "hand-placed waypoint paths
// rather than a pathfinding library"). A Floor's layout places the
// waypoints with its rooms and desks, in the walkways between them, and
// joins them with straight edges that stay clear of furniture. A walk is
// the shortest run of edges from one waypoint to another.

/** A point on the floor, x and z, in metres. */
export type FloorPoint = readonly [number, number];

export interface Waypoint {
  readonly id: string;
  readonly position: FloorPoint;
}

export interface WaypointGraph {
  readonly waypoints: readonly Waypoint[];
  /** Each edge, by its two waypoints' ids; walkable both ways. */
  readonly edges: readonly (readonly [string, string])[];
}

export const distance = ([ax, az]: FloorPoint, [bx, bz]: FloorPoint) =>
  Math.hypot(bx - ax, bz - az);

/** Each waypoint's neighbours. */
export function neighbours(graph: WaypointGraph): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>(
    graph.waypoints.map(({ id }) => [id, new Set<string>()]),
  );
  for (const [a, b] of graph.edges) {
    result.get(a)?.add(b);
    result.get(b)?.add(a);
  }
  return result;
}

/** The ids of every waypoint reachable from `from`, itself included. */
export function reachable(graph: WaypointGraph, from: string): Set<string> {
  const around = neighbours(graph);
  const seen = new Set<string>(around.has(from) ? [from] : []);
  const queue = [...seen];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const next of around.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * The shortest walk from one waypoint to another (Dijkstra's, by length),
 * both ends included; undefined when there is none.
 */
export function walk(
  graph: WaypointGraph,
  from: string,
  to: string,
): Waypoint[] | undefined {
  const byId = new Map(graph.waypoints.map((each) => [each.id, each]));
  const start = byId.get(from);
  const end = byId.get(to);
  if (start === undefined || end === undefined) {
    return undefined;
  }
  const around = neighbours(graph);
  const best = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, string>();
  const open = new Set<string>([from]);
  while (open.size > 0) {
    let current: string | undefined;
    for (const id of open) {
      if (
        current === undefined ||
        (best.get(id) ?? Infinity) < (best.get(current) ?? Infinity)
      ) {
        current = id;
      }
    }
    if (current === undefined || current === to) {
      break;
    }
    open.delete(current);
    const here = byId.get(current);
    for (const next of around.get(current) ?? []) {
      const there = byId.get(next);
      if (here === undefined || there === undefined) {
        continue;
      }
      const length =
        (best.get(current) ?? Infinity) +
        distance(here.position, there.position);
      if (length < (best.get(next) ?? Infinity)) {
        best.set(next, length);
        previous.set(next, current);
        open.add(next);
      }
    }
  }
  if (!best.has(to)) {
    return undefined;
  }
  const path: Waypoint[] = [];
  for (
    let id: string | undefined = to;
    id !== undefined;
    id = previous.get(id)
  ) {
    const waypoint = byId.get(id);
    if (waypoint !== undefined) {
      path.unshift(waypoint);
    }
  }
  return path;
}

/** A walk's length, in metres. */
export const walkLength = (path: readonly Waypoint[]) =>
  path.reduce(
    (sum, waypoint, index) =>
      sum + distance((path[index - 1] ?? waypoint).position, waypoint.position),
    0,
  );
