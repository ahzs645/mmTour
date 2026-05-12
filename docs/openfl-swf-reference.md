# OpenFL SWF Reference Notes

This project uses OpenFL SWF as an architecture reference, not as the primary extractor. FFDec remains the source for exported assets and XML, and Open Flash `swf-parser` remains the byte-level structural parser.

OpenFL's SWF asset workflow supports the same concepts this converter needs to preserve: shapes, SimpleButtons, MovieClips, masks, scrollRects, filters, and blend modes. The generated web model follows that vocabulary:

| OpenFL / Flash concept | Generated project artifact |
| --- | --- |
| MovieClip timeline | `timeline.json.frames`, nested `control-flow.json.nestedMovieClips`, sprite frame SVGs |
| SimpleButton | `control-flow.json.buttonDefinitions` |
| Button hitTest state | `buttonDefinitions[].hitAreas` and `clickableRegions` |
| Button up/over/down states | `buttonDefinitions[].states` |
| DisplayObject transform | CSS/SVG matrix from FFDec XML and Open Flash parser records |
| Masks / filters / blend modes | Preserved in FFDec frame SVG output; tracked as future asset-timeline compiler work |

Current implementation choice:

- `Frame SVG` mode is the fidelity path because FFDec already resolves masks, filters, blend modes, text, and nested display-list composition into each root frame.
- The generated control-flow model is separated from rendering so a deeper MovieClip runtime can later replace frame snapshots without changing extracted behavior data.
- `buttonDefinitions` deliberately preserve all SimpleButton states even though the current renderer mainly uses `hitAreas` for interaction.

References used:

- OpenFL SWF asset tutorial: https://www.openfl.org/learn/haxelib/tutorials/using-swf-assets/
- OpenFL SWF repository: https://github.com/openfl/swf
- OpenFL SimpleButton API: https://api.openfl.org/openfl/display/SimpleButton.html
- OpenFL MovieClip API: https://api.openfl.org/openfl/display/MovieClip.html
