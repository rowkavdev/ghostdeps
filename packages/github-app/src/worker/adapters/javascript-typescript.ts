/**
 * Adapter module for core's worker-thread isolation (#90/#112): the engine
 * imports this file inside a Worker and uses its `adapter` export, because
 * adapter objects cannot cross the thread boundary.
 */
import { createJavaScriptTypeScriptAdapter } from "@ghostdeps/javascript-typescript";

export const adapter = createJavaScriptTypeScriptAdapter();
