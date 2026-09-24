import leftPad from "left-pad";

export function label(id: number): string {
  return leftPad(String(id), 4, "0");
}
