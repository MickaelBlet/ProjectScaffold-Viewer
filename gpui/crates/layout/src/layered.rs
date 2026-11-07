//! Layered (Sugiyama-style) graph layout, replacing ELK's `layered` algorithm: cycle breaking by
//! depth-first search, layers by longest path, long edges split by dummy nodes, crossing
//! reduction by barycenter sweeps, coordinates by weighted isotonic placement of each layer.
//! The flow axis carries the layers (x when horizontal, y when vertical); the cross axis stacks
//! the nodes of a layer.

use scaffold_model::types::Point;

/// An edge between two nodes (indices into the node sizes).
#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub from: usize,
    pub to: usize,
    /// Where the edge attaches on each node, along the cross axis from the node's top / left.
    pub from_off: f64,
    pub to_off: f64,
    /// Length of a label along the flow (horizontal flow): the gap after the source layer is
    /// wide enough for it. 0: none.
    pub label: f64,
}

impl Edge {
    pub fn new(from: usize, to: usize, from_off: f64, to_off: f64) -> Self {
        Edge {
            from,
            to,
            from_off,
            to_off,
            label: 0.,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Layers top to bottom instead of left to right.
    pub vertical: bool,
    /// Space between two nodes of a layer.
    pub node_gap: f64,
    /// Space between two layers.
    pub layer_gap: f64,
    /// Space between an edge (a dummy node) and its neighbors in a layer.
    pub edge_gap: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Layered {
    /// Top-left of each node.
    pub pos: Vec<Point>,
    /// Layer of each node.
    pub layer: Vec<usize>,
    /// Polyline of each edge, from its source to its target; empty for a self-loop.
    pub routes: Vec<Vec<Point>>,
    /// Middle of the first segment of each edge from the lower layer (where a label goes).
    pub anchors: Vec<Point>,
    pub width: f64,
    pub height: f64,
}

/// A link between two adjacent layers.
struct Seg {
    up: usize,
    down: usize,
    up_off: f64,
    down_off: f64,
}

/// Rounds like JavaScript's `Math.round`.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn dfs(u: usize, edges: &[Edge], out: &[Vec<usize>], state: &mut [u8], reversed: &mut [bool]) {
    state[u] = 1;
    for &ei in &out[u] {
        let v = edges[ei].to;
        match state[v] {
            1 => reversed[ei] = true,
            0 => dfs(v, edges, out, state, reversed),
            _ => {}
        }
    }
    state[u] = 2;
}

/// Positions minimizing the weighted squared distance to `want`, in order, `step[i]` apart at
/// least from item `i` to `i + 1` (pool adjacent violators on the order-corrected targets).
fn place_layer(want: &[(f64, f64)], step: &[f64]) -> Vec<f64> {
    let mut offset = Vec::with_capacity(want.len());
    let mut acc = 0.;
    for i in 0..want.len() {
        offset.push(acc);
        acc += step.get(i).copied().unwrap_or(0.);
    }
    // Blocks of (weighted sum, weight, count).
    let mut blocks: Vec<(f64, f64, usize)> = Vec::new();
    for (i, &(d, w)) in want.iter().enumerate() {
        blocks.push(((d - offset[i]) * w, w, 1));
        while blocks.len() >= 2 {
            let b = blocks[blocks.len() - 1];
            let a = blocks[blocks.len() - 2];
            if a.0 / a.1 <= b.0 / b.1 {
                break;
            }
            blocks.truncate(blocks.len() - 2);
            blocks.push((a.0 + b.0, a.1 + b.1, a.2 + b.2));
        }
    }
    let mut out = Vec::with_capacity(want.len());
    for (sum, w, n) in blocks {
        let mean = sum / w;
        for _ in 0..n {
            out.push(mean + offset[out.len()]);
        }
    }
    out
}

/// Lays out `sizes` (width, height of each node) linked by `edges`.
pub fn layered(sizes: &[(f64, f64)], edges: &[Edge], p: &Params) -> Layered {
    let n = sizes.len();
    if n == 0 {
        return Layered::default();
    }
    let (flow, cross): (Vec<f64>, Vec<f64>) = sizes
        .iter()
        .map(|&(w, h)| if p.vertical { (h, w) } else { (w, h) })
        .unzip();

    // Cycle breaking: depth first from the sources, in model order; back edges are reversed.
    let mut out: Vec<Vec<usize>> = vec![vec![]; n];
    let mut indeg = vec![0usize; n];
    for (i, e) in edges.iter().enumerate() {
        if e.from != e.to {
            out[e.from].push(i);
            indeg[e.to] += 1;
        }
    }
    let mut state = vec![0u8; n];
    let mut reversed = vec![false; edges.len()];
    let starts: Vec<usize> = (0..n).filter(|&i| indeg[i] == 0).chain(0..n).collect();
    for s in starts {
        if state[s] == 0 {
            dfs(s, edges, &out, &mut state, &mut reversed);
        }
    }
    // Oriented edges: (index, source, target, source offset, target offset).
    let oriented: Vec<(usize, usize, usize, f64, f64)> = edges
        .iter()
        .enumerate()
        .filter(|(_, e)| e.from != e.to)
        .map(|(i, e)| {
            if reversed[i] {
                (i, e.to, e.from, e.to_off, e.from_off)
            } else {
                (i, e.from, e.to, e.from_off, e.to_off)
            }
        })
        .collect();

    // Layers by longest path.
    let mut fwd: Vec<Vec<usize>> = vec![vec![]; n];
    let mut rem = vec![0usize; n];
    for &(_, a, b, _, _) in &oriented {
        fwd[a].push(b);
        rem[b] += 1;
    }
    let sources: Vec<usize> = (0..n).filter(|&i| rem[i] == 0).collect();
    let mut layer = vec![0usize; n];
    let mut queue: std::collections::VecDeque<usize> = sources.iter().copied().collect();
    while let Some(u) = queue.pop_front() {
        for &v in &fwd[u] {
            layer[v] = layer[v].max(layer[u] + 1);
            rem[v] -= 1;
            if rem[v] == 0 {
                queue.push_back(v);
            }
        }
    }
    // A source sits next to its nearest successor rather than on the first layer.
    for &u in &sources {
        if let Some(m) = fwd[u].iter().map(|&v| layer[v]).min() {
            layer[u] = m - 1;
        }
    }

    // Dummy nodes on edges spanning several layers.
    let mut layer_of = layer.clone();
    let mut flow_size = flow.clone();
    let mut cross_size = cross.clone();
    let mut segs: Vec<Seg> = Vec::new();
    let mut chains: Vec<Vec<usize>> = vec![vec![]; edges.len()];
    for &(ei, a, b, ao, bo) in &oriented {
        let (mut prev, mut prev_off) = (a, ao);
        for l in layer[a] + 1..layer[b] {
            let d = layer_of.len();
            layer_of.push(l);
            flow_size.push(0.);
            cross_size.push(0.);
            segs.push(Seg {
                up: prev,
                down: d,
                up_off: prev_off,
                down_off: 0.,
            });
            chains[ei].push(d);
            prev = d;
            prev_off = 0.;
        }
        segs.push(Seg {
            up: prev,
            down: b,
            up_off: prev_off,
            down_off: bo,
        });
    }
    let total = layer_of.len();
    let nlayers = layer_of.iter().copied().max().unwrap_or(0) + 1;
    let mut layers: Vec<Vec<usize>> = vec![vec![]; nlayers];
    for (v, &l) in layer_of.iter().enumerate() {
        layers[l].push(v);
    }
    let mut up_n: Vec<Vec<(usize, f64, f64)>> = vec![vec![]; total];
    let mut down_n: Vec<Vec<(usize, f64, f64)>> = vec![vec![]; total];
    for s in &segs {
        up_n[s.down].push((s.up, s.up_off, s.down_off));
        down_n[s.up].push((s.down, s.up_off, s.down_off));
    }

    // Crossing reduction by barycenter sweeps, keeping the best order.
    let mut pos = vec![0usize; total];
    let reindex = |layers: &[Vec<usize>], pos: &mut [usize]| {
        for l in layers {
            for (i, &v) in l.iter().enumerate() {
                pos[v] = i;
            }
        }
    };
    reindex(&layers, &mut pos);
    let crossings = |pos: &[usize]| -> usize {
        let mut by_layer: Vec<Vec<(usize, usize)>> = vec![vec![]; nlayers];
        for s in &segs {
            by_layer[layer_of[s.up]].push((pos[s.up], pos[s.down]));
        }
        let mut count = 0;
        for list in &by_layer {
            for (i, a) in list.iter().enumerate() {
                for b in &list[i + 1..] {
                    if (a.0 < b.0 && a.1 > b.1) || (a.0 > b.0 && a.1 < b.1) {
                        count += 1;
                    }
                }
            }
        }
        count
    };
    let mut best = layers.clone();
    let mut best_count = crossings(&pos);
    for it in 0..24 {
        if best_count == 0 {
            break;
        }
        let down = it % 2 == 0;
        let order: Vec<usize> = if down {
            (1..nlayers).collect()
        } else {
            (0..nlayers.saturating_sub(1)).rev().collect()
        };
        for l in order {
            let neighbors = if down { &up_n } else { &down_n };
            let bary = |v: usize| -> f64 {
                let ns = &neighbors[v];
                if ns.is_empty() {
                    pos[v] as f64
                } else {
                    ns.iter().map(|&(u, _, _)| pos[u] as f64).sum::<f64>() / ns.len() as f64
                }
            };
            let mut keys: Vec<(usize, f64)> = layers[l].iter().map(|&v| (v, bary(v))).collect();
            keys.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            layers[l] = keys.into_iter().map(|(v, _)| v).collect();
            for (i, &v) in layers[l].iter().enumerate() {
                pos[v] = i;
            }
        }
        let c = crossings(&pos);
        if c < best_count {
            best_count = c;
            best = layers.clone();
        }
    }
    let layers = best;

    // Cross coordinates.
    let step_of = |layer: &[usize]| -> Vec<f64> {
        layer
            .windows(2)
            .map(|w| {
                let gap = if w[0] < n && w[1] < n {
                    p.node_gap
                } else {
                    p.edge_gap
                };
                cross_size[w[0]] + gap
            })
            .collect()
    };
    let mut c = vec![0.; total];
    let mut extent = vec![0.; nlayers];
    for (l, nodes) in layers.iter().enumerate() {
        let step = step_of(nodes);
        let mut at = 0.;
        for (i, &v) in nodes.iter().enumerate() {
            c[v] = at;
            at += step.get(i).copied().unwrap_or(cross_size[v]);
        }
        extent[l] = nodes.last().map_or(0., |&v| c[v] + cross_size[v]);
    }
    let widest = extent.iter().copied().fold(0., f64::max);
    for (l, nodes) in layers.iter().enumerate() {
        for &v in nodes {
            c[v] += (widest - extent[l]) / 2.;
        }
    }
    let relax = |l: usize, down: bool, c: &mut [f64]| {
        let nodes = &layers[l];
        let neighbors = if down { &up_n } else { &down_n };
        let want: Vec<(f64, f64)> = nodes
            .iter()
            .map(|&v| {
                let ns = &neighbors[v];
                if ns.is_empty() {
                    return (c[v], 0.0001);
                }
                let target = ns
                    .iter()
                    .map(|&(u, uo, vo)| if down { c[u] + uo - vo } else { c[u] + vo - uo })
                    .sum::<f64>()
                    / ns.len() as f64;
                let w = ns.len() as f64 * if v < n { 1. } else { 3. };
                (target, w)
            })
            .collect();
        let placed = place_layer(&want, &step_of(nodes));
        for (&v, x) in nodes.iter().zip(placed) {
            c[v] = x;
        }
    };
    for _ in 0..6 {
        for l in 1..nlayers {
            relax(l, true, &mut c);
        }
        for l in (0..nlayers.saturating_sub(1)).rev() {
            relax(l, false, &mut c);
        }
    }
    let low = c.iter().copied().fold(f64::INFINITY, f64::min);
    for (v, at) in c.iter_mut().enumerate() {
        *at -= low;
        if v < n {
            *at = js_round(*at);
        }
    }
    let cross_extent = (0..total).map(|v| c[v] + cross_size[v]).fold(0., f64::max);

    // Flow coordinates: layers one after the other, nodes centered in their layer.
    let mut layer_flow = vec![0.; nlayers];
    for v in 0..n {
        layer_flow[layer_of[v]] = f64::max(layer_flow[layer_of[v]], flow_size[v]);
    }
    let mut gap_after = vec![p.layer_gap; nlayers];
    for &(ei, a, _, _, _) in &oriented {
        let l = layer_of[a];
        gap_after[l] = gap_after[l].max(edges[ei].label + 8.);
    }
    let mut start = vec![0.; nlayers];
    for l in 1..nlayers {
        start[l] = start[l - 1] + layer_flow[l - 1] + gap_after[l - 1];
    }
    let flow_extent = start[nlayers - 1] + layer_flow[nlayers - 1];
    let fpos = |v: usize| start[layer_of[v]] + (layer_flow[layer_of[v]] - flow_size[v]) / 2.;
    let at = |f: f64, c: f64| {
        if p.vertical {
            Point { x: c, y: f }
        } else {
            Point { x: f, y: c }
        }
    };

    let mut routes = vec![vec![]; edges.len()];
    let mut anchors = vec![Point::default(); edges.len()];
    for &(ei, a, b, ao, bo) in &oriented {
        let mut pts = vec![(fpos(a) + flow_size[a], c[a] + ao)];
        for &d in &chains[ei] {
            let l = layer_of[d];
            pts.push((start[l], c[d]));
            pts.push((start[l] + layer_flow[l], c[d]));
        }
        pts.push((fpos(b), c[b] + bo));
        pts.dedup();
        let first = (
            (pts[0].0 + pts[1.min(pts.len() - 1)].0) / 2.,
            (pts[0].1 + pts[1.min(pts.len() - 1)].1) / 2.,
        );
        anchors[ei] = at(first.0, first.1);
        if reversed[ei] {
            pts.reverse();
        }
        routes[ei] = pts.into_iter().map(|(f, c)| at(f, c)).collect();
    }
    let (width, height) = if p.vertical {
        (cross_extent, flow_extent)
    } else {
        (flow_extent, cross_extent)
    };
    Layered {
        pos: (0..n).map(|v| at(fpos(v), c[v])).collect(),
        layer: layer_of[..n].to_vec(),
        routes,
        anchors,
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: Params = Params {
        vertical: false,
        node_gap: 20.,
        layer_gap: 50.,
        edge_gap: 10.,
    };

    #[test]
    fn layers_follow_edges() {
        let sizes = vec![(40., 20.); 4];
        let edges = [
            Edge::new(0, 1, 10., 10.),
            Edge::new(0, 2, 10., 10.),
            Edge::new(1, 3, 10., 10.),
            Edge::new(2, 3, 10., 10.),
        ];
        let l = layered(&sizes, &edges, &P);
        assert_eq!(l.layer, vec![0, 1, 1, 2]);
        assert!(l.pos[1].x > l.pos[0].x + 40.);
        assert!((l.pos[1].y - l.pos[2].y).abs() >= 20. + 20.);
        assert_eq!(l.routes[0].first().unwrap().x, l.pos[0].x + 40.);
    }

    #[test]
    fn breaks_cycles_and_long_edges() {
        let sizes = vec![(40., 20.); 3];
        let edges = [
            Edge::new(0, 1, 10., 10.),
            Edge::new(1, 2, 10., 10.),
            Edge::new(2, 0, 10., 10.),
            Edge::new(0, 2, 10., 10.),
            Edge::new(1, 1, 10., 10.),
        ];
        let l = layered(&sizes, &edges, &P);
        assert_eq!(l.layer, vec![0, 1, 2]);
        assert!(l.routes[4].is_empty());
        // The back edge goes from node 2 to node 0.
        assert_eq!(l.routes[2].first().unwrap().x, l.pos[2].x);
        assert_eq!(l.routes[2].last().unwrap().x, l.pos[0].x + 40.);
    }

    #[test]
    fn places_in_order_with_gaps() {
        let x = place_layer(&[(10., 1.), (0., 1.), (5., 1.)], &[30., 30.]);
        assert!(x[1] - x[0] >= 30. - 1e-9 && x[2] - x[1] >= 30. - 1e-9);
    }
}
