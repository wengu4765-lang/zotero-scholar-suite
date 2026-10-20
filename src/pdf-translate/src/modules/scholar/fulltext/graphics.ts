/**
 * Zotero Scholar Suite — full-text translation (with figures)
 * Walk a pdf.js operator list and collect where raster images and vector
 * drawings are painted (bounding boxes in viewport space).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Box, Matrix, IDENTITY, mul, transformRect, area, width, height } from "./geometry";

export interface GraphicBox {
  box: Box;
  type: "image" | "vector";
}

export function collectGraphics(
  opList: { fnArray: ArrayLike<number>; argsArray: any[] },
  OPS: Record<string, number>,
  viewportTransform: number[],
  pageBox: Box,
): GraphicBox[] {
  const out: GraphicBox[] = [];
  let ctm: Matrix = IDENTITY.slice() as Matrix;
  const stack: Matrix[] = [];
  const pageArea = area(pageBox);

  const imageOps = new Set(
    [
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintImageMaskXObjectRepeat,
      OPS.paintSolidColorImageMask,
      OPS.paintInlineImageXObjectGroup,
      OPS.paintImageMaskXObjectGroup,
    ].filter((x) => typeof x === "number"),
  );

  const pushBox = (b: Box, type: GraphicBox["type"]) => {
    if (!isFinite(b.x0) || !isFinite(b.y0) || !isFinite(b.x1) || !isFinite(b.y1)) return;
    // clip to page
    const c = {
      x0: Math.max(pageBox.x0, b.x0),
      y0: Math.max(pageBox.y0, b.y0),
      x1: Math.min(pageBox.x1, b.x1),
      y1: Math.min(pageBox.y1, b.y1),
    };
    if (c.x1 <= c.x0 || c.y1 <= c.y0) {
      // zero-height horizontal rules are still informative for tables
      if (type === "vector" && c.x1 > c.x0 && Math.abs(b.y1 - b.y0) < 2) {
        out.push({ box: { x0: c.x0, x1: c.x1, y0: b.y0 - 0.5, y1: b.y1 + 0.5 }, type });
      }
      return;
    }
    // ignore page-sized backgrounds
    if (area(c) > 0.85 * pageArea) return;
    out.push({ box: c, type });
  };

  const fn = opList.fnArray;
  const args = opList.argsArray;
  for (let i = 0; i < fn.length; i++) {
    const op = fn[i];
    const a = args[i];
    switch (op) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() || ctm;
        break;
      case OPS.transform:
        if (a && a.length >= 6) ctm = mul(ctm, a);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(ctm);
        const m = a && a[0];
        if (m && m.length >= 6) ctm = mul(ctm, m);
        break;
      }
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() || ctm;
        break;
      case OPS.beginGroup:
        stack.push(ctm);
        if (a && a[0] && a[0].matrix) ctm = mul(ctm, a[0].matrix);
        break;
      case OPS.endGroup:
        ctm = stack.pop() || ctm;
        break;
      case OPS.constructPath: {
        // pdf.js >= 5: [drawOp, [pathData], minMax]; older: [ops, args, minMax]
        const minMax = a && a[2];
        if (minMax && minMax.length >= 4) {
          const [x0, y0, x1, y1] = [minMax[0], minMax[1], minMax[2], minMax[3]];
          if (isFinite(x0) && isFinite(y0) && x1 >= x0 && y1 >= y0) {
            const m = mul(viewportTransform, ctm);
            const b = transformRect(m, x0, y0, x1, y1);
            pushBox(b, "vector");
          }
        }
        break;
      }
      case OPS.shadingFill:
        break;
      default:
        if (imageOps.has(op)) {
          const m = mul(viewportTransform, ctm);
          const b = transformRect(m, 0, 0, 1, 1);
          if (width(b) >= 4 && height(b) >= 4) pushBox(b, "image");
        }
    }
  }
  return out;
}
