/**
 * Rust adapter module for core's worker-thread isolation (#90/#112); see
 * javascript-typescript.ts.
 */
import { createRustAdapter } from "@ghostdeps/rust";

export const adapter = createRustAdapter();
