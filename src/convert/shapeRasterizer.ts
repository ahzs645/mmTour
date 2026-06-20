// SWF DefineShape → stitched vector contours, in pure TypeScript.
//
// The SWF shape model is an edge list where every edge carries up to two fill
// styles (fill0 = "left" side, fill1 = "right" side) and one line style. To turn
// that into fillable paths we walk the records, emit each edge into its fill's
// segment bucket (the left-fill edge reversed so a fill's boundary winds
// consistently), then stitch each bucket's directed segments into closed
// contours by following shared endpoints. This is the same approach Ruffle and
// the old open-source Flash players use; it is FFDec-independent.

const REC_EDGE = 0; // ShapeRecordType.Edge
const REC_STYLE = 1; // ShapeRecordType.StyleChange

export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Quadratic control point (twips), present for curved edges only. */
  cx?: number;
  cy?: number;
}

export interface FillPath {
  /** The resolved SWF fill style (Solid / *Gradient / Bitmap). */
  fill: any;
  /** Paint order, ascending — lower draws first. */
  order: number;
  contours: Seg[][];
}

export interface LinePath {
  line: any;
  order: number;
  chains: Seg[][];
}

export interface RasterizedShape {
  fills: FillPath[];
  lines: LinePath[];
}

/** Walk a parsed `Shape` (initialStyles + records) into stitched contours. */
export function rasterizeShape(shape: any): RasterizedShape {
  let fillStyles: any[] = shape.initialStyles.fill;
  let lineStyles: any[] = shape.initialStyles.line;

  let x = 0;
  let y = 0;
  let fill0 = 0;
  let fill1 = 0;
  let line = 0;

  // Key buckets by the resolved style object so a `newStyles` group switch can
  // never collide indices across groups. `order` preserves first-seen paint order.
  const fillBuckets = new Map<any, Seg[]>();
  const lineBuckets = new Map<any, Seg[]>();
  const order = new Map<any, number>();
  let next = 0;
  const bucket = (map: Map<any, Seg[]>, style: any, seg: Seg) => {
    let segs = map.get(style);
    if (!segs) {
      segs = [];
      map.set(style, segs);
      if (!order.has(style)) order.set(style, next++);
    }
    segs.push(seg);
  };

  for (const rec of shape.records) {
    if (rec.type === REC_STYLE) {
      if (rec.newStyles) {
        fillStyles = rec.newStyles.fill;
        lineStyles = rec.newStyles.line;
      }
      if (rec.moveTo) {
        x = rec.moveTo.x;
        y = rec.moveTo.y;
      }
      if (rec.leftFill !== undefined) fill0 = rec.leftFill;
      if (rec.rightFill !== undefined) fill1 = rec.rightFill;
      if (rec.lineStyle !== undefined) line = rec.lineStyle;
      continue;
    }

    // Edge: delta and controlDelta are both relative to the edge start.
    const x2 = x + rec.delta.x;
    const y2 = y + rec.delta.y;
    let cx: number | undefined;
    let cy: number | undefined;
    if (rec.controlDelta) {
      cx = x + rec.controlDelta.x;
      cy = y + rec.controlDelta.y;
    }

    if (fill1 > 0) bucket(fillBuckets, fillStyles[fill1 - 1], { x1: x, y1: y, x2, y2, cx, cy });
    if (fill0 > 0) bucket(fillBuckets, fillStyles[fill0 - 1], { x1: x2, y1: y2, x2: x, y2: y, cx, cy });
    if (line > 0) bucket(lineBuckets, lineStyles[line - 1], { x1: x, y1: y, x2, y2, cx, cy });

    x = x2;
    y = y2;
  }

  const fills: FillPath[] = [];
  for (const [fill, segs] of fillBuckets) {
    fills.push({ fill, order: order.get(fill)!, contours: stitch(segs) });
  }
  const lines: LinePath[] = [];
  for (const [lineStyle, segs] of lineBuckets) {
    lines.push({ line: lineStyle, order: order.get(lineStyle)!, chains: stitch(segs) });
  }
  fills.sort((a, b) => a.order - b.order);
  lines.sort((a, b) => a.order - b.order);
  return { fills, lines };
}

/**
 * Greedily chain directed segments into contours by matching exact endpoints.
 * Coordinates are integer twips, so equality keying is exact. Each bucket's
 * segments form balanced closed loops (the left/right convention guarantees
 * equal in/out degree per vertex), so consuming every segment yields closed
 * fill contours; line buckets come out as polylines.
 */
function stitch(segs: Seg[]): Seg[][] {
  const key = (x: number, y: number) => `${x}_${y}`;
  const byStart = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const k = key(s.x1, s.y1);
    const list = byStart.get(k);
    if (list) list.push(i);
    else byStart.set(k, [i]);
  });

  const used = new Array<boolean>(segs.length).fill(false);
  const contours: Seg[][] = [];

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const contour: Seg[] = [];
    let cur = i;
    while (cur !== -1 && !used[cur]) {
      used[cur] = true;
      const seg = segs[cur];
      contour.push(seg);
      const cands = byStart.get(key(seg.x2, seg.y2));
      let nxt = -1;
      if (cands) {
        for (const c of cands) {
          if (!used[c]) {
            nxt = c;
            break;
          }
        }
      }
      cur = nxt;
    }
    contours.push(contour);
  }
  return contours;
}
