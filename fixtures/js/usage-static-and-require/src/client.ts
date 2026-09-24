import axios from "axios";
import { format } from "@scope/util/format";
import { readFile } from "node:fs/promises";
import { local } from "./local.js";

export async function load(id: string) {
  const res = await axios.get(`/items/${id}`);
  await axios.post("/seen", { id });
  return format(res.data, local, await readFile("x", "utf8"));
}
