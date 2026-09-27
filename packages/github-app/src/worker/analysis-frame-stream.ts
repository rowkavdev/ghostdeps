/**
 * Byte-limited collector for one child output frame (#326). This is a protocol
 * component, NOT a process or OS sandbox. A future runner must also cap the
 * bytes supplied by its pipe/transport and kill the child on timeout/failure.
 */
import { AnalysisProtocolError, MAX_ANALYSIS_FRAME_BYTES } from "./analysis-protocol.js";

/**
 * Read exactly one four-byte BE length + JSON frame. Never allocate a body
 * until the length is checked; never retain a chunk beyond the declared frame.
 * The source may supply arbitrarily large chunks: their allocation is owned
 * by the transport, not by this collector. The runner must bound that too.
 */
export async function collectAnalysisFrame(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const header = new Uint8Array(4);
  let headerBytes = 0;
  let expected = 0;
  let written = 0;
  let frame: Uint8Array | undefined;

  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new AnalysisProtocolError("FRAME_CHUNK");
    let offset = 0;
    if (headerBytes < 4) {
      const take = Math.min(4 - headerBytes, chunk.byteLength);
      header.set(chunk.subarray(0, take), headerBytes);
      headerBytes += take;
      offset += take;
      if (headerBytes === 4) {
        expected = new DataView(header.buffer).getUint32(0, false);
        if (expected === 0 || expected > MAX_ANALYSIS_FRAME_BYTES) {
          throw new AnalysisProtocolError("FRAME_LENGTH");
        }
        frame = new Uint8Array(expected + 4);
        frame.set(header);
      }
    }
    if (frame) {
      const remaining = expected - written;
      if (chunk.byteLength - offset > remaining) throw new AnalysisProtocolError("FRAME_TRAILING");
      frame.set(chunk.subarray(offset), 4 + written);
      written += chunk.byteLength - offset;
    }
  }
  if (!frame || written !== expected) throw new AnalysisProtocolError("FRAME_TRUNCATED");
  return frame;
}
