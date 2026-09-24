/** Minimal ustar builder for worker tests (core's builder is internal to core). */
import { gzipSync } from "node:zlib";

export interface TarEntry {
  readonly name: string;
  readonly body?: string;
  readonly type?: "file" | "directory";
}

function header(name: string, size: number, type: "file" | "directory"): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write(type === "directory" ? "0000755\0" : "0000644\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii");
  h.write(type === "directory" ? "5" : "0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

export function tarGz(entries: readonly TarEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "file";
    const data = Buffer.from(e.body ?? "", "utf8");
    parts.push(header(e.name, type === "file" ? data.length : 0, type));
    if (type === "file" && data.length > 0) {
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
    }
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}
