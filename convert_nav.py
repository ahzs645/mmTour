#!/usr/bin/env python3
"""Convert nav.xml to nav-timeline.json using the same format as intro-timeline.json"""

import xml.etree.ElementTree as ET
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from convert_timeline import parse_matrix, parse_color_transform, parse_swf_xml

def find_nav_assets(base_dir):
    """Find available nav SVG shapes, sprites and images."""
    assets = {'shapes': [], 'images': []}

    shapes_dir = os.path.join(base_dir, 'nav', 'shapes')
    if os.path.exists(shapes_dir):
        for f in os.listdir(shapes_dir):
            if f.endswith('.svg'):
                assets['shapes'].append(f.replace('.svg', ''))

    images_dir = os.path.join(base_dir, 'nav', 'images')
    if os.path.exists(images_dir):
        for f in os.listdir(images_dir):
            if f.endswith(('.jpg', '.png')):
                name = os.path.splitext(f)[0]
                ext = os.path.splitext(f)[1]
                assets['images'].append({'id': name, 'ext': ext})

    return assets

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    xml_path = os.path.join(base_dir, 'nav.xml')
    output_path = os.path.join(base_dir, 'nav-timeline.json')

    if not os.path.exists(xml_path):
        print(f"Error: {xml_path} not found")
        sys.exit(1)

    # Parse XML (reuse the same parser)
    data = parse_swf_xml(xml_path)
    if data is None:
        sys.exit(1)

    # Find nav assets
    assets = find_nav_assets(base_dir)
    data['assets'] = assets

    print(f"Found {len(assets['shapes'])} shapes, {len(assets['images'])} images")

    # Write JSON
    print(f"Writing {output_path}...")
    with open(output_path, 'w') as f:
        json.dump(data, f, separators=(',', ':'))

    file_size = os.path.getsize(output_path) / 1024
    print(f"Done! Output: {file_size:.1f} KB")

if __name__ == '__main__':
    main()
