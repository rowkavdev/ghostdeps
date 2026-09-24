/**
 * Go adapter module for core's worker-thread isolation (#90/#112); see
 * javascript-typescript.ts.
 */
import { createGoAdapter } from "@ghostdeps/go";

export const adapter = createGoAdapter();
