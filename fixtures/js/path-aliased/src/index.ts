import { chunk } from "lodash-es";
import { helper } from "@app/helper";

export function group(ids: number[]): number[][] {
  return chunk(ids.map(helper), 2);
}
