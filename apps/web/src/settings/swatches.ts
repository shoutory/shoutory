import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export interface Swatch {
  readonly name: MessageDescriptor;
  /** The workspace colour as the server stores it (#rrggbb). */
  readonly colour: string;
  /** The colour of what is drawn on the swatch (the mark of the chosen one). */
  readonly label: string;
}

// The colours a workspace can take. Each is at least 3:1 against the light and the dark surface (so its edge shows
// on both) and carries a label that is at least 4.5:1 on it; the swatches test holds both.
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
