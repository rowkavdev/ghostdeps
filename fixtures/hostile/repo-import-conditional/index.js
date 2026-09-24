let native;
try {
  native = require("optional-native");
} catch {
  native = null;
}
if (process.env.USE_NATIVE) console.log(native);
