/**
 * Python adapter module for core's worker-thread isolation (#90/#112); see
 * javascript-typescript.ts.
 */
import { createPythonAdapter } from "@ghostdeps/python";

export const adapter = createPythonAdapter();
