// Mutable extraction context shared by build-asset-timeline.mjs and its discovery
// modules. The orchestrator populates these fields in order as it parses the FFDec
// XML; discovery functions read them instead of closing over module-level state.
export const ctx = {};
