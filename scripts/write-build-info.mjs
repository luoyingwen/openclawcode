import fs from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const packageJsonPath = path.join(packageRoot, "package.json");
const distDir = path.join(packageRoot, "dist");
const buildInfoPath = path.join(distDir, "build-info.json");

function formatUtcPlus8Timestamp(date) {
  const utcMillis = date.getTime();
  const utcPlus8Millis = utcMillis + 8 * 60 * 60 * 1000;
  const utcPlus8Date = new Date(utcPlus8Millis);

  const year = utcPlus8Date.getUTCFullYear();
  const month = String(utcPlus8Date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utcPlus8Date.getUTCDate()).padStart(2, "0");
  const hours = String(utcPlus8Date.getUTCHours()).padStart(2, "0");
  const minutes = String(utcPlus8Date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(utcPlus8Date.getUTCSeconds()).padStart(2, "0");
  const milliseconds = String(utcPlus8Date.getUTCMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}+08:00`;
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const buildInfo = {
  version: typeof packageJson.version === "string" ? packageJson.version : "0.0.0",
  builtAt: formatUtcPlus8Timestamp(new Date()),
};

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
