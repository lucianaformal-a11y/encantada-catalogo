import fs from "node:fs";
import path from "node:path";

const packagePath = path.join(
  process.cwd(),
  "node_modules",
  "iconv-lite",
  "package.json"
);

if (!fs.existsSync(packagePath)) {
  console.log("iconv-lite não encontrado. Nada para corrigir.");
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

if (pkg.browser) {
  delete pkg.browser;
  fs.writeFileSync(
    packagePath,
    JSON.stringify(pkg, null, 2) + "\n"
  );
  console.log("Correção do iconv-lite aplicada.");
} else {
  console.log("iconv-lite já está sem configuração browser.");
}
