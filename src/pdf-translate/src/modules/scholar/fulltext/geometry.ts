/**
 * Zotero Scholar Suite — full-text translation (with figures)
 * Geometry helpers. Environment agnostic (runs in Zotero and in Node).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m1: ArrayLike<number>, m2: ArrayLike<number>): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function applyPoint(m: ArrayLike<number>, x: number, y: number) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function transformRect(
  m: ArrayLike<number>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Box {
  const pts = [
    applyPoint(m, x0, y0),
    applyPoint(m, x1, y0),
    applyPoint(m, x0, y1),
    applyPoint(m, x1, y1),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

export function width(b: Box) {
  return b.x1 - b.x0;
}
export function height(b: Box) {
  return b.y1 - b.y0;
}
export function area(b: Box) {
  return Math.max(0, width(b)) * Math.max(0, height(b));
}

export function union(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

export function intersect(a: Box, b: Box): Box | null {
  const r = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

export function overlapArea(a: Box, b: Box) {
  const i = intersect(a, b);
  return i ? area(i) : 0;
}

/** fraction of `a` covered by `b` */
export function coverage(a: Box, b: Box) {
  const aa = area(a);
  return aa > 0 ? overlapArea(a, b) / aa : 0;
}

export function center(b: Box) {
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

export function contains(outer: Box, p: { x: number; y: number }, pad = 0) {
  return (
    p.x >= outer.x0 - pad &&
    p.x <= outer.x1 + pad &&
    p.y >= outer.y0 - pad &&
    p.y <= outer.y1 + pad
  );
}

export function expand(b: Box, d: number): Box {
  return { x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d };
}

export function clamp(b: Box, page: Box): Box {
  return {
    x0: Math.max(page.x0, b.x0),
    y0: Math.max(page.y0, b.y0),
    x1: Math.min(page.x1, b.x1),
    y1: Math.min(page.y1, b.y1),
  };
}

export function hOverlap(a: Box, b: Box) {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
}

export function vOverlap(a: Box, b: Box) {
  return Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
}

/** distance between boxes (0 if overlapping) */
export function gap(a: Box, b: Box) {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
  const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
  return Math.hypot(dx, dy);
}

/** Merge boxes that are within `tol` of each other (single-linkage clustering). */
export function clusterBoxes(boxes: Box[], tol: number): Box[] {
  let out = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    const next: Box[] = [];
    const used = new Array(out.length).fill(false);
    for (let i = 0; i < out.length; i++) {
      if (used[i]) continue;
      let cur = out[i];
      used[i] = true;
      for (let j = i + 1; j < out.length; j++) {
        if (used[j]) continue;
        if (gap(cur, out[j]) <= tol) {
          cur = union(cur, out[j]);
          used[j] = true;
          changed = true;
        }
      }
      next.push(cur);
    }
    out = next;
  }
  return out;
}
