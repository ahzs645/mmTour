#!/usr/bin/env python3
"""
SWF XML to JSON Timeline Converter
Parses the FFDec-exported XML and creates a compact JSON timeline for web playback.
"""

import xml.etree.ElementTree as ET
import json
import os
import sys

def parse_matrix(matrix_elem):
    """Parse a MATRIX element into a dict."""
    if matrix_elem is None:
        return None

    # Check if scale/rotate are present - if not, default to identity
    has_scale = matrix_elem.get('hasScale', 'false') == 'true'
    has_rotate = matrix_elem.get('hasRotate', 'false') == 'true'

    # Default to identity matrix values
    sx = 1.0
    sy = 1.0
    r0 = 0.0
    r1 = 0.0

    if has_scale:
        sx = float(matrix_elem.get('scaleX', 1))
        sy = float(matrix_elem.get('scaleY', 1))

    if has_rotate:
        r0 = float(matrix_elem.get('rotateSkew0', 0))
        r1 = float(matrix_elem.get('rotateSkew1', 0))

    return {
        'sx': sx,
        'sy': sy,
        'r0': r0,
        'r1': r1,
        'tx': float(matrix_elem.get('translateX', 0)) / 20,  # Convert twips to pixels
        'ty': float(matrix_elem.get('translateY', 0)) / 20
    }

def parse_color_transform(ct_elem):
    """Parse a ColorTransform element.

    Flash color transform formula: new = (original * mult / 256) + add
    """
    if ct_elem is None:
        return None

    result = {
        'am': int(ct_elem.get('alphaMultTerm', 256)) / 256,
        'rm': int(ct_elem.get('redMultTerm', 256)) / 256,
        'gm': int(ct_elem.get('greenMultTerm', 256)) / 256,
        'bm': int(ct_elem.get('blueMultTerm', 256)) / 256,
    }

    # Add additive terms (keep as raw 0-255 values for SVG filter)
    # Flash additive terms range from -255 to +255
    has_add = ct_elem.get('hasAddTerms') == 'true'
    if has_add:
        result['ra'] = int(ct_elem.get('redAddTerm', 0))
        result['ga'] = int(ct_elem.get('greenAddTerm', 0))
        result['ba'] = int(ct_elem.get('blueAddTerm', 0))
        result['aa'] = int(ct_elem.get('alphaAddTerm', 0))

    return result

def parse_swf_xml(xml_path):
    """Parse the SWF XML and extract timeline data."""
    print(f"Parsing {xml_path}...")

    tree = ET.parse(xml_path)
    root = tree.getroot()

    # Get SWF metadata
    frame_rate = float(root.get('frameRate', 15))
    frame_count = int(root.get('frameCount', 0))

    # Get stage dimensions
    display_rect = root.find('.//displayRect')
    stage_width = int(display_rect.get('Xmax', 12800)) / 20 if display_rect is not None else 640
    stage_height = int(display_rect.get('Ymax', 9600)) / 20 if display_rect is not None else 480

    print(f"Stage: {stage_width}x{stage_height}, {frame_count} frames at {frame_rate} fps")

    # Track characters (shapes, images, sprites)
    characters = {}

    # Track frames
    frames = []
    current_frame = {'place': [], 'remove': []}

    # Parse main timeline tags
    tags = root.find('tags')
    if tags is None:
        print("No tags found!")
        return None

    for item in tags.findall('item'):
        tag_type = item.get('type')

        # Define Shape
        if tag_type in ('DefineShapeTag', 'DefineShape2Tag', 'DefineShape3Tag', 'DefineShape4Tag'):
            shape_id = item.get('shapeId')
            if shape_id:
                characters[shape_id] = {'type': 'shape', 'id': shape_id}

        # Define Image
        elif tag_type in ('DefineBitsJPEG2Tag', 'DefineBitsJPEG3Tag',
                          'DefineBitsLosslessTag', 'DefineBitsLossless2Tag'):
            char_id = item.get('characterId')
            if char_id:
                characters[char_id] = {'type': 'image', 'id': char_id}

        # Define Sprite
        elif tag_type == 'DefineSpriteTag':
            sprite_id = item.get('spriteId')
            if sprite_id:
                sprite_data = {'type': 'sprite', 'id': sprite_id}
                # Extract the shape contained in this sprite (for single-frame sprites)
                sub_tags = item.find('subTags')
                if sub_tags is not None:
                    for sub_item in sub_tags.findall('item'):
                        sub_type = sub_item.get('type')
                        if sub_type in ('PlaceObjectTag', 'PlaceObject2Tag', 'PlaceObject3Tag'):
                            char_id = sub_item.get('characterId')
                            if char_id and char_id != '0':
                                sprite_data['contains'] = char_id
                                # Also get the internal transform
                                sub_matrix = sub_item.find('matrix')
                                if sub_matrix is not None:
                                    sprite_data['innerTransform'] = parse_matrix(sub_matrix)
                                break  # Just get the first placed object
                characters[sprite_id] = sprite_data

        # Place Object
        elif tag_type in ('PlaceObjectTag', 'PlaceObject2Tag', 'PlaceObject3Tag'):
            place_data = {
                'd': int(item.get('depth', 0))  # depth
            }

            move = item.get('placeFlagMove') == 'true'
            if move:
                place_data['m'] = 1  # move flag (update existing object)

            # Only include characterId if placing a new object (not moving)
            # or if explicitly has a character
            has_character = item.get('placeFlagHasCharacter') == 'true'
            char_id = item.get('characterId')
            if has_character and char_id and char_id != '0':
                place_data['c'] = char_id  # characterId

            # Check for clip depth (masking)
            has_clip_depth = item.get('placeFlagHasClipDepth') == 'true'
            if has_clip_depth:
                clip_depth = item.get('clipDepth')
                if clip_depth:
                    place_data['cd'] = int(clip_depth)  # clipDepth - masks depths from current to this value

            # Parse matrix
            matrix = item.find('matrix')
            if matrix is not None:
                place_data['t'] = parse_matrix(matrix)  # transform

            # Parse color transform
            color_transform = item.find('colorTransform')
            if color_transform is not None:
                ct = parse_color_transform(color_transform)
                if ct:
                    place_data['ct'] = ct

            current_frame['place'].append(place_data)

        # Remove Object
        elif tag_type in ('RemoveObjectTag', 'RemoveObject2Tag'):
            depth = item.get('depth')
            if depth:
                current_frame['remove'].append(int(depth))

        # Show Frame - end of frame
        elif tag_type == 'ShowFrameTag':
            frames.append(current_frame)
            current_frame = {'place': [], 'remove': []}

            if len(frames) % 100 == 0:
                print(f"  Processed {len(frames)} frames...")

    print(f"Parsed {len(frames)} frames, {len(characters)} characters")

    return {
        'meta': {
            'fps': frame_rate,
            'frames': len(frames),
            'width': stage_width,
            'height': stage_height
        },
        'characters': characters,
        'timeline': frames
    }

def find_assets(base_dir):
    """Find available SVG shapes and images."""
    assets = {'shapes': [], 'images': []}

    shapes_dir = os.path.join(base_dir, 'intro', 'shapes')
    if os.path.exists(shapes_dir):
        for f in os.listdir(shapes_dir):
            if f.endswith('.svg'):
                assets['shapes'].append(f.replace('.svg', ''))

    images_dir = os.path.join(base_dir, 'intro', 'images')
    if os.path.exists(images_dir):
        for f in os.listdir(images_dir):
            if f.endswith(('.jpg', '.png')):
                name = os.path.splitext(f)[0]
                ext = os.path.splitext(f)[1]
                assets['images'].append({'id': name, 'ext': ext})

    return assets

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    xml_path = os.path.join(base_dir, 'intro.xml')
    output_path = os.path.join(base_dir, 'intro-timeline.json')

    if not os.path.exists(xml_path):
        print(f"Error: {xml_path} not found")
        sys.exit(1)

    # Parse XML
    data = parse_swf_xml(xml_path)
    if data is None:
        sys.exit(1)

    # Find available assets
    assets = find_assets(base_dir)
    data['assets'] = assets

    print(f"Found {len(assets['shapes'])} shapes, {len(assets['images'])} images")

    # Write JSON
    print(f"Writing {output_path}...")
    with open(output_path, 'w') as f:
        json.dump(data, f, separators=(',', ':'))  # Compact JSON

    # Also write a pretty version for debugging
    debug_path = os.path.join(base_dir, 'intro-timeline-debug.json')
    with open(debug_path, 'w') as f:
        json.dump(data, f, indent=2)

    file_size = os.path.getsize(output_path) / 1024
    print(f"Done! Output: {file_size:.1f} KB")

if __name__ == '__main__':
    main()
