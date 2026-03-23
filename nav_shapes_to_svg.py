#!/usr/bin/env python3
"""
Extract Flash shape definitions from an FFDec-exported XML (nav.xml) and
generate SVG files for each shape.

Handles:
  - Solid color fills (fillStyleType=0)
  - Linear gradients (fillStyleType=16 / 0x10)
  - Radial gradients (fillStyleType=18 / 0x12)
  - Line styles
  - StraightEdgeRecord, CurvedEdgeRecord, StyleChangeRecord
  - Multiple sub-paths with stateNewStyles
  - Bitmap fills are skipped (empty placeholder path emitted)

Coordinates in the XML are twips (1/20 pixel); they are converted to pixels
in the output SVG.
"""

import os
import sys
import xml.etree.ElementTree as ET

TWIP = 20.0  # 1 pixel = 20 twips

XML_PATH = "/Users/ahmadjalil/Desktop/mmTour/nav.xml"
OUTPUT_DIR = "/Users/ahmadjalil/Desktop/mmTour/nav/shapes"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def t(val):
    """Convert twips (int/float) to pixels."""
    return val / TWIP


def parse_int(elem, attr, default=0):
    v = elem.get(attr)
    if v is None:
        return default
    return int(v)


def parse_float(elem, attr, default=0.0):
    v = elem.get(attr)
    if v is None:
        return default
    return float(v)


def color_str(color_elem):
    """Return 'rgb(r,g,b)' or 'rgba(r,g,b,a)' from a color element."""
    r = parse_int(color_elem, "red", 0)
    g = parse_int(color_elem, "green", 0)
    b = parse_int(color_elem, "blue", 0)
    a = color_elem.get("alpha")
    if a is not None:
        a = int(a)
        if a == 255:
            return f"rgb({r},{g},{b})"
        return f"rgba({r},{g},{b},{a / 255:.3f})"
    return f"rgb({r},{g},{b})"


def color_hex(color_elem):
    """Return '#rrggbb' from a color element."""
    r = parse_int(color_elem, "red", 0)
    g = parse_int(color_elem, "green", 0)
    b = parse_int(color_elem, "blue", 0)
    return f"#{r:02x}{g:02x}{b:02x}"


def color_opacity(color_elem):
    """Return opacity 0..1 (defaults to 1 if no alpha)."""
    a = color_elem.get("alpha")
    if a is not None:
        return int(a) / 255.0
    return 1.0


# ---------------------------------------------------------------------------
# Fill style / line style parsing
# ---------------------------------------------------------------------------

class FillStyle:
    """Parsed fill style."""
    def __init__(self, fill_type, color=None, gradient_stops=None,
                 gradient_matrix=None, gradient_type="linear"):
        self.fill_type = fill_type          # int
        self.color = color                  # (r,g,b,a) or None
        self.gradient_stops = gradient_stops  # list of (ratio_0_1, '#rrggbb', opacity)
        self.gradient_matrix = gradient_matrix  # dict with scaleX,scaleY,rotateSkew0,rotateSkew1,translateX,translateY
        self.gradient_type = gradient_type  # "linear" or "radial"


class LineStyle:
    """Parsed line style."""
    def __init__(self, width, color_hex_str, opacity=1.0):
        self.width = width      # in pixels
        self.color = color_hex_str
        self.opacity = opacity


def parse_fill_style(item_elem):
    fst = parse_int(item_elem, "fillStyleType", 0)

    if fst == 0:
        # solid fill
        color_el = item_elem.find("color")
        if color_el is not None:
            return FillStyle(0, color=color_hex(color_el),
                             gradient_stops=None,
                             gradient_matrix=None)
        return FillStyle(0, color="#000000")

    elif fst in (0x10, 0x12):
        # linear (0x10) or radial (0x12) gradient
        grad_type = "linear" if fst == 0x10 else "radial"
        grad_matrix_el = item_elem.find("gradientMatrix")
        grad_el = item_elem.find("gradient")
        stops = []
        if grad_el is not None:
            recs = grad_el.find("gradientRecords")
            if recs is not None:
                for rec in recs.findall("item"):
                    ratio = parse_int(rec, "ratio", 0) / 255.0
                    c_el = rec.find("color")
                    stops.append((ratio, color_hex(c_el), color_opacity(c_el)))
        gm = {}
        if grad_matrix_el is not None:
            gm["scaleX"] = parse_float(grad_matrix_el, "scaleX", 1.0)
            gm["scaleY"] = parse_float(grad_matrix_el, "scaleY", 1.0)
            gm["rotateSkew0"] = parse_float(grad_matrix_el, "rotateSkew0", 0.0)
            gm["rotateSkew1"] = parse_float(grad_matrix_el, "rotateSkew1", 0.0)
            gm["translateX"] = parse_float(grad_matrix_el, "translateX", 0.0)
            gm["translateY"] = parse_float(grad_matrix_el, "translateY", 0.0)
        return FillStyle(fst, gradient_stops=stops,
                         gradient_matrix=gm, gradient_type=grad_type)

    else:
        # bitmap fills (0x40..0x43, 65 etc.) - skip
        return FillStyle(fst)


def parse_fill_styles_array(fs_array_elem):
    """Parse a <fillStyles type='FILLSTYLEARRAY'> element and return list of FillStyle."""
    result = []
    if fs_array_elem is None:
        return result
    # The actual items live inside a nested <fillStyles> child
    inner = fs_array_elem.find("fillStyles")
    if inner is None:
        return result
    for item in inner.findall("item"):
        result.append(parse_fill_style(item))
    return result


def parse_line_styles_array(ls_array_elem):
    """Parse a <lineStyles type='LINESTYLEARRAY'> element and return list of LineStyle."""
    result = []
    if ls_array_elem is None:
        return result
    inner = ls_array_elem.find("lineStyles")
    if inner is None:
        return result
    for item in inner.findall("item"):
        width = parse_int(item, "width", 20) / TWIP
        c_el = item.find("color")
        if c_el is not None:
            result.append(LineStyle(width, color_hex(c_el), color_opacity(c_el)))
        else:
            result.append(LineStyle(width, "#000000", 1.0))
    return result


# ---------------------------------------------------------------------------
# SVG gradient definition builder
# ---------------------------------------------------------------------------

_grad_counter = 0


def make_gradient_def(fill_style, shape_bounds):
    """
    Return (svg_def_string, fill_url_string) for a gradient fill style.

    Flash gradients are defined in a [-16384, 16384] gradient space and then
    mapped to the shape via the gradient matrix.  For SVG we use
    gradientUnits="userSpaceOnUse" and compute the start/end points from the
    Flash gradient matrix.

    The Flash gradient matrix maps the standard gradient square
    ((-16384,-16384) to (16384,16384) in twips, i.e. -819.2..819.2 px)
    to the actual location in shape coordinates.

    For a linear gradient the gradient runs from (-16384,0) to (16384,0) in
    gradient space.  We transform these two points through the gradient matrix
    to get the SVG x1,y1 -> x2,y2.

    For a radial gradient the centre is (0,0) and the radius reaches to
    16384 in gradient space.
    """
    global _grad_counter
    _grad_counter += 1
    gid = f"grad{_grad_counter}"

    gm = fill_style.gradient_matrix
    if not gm:
        # Fallback: just use the bounding box
        gm = {"scaleX": 1.0, "scaleY": 1.0,
              "rotateSkew0": 0.0, "rotateSkew1": 0.0,
              "translateX": 0.0, "translateY": 0.0}

    # Flash gradient matrix values are already in the "fixed point" form
    # from FFDec export.  scaleX/scaleY are the actual scale factors applied
    # to the 32768-twip range.
    #
    # The SWF spec gradient matrix:
    #   | scaleX     rotateSkew1 |   | x |   | translateX |
    #   | rotateSkew0  scaleY    | * | y | + | translateY |
    #
    # Where x,y are in gradient space (-16384..16384 twips).

    sx = gm.get("scaleX", 1.0)
    sy = gm.get("scaleY", 1.0)
    r0 = gm.get("rotateSkew0", 0.0)
    r1 = gm.get("rotateSkew1", 0.0)
    tx = gm.get("translateX", 0.0)
    ty = gm.get("translateY", 0.0)

    # The gradient matrix in SWF transforms from gradient space (twips) to
    # shape space (twips).  But the values from FFDec are *already* the
    # matrix entries with the 16384 scale baked in (i.e., scaleX of the
    # MATRIX record from FFDec = scaleX_raw which maps the unit gradient
    # square to twips).
    #
    # Actually FFDec exports the raw MATRIX values.  In the SWF file format,
    # the gradient matrix transforms the *unit square* (-16384..16384) to
    # the shape coordinate space.  So:
    #   shape_x = scaleX * grad_x + rotateSkew1 * grad_y + translateX
    #   shape_y = rotateSkew0 * grad_x + scaleY * grad_y + translateY
    #
    # For a LINEAR gradient, the gradient line goes from grad_x=-16384 to
    # grad_x=+16384 at grad_y=0.

    HALF = 16384.0  # half-extent of gradient space in twips

    def transform(gx, gy):
        """Transform gradient-space point (twips) to shape-space (twips)."""
        shape_x = sx * gx + r1 * gy + tx
        shape_y = r0 * gx + sy * gy + ty
        return (shape_x / TWIP, shape_y / TWIP)  # convert to pixels

    stops_xml = []
    for ratio, col, opacity in (fill_style.gradient_stops or []):
        op_attr = f' stop-opacity="{opacity:.3f}"' if opacity < 1.0 else ""
        stops_xml.append(
            f'  <stop offset="{ratio:.4f}" stop-color="{col}"{op_attr}/>'
        )
    stops_str = "\n".join(stops_xml)

    if fill_style.gradient_type == "radial":
        cx, cy = transform(0, 0)
        # Radius: distance from centre to edge of gradient space
        rx, ry = transform(HALF, 0)
        r = ((rx - cx) ** 2 + (ry - cy) ** 2) ** 0.5
        if r < 0.001:
            r = 0.001
        svg_def = (
            f'<radialGradient id="{gid}" cx="{cx:.4f}" cy="{cy:.4f}" '
            f'r="{r:.4f}" gradientUnits="userSpaceOnUse">\n'
            f'{stops_str}\n'
            f'</radialGradient>'
        )
    else:
        # linear gradient
        x1, y1 = transform(-HALF, 0)
        x2, y2 = transform(HALF, 0)
        svg_def = (
            f'<linearGradient id="{gid}" x1="{x1:.4f}" y1="{y1:.4f}" '
            f'x2="{x2:.4f}" y2="{y2:.4f}" gradientUnits="userSpaceOnUse">\n'
            f'{stops_str}\n'
            f'</linearGradient>'
        )

    return svg_def, f"url(#{gid})"


# ---------------------------------------------------------------------------
# Path building from shape records
# ---------------------------------------------------------------------------

def build_paths_from_shape(shapes_elem, shape_bounds):
    """
    Walk <shapeRecords> items, track current drawing position, fill/line
    style selections, and emit a list of SVG path groups.

    Returns a list of dicts:
        {
            "d": "M ... L ... Q ...",
            "fill0_idx": int or 0,
            "fill1_idx": int or 0,
            "line_idx": int or 0,
            "fill_styles": [FillStyle, ...],   # 1-based index
            "line_styles": [LineStyle, ...],    # 1-based index
        }
    """
    # Parse initial styles
    fill_styles = parse_fill_styles_array(shapes_elem.find("fillStyles"))
    line_styles = parse_line_styles_array(shapes_elem.find("lineStyles"))

    shape_records_el = shapes_elem.find("shapeRecords")
    if shape_records_el is None:
        return []

    # We'll accumulate sub-paths.  Each sub-path has a sequence of drawing
    # commands and the fill/line indices that were active when the commands
    # were issued.
    #
    # Strategy: every time fill0/fill1/line changes, or a moveTo happens,
    # we start a new segment.  At the end we group segments by their
    # (fill0, fill1, line) tuple and merge path data.

    segments = []  # list of (fill0, fill1, line, d_string, fill_styles_ref, line_styles_ref)

    cur_x = 0.0
    cur_y = 0.0
    cur_fill0 = 0
    cur_fill1 = 0
    cur_line = 0
    cur_d_parts = []
    moved = False

    def flush_segment():
        nonlocal cur_d_parts
        if cur_d_parts and (cur_fill0 or cur_fill1 or cur_line):
            segments.append((cur_fill0, cur_fill1, cur_line,
                             " ".join(cur_d_parts),
                             fill_styles, line_styles))
        cur_d_parts = []

    for item in shape_records_el.findall("item"):
        rec_type = item.get("type", "")

        if rec_type == "EndShapeRecord":
            flush_segment()
            break

        elif rec_type == "StyleChangeRecord":
            # Check for new styles first
            if item.get("stateNewStyles") == "true":
                flush_segment()
                new_fs = item.find("fillStyles")
                new_ls = item.find("lineStyles")
                if new_fs is not None:
                    fill_styles = parse_fill_styles_array(new_fs)
                if new_ls is not None:
                    line_styles = parse_line_styles_array(new_ls)

            # Style changes
            changed = False
            new_f0 = cur_fill0
            new_f1 = cur_fill1
            new_l = cur_line

            if item.get("stateFillStyle0") == "true":
                new_f0 = parse_int(item, "fillStyle0", 0)
            if item.get("stateFillStyle1") == "true":
                new_f1 = parse_int(item, "fillStyle1", 0)
            if item.get("stateLineStyle") == "true":
                new_l = parse_int(item, "lineStyle", 0)

            if new_f0 != cur_fill0 or new_f1 != cur_fill1 or new_l != cur_line:
                flush_segment()
                cur_fill0 = new_f0
                cur_fill1 = new_f1
                cur_line = new_l

            # Move
            if item.get("stateMoveTo") == "true":
                mx = parse_int(item, "moveDeltaX", 0)
                my = parse_int(item, "moveDeltaY", 0)
                cur_x = mx / TWIP
                cur_y = my / TWIP
                cur_d_parts.append(f"M{cur_x:.4f},{cur_y:.4f}")
                moved = True

        elif rec_type == "StraightEdgeRecord":
            dx = parse_int(item, "deltaX", 0) / TWIP
            dy = parse_int(item, "deltaY", 0) / TWIP
            cur_x += dx
            cur_y += dy
            if not moved:
                cur_d_parts.append(f"M{cur_x - dx:.4f},{cur_y - dy:.4f}")
                moved = True
            cur_d_parts.append(f"L{cur_x:.4f},{cur_y:.4f}")

        elif rec_type == "CurvedEdgeRecord":
            cdx = parse_int(item, "controlDeltaX", 0) / TWIP
            cdy = parse_int(item, "controlDeltaY", 0) / TWIP
            adx = parse_int(item, "anchorDeltaX", 0) / TWIP
            ady = parse_int(item, "anchorDeltaY", 0) / TWIP

            cx = cur_x + cdx
            cy = cur_y + cdy
            ax = cx + adx
            ay = cy + ady

            if not moved:
                cur_d_parts.append(f"M{cur_x:.4f},{cur_y:.4f}")
                moved = True
            cur_d_parts.append(f"Q{cx:.4f},{cy:.4f} {ax:.4f},{ay:.4f}")
            cur_x = ax
            cur_y = ay

    # Also flush anything left over
    flush_segment()

    return segments


# ---------------------------------------------------------------------------
# SVG generation for one shape
# ---------------------------------------------------------------------------

def shape_to_svg(shape_elem):
    """
    Convert a DefineShape*Tag element to an SVG string.
    """
    global _grad_counter
    _grad_counter = 0

    bounds_el = shape_elem.find("shapeBounds")
    xmin = parse_int(bounds_el, "Xmin", 0)
    ymin = parse_int(bounds_el, "Ymin", 0)
    xmax = parse_int(bounds_el, "Xmax", 0)
    ymax = parse_int(bounds_el, "Ymax", 0)

    # Add a small margin for line widths
    margin_twips = 100  # 5 px
    vb_x = (xmin - margin_twips) / TWIP
    vb_y = (ymin - margin_twips) / TWIP
    vb_w = (xmax - xmin + 2 * margin_twips) / TWIP
    vb_h = (ymax - ymin + 2 * margin_twips) / TWIP

    shape_bounds = (xmin, ymin, xmax, ymax)

    shapes_el = shape_elem.find("shapes")
    if shapes_el is None:
        return None

    segments = build_paths_from_shape(shapes_el, shape_bounds)
    if not segments:
        return None

    defs_parts = []
    path_parts = []

    # We process segments.  For each segment, we may need to emit
    # a fill and/or a stroke.
    #
    # In Flash, fill0 and fill1 are used for the "left" and "right" sides of
    # the edge.  For simple shapes fill1 is the "inside" fill.
    # We combine segments that share the same fill style to build complete
    # filled regions, and similarly for strokes.

    # Group paths by (fill_index, fill_styles_ref_id) for fills,
    # and by (line_index, line_styles_ref_id) for lines.

    # For fills: both fill0 and fill1 contribute to filling.
    # fill1 paths are drawn as-is, fill0 paths are drawn reversed (they
    # define the "other side").  For simplicity, we'll just draw them all
    # forward since for closed shapes the winding rule will handle it.

    from collections import defaultdict

    fill_paths = defaultdict(list)  # key: (id(fill_styles), fill_idx) -> list of d strings
    line_paths = defaultdict(list)  # key: (id(line_styles), line_idx) -> list of d strings

    fill_style_map = {}  # key -> FillStyle object
    line_style_map = {}  # key -> LineStyle object

    for (f0, f1, ls, d_str, fstyles, lstyles) in segments:
        if f1 > 0 and f1 <= len(fstyles):
            key = (id(fstyles), f1)
            fill_paths[key].append(d_str)
            fill_style_map[key] = fstyles[f1 - 1]
        if f0 > 0 and f0 <= len(fstyles):
            key = (id(fstyles), f0)
            fill_paths[key].append(d_str)
            fill_style_map[key] = fstyles[f0 - 1]
        if ls > 0 and ls <= len(lstyles):
            key = (id(lstyles), ls)
            line_paths[key].append(d_str)
            line_style_map[key] = lstyles[ls - 1]

    # Emit filled paths first, then stroked paths on top
    for key, d_list in fill_paths.items():
        fs = fill_style_map[key]
        combined_d = " ".join(d_list)
        if not combined_d.strip():
            continue

        if fs.fill_type == 0:
            # Solid fill
            fill_attr = fs.color or "#000000"
            path_parts.append(
                f'<path d="{combined_d}" fill="{fill_attr}" '
                f'fill-rule="evenodd" stroke="none"/>'
            )

        elif fs.fill_type in (0x10, 0x12):
            # Gradient
            svg_def, fill_url = make_gradient_def(fs, shape_bounds)
            defs_parts.append(svg_def)
            path_parts.append(
                f'<path d="{combined_d}" fill="{fill_url}" '
                f'fill-rule="evenodd" stroke="none"/>'
            )

        else:
            # Bitmap fill or unknown - emit path with a placeholder grey
            path_parts.append(
                f'<path d="{combined_d}" fill="#cccccc" '
                f'fill-rule="evenodd" stroke="none" opacity="0.3"/>'
            )

    for key, d_list in line_paths.items():
        ls_obj = line_style_map[key]
        combined_d = " ".join(d_list)
        if not combined_d.strip():
            continue
        op_attr = f' opacity="{ls_obj.opacity:.3f}"' if ls_obj.opacity < 1.0 else ""
        path_parts.append(
            f'<path d="{combined_d}" fill="none" '
            f'stroke="{ls_obj.color}" stroke-width="{ls_obj.width:.2f}" '
            f'stroke-linecap="round" stroke-linejoin="round"{op_attr}/>'
        )

    if not path_parts:
        return None

    defs_str = ""
    if defs_parts:
        defs_str = "<defs>\n" + "\n".join(defs_parts) + "\n</defs>\n"

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{vb_x:.4f} {vb_y:.4f} {vb_w:.4f} {vb_h:.4f}" '
        f'width="{vb_w:.2f}" height="{vb_h:.2f}">\n'
        f'{defs_str}'
        + "\n".join(path_parts) + "\n"
        f'</svg>\n'
    )
    return svg


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Determine which shape IDs already have SVGs
    existing_ids = set()
    for fn in os.listdir(OUTPUT_DIR):
        if fn.endswith(".svg"):
            try:
                sid = int(fn[:-4])
                existing_ids.add(sid)
            except ValueError:
                pass

    print(f"Existing SVGs: {sorted(existing_ids)}")
    print(f"Parsing {XML_PATH} ...")

    tree = ET.parse(XML_PATH)
    root = tree.getroot()

    # Find all DefineShape*Tag elements (they can be nested inside subTags too,
    # but typically shapes are at the top level tags)
    shape_tags = []
    for item in root.iter("item"):
        tag_type = item.get("type", "")
        if tag_type in ("DefineShapeTag", "DefineShape2Tag",
                        "DefineShape3Tag", "DefineShape4Tag"):
            sid = parse_int(item, "shapeId", -1)
            if sid >= 0:
                shape_tags.append((sid, item))

    print(f"Found {len(shape_tags)} shape definitions in XML.")

    created = 0
    skipped_existing = 0
    failed = 0

    for sid, elem in shape_tags:
        if sid in existing_ids:
            skipped_existing += 1
            continue

        try:
            svg = shape_to_svg(elem)
            if svg:
                out_path = os.path.join(OUTPUT_DIR, f"{sid}.svg")
                with open(out_path, "w", encoding="utf-8") as f:
                    f.write(svg)
                created += 1
                print(f"  Created: {sid}.svg")
            else:
                print(f"  Empty:   {sid} (no renderable paths)")
        except Exception as e:
            failed += 1
            print(f"  FAILED:  {sid}: {e}")
            import traceback
            traceback.print_exc()

    print(f"\nDone. Created={created}, Skipped(existing)={skipped_existing}, Failed={failed}")


if __name__ == "__main__":
    main()
