import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export interface Swatch {
  readonly name: MessageDescriptor;
  readonly colour: string;
  readonly label: string;
}

// Each colour needs 3:1 against both surfaces so its edge shows, and 4.5:1 for the label on it.
const LABEL = "#000000";
export const SWATCHES: readonly Swatch[] = [
  { name: msg({ id: "settings.colour.red", message: "Red" }), colour: "#e05a4f", label: LABEL },
  { name: msg({ id: "settings.colour.orange", message: "Orange" }), colour: "#d97706", label: LABEL },
  { name: msg({ id: "settings.colour.amber", message: "Amber" }), colour: "#b7791f", label: LABEL },
  { name: msg({ id: "settings.colour.green", message: "Green" }), colour: "#2f9e5f", label: LABEL },
  { name: msg({ id: "settings.colour.teal", message: "Teal" }), colour: "#1a9a94", label: LABEL },
  { name: msg({ id: "settings.colour.blue", message: "Blue" }), colour: "#3b82d6", label: LABEL },
  { name: msg({ id: "settings.colour.purple", message: "Purple" }), colour: "#9b6ad8", label: LABEL },
  { name: msg({ id: "settings.colour.pink", message: "Pink" }), colour: "#d6558f", label: LABEL },
];
