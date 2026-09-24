/**
 * @ghostdeps/python — ecosystem adapter for Python projects (pip, Poetry,
 * uv, Pipenv, PDM). ADR 0002 is the contract.
 */
export { createPythonAdapter } from "./adapter.js";
export {
  DETECTION_CONFIDENCE_THRESHOLD,
  PYTHON_ECOSYSTEM,
  detectPython,
  isRequirementsFile,
} from "./detect.js";
