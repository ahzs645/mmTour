// Canonical AVM1 bytecode op shape, shared between the build-time parser
// (`convert/avm1/parse.ts`) and the runtime VM that interprets data-driven AS2
// apps. Lives in `data/` so `timelineTypes` can reference it without depending
// on the convert layer. A structured action list where DefineFunction(2) carries
// its body as a nested program (the flat disassembler inlines bodies, which a VM
// can't execute).

export interface Avm1Op {
  op: string;
  code: number;
  // operands (per op)
  values?: any[]; // Push
  frame?: number; // GotoFrame
  label?: string; // GotoLabel / GotoFrame2 bias unused
  url?: string; // GetUrl
  target?: string; // GetUrl / SetTarget
  register?: number; // StoreRegister
  branchOffset?: number; // If / Jump (byte delta)
  jumpTo?: number; // resolved index into the action list
  play?: boolean; // GotoFrame2
  loadVariablesFlag?: boolean; // GetUrl2
  loadTargetFlag?: boolean; // GetUrl2
  sendVarsMethod?: number; // GetUrl2
  name?: string; // DefineFunction(2)
  params?: { register?: number; name: string }[];
  registerCount?: number;
  flags?: number;
  body?: Avm1Op[]; // DefineFunction(2) body
}
