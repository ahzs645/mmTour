// AVM1 display-object property metadata. The numbered entries are Flash
// getProperty/setProperty indices; named-only entries cover common AVM1 object
// fields used through dot paths (TextField.text, Button.enabled, etc.).

export type Avm1PropertyValueType =
  | "any"
  | "boolean"
  | "number"
  | "string";

export type Avm1PropertyOwner =
  | "button"
  | "display"
  | "global"
  | "movieclip"
  | "textfield";

export type Avm1PropertyAccess = "read" | "readwrite";

export type Avm1PropertyDefinition = {
  canonicalName: string;
  index?: number;
  aliases: readonly string[];
  owner: Avm1PropertyOwner;
  access: Avm1PropertyAccess;
  valueType: Avm1PropertyValueType;
};

const AVM1_INDEXED_PROPERTIES = [
  property("_x", 0, "display", "readwrite", "number"),
  property("_y", 1, "display", "readwrite", "number"),
  property("_xscale", 2, "display", "readwrite", "number"),
  property("_yscale", 3, "display", "readwrite", "number"),
  property("_currentframe", 4, "movieclip", "read", "number"),
  property("_totalframes", 5, "movieclip", "read", "number"),
  property("_alpha", 6, "display", "readwrite", "number"),
  property("_visible", 7, "display", "readwrite", "boolean"),
  property("_width", 8, "display", "readwrite", "number"),
  property("_height", 9, "display", "readwrite", "number"),
  property("_rotation", 10, "display", "readwrite", "number"),
  property("_target", 11, "movieclip", "read", "string"),
  property("_framesloaded", 12, "movieclip", "read", "number"),
  property("_name", 13, "display", "readwrite", "string"),
  property("_droptarget", 14, "movieclip", "read", "string"),
  property("_url", 15, "movieclip", "read", "string"),
  property("_highquality", 16, "global", "readwrite", "number"),
  property("_focusrect", 17, "global", "readwrite", "boolean"),
  property("_soundbuftime", 18, "global", "readwrite", "number"),
  property("_quality", 19, "global", "readwrite", "string"),
  property("_xmouse", 20, "movieclip", "read", "number"),
  property("_ymouse", 21, "movieclip", "read", "number"),
] as const satisfies readonly Avm1PropertyDefinition[];

const AVM1_NAMED_PROPERTIES = [
  property("enabled", undefined, "button", "readwrite", "boolean"),
  property("text", undefined, "textfield", "readwrite", "string"),
  property("htmlText", undefined, "textfield", "readwrite", "string", ["htmltext"]),
  property("html", undefined, "textfield", "readwrite", "boolean"),
  property("variable", undefined, "textfield", "readwrite", "string"),
  property("selectable", undefined, "textfield", "readwrite", "boolean"),
  property("type", undefined, "textfield", "readwrite", "string"),
  property("wordWrap", undefined, "textfield", "readwrite", "boolean", ["wordwrap"]),
  property("multiline", undefined, "textfield", "readwrite", "boolean"),
] as const satisfies readonly Avm1PropertyDefinition[];

export const AVM1_PROPERTIES = [
  ...AVM1_INDEXED_PROPERTIES,
  ...AVM1_NAMED_PROPERTIES,
] as const satisfies readonly Avm1PropertyDefinition[];

export const AVM1_PROPERTY_INDEXES: ReadonlyMap<number, Avm1PropertyDefinition> = new Map(
  AVM1_PROPERTIES
    .filter((definition) => definition.index !== undefined)
    .map((definition) => [definition.index as number, definition]),
);

export const AVM1_PROPERTY_NAMES: ReadonlyMap<string, Avm1PropertyDefinition> = new Map(
  AVM1_PROPERTIES.flatMap((definition) => [
    [propertyKey(definition.canonicalName), definition] as const,
    ...definition.aliases.map((alias) => [propertyKey(alias), definition] as const),
  ]),
);

export function getAvm1PropertyByIndex(index: number): Avm1PropertyDefinition | undefined {
  return AVM1_PROPERTY_INDEXES.get(index);
}

export function getAvm1PropertyByName(name: string): Avm1PropertyDefinition | undefined {
  return AVM1_PROPERTY_NAMES.get(propertyKey(name));
}

export function resolveAvm1Property(ref: string | number): Avm1PropertyDefinition | undefined {
  if (typeof ref === "number") return getAvm1PropertyByIndex(ref);
  const numeric = Number(ref);
  if (ref.trim() !== "" && Number.isInteger(numeric)) return getAvm1PropertyByIndex(numeric);
  return getAvm1PropertyByName(ref);
}

export function normalizeAvm1PropertyName(name: string): string | undefined {
  return getAvm1PropertyByName(name)?.canonicalName;
}

export function isAvm1PropertyName(name: string): boolean {
  return getAvm1PropertyByName(name) !== undefined;
}

export function isWritableAvm1Property(property: Avm1PropertyDefinition): boolean {
  return property.access === "readwrite";
}

export function propertyKey(name: string): string {
  return name.trim().toLowerCase();
}

function property(
  canonicalName: string,
  index: number | undefined,
  owner: Avm1PropertyOwner,
  access: Avm1PropertyAccess,
  valueType: Avm1PropertyValueType,
  aliases: readonly string[] = [],
): Avm1PropertyDefinition {
  return {
    canonicalName,
    index,
    aliases,
    owner,
    access,
    valueType,
  };
}
