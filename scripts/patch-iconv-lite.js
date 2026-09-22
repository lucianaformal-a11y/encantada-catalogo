import fs from "node:fs";
import path from "node:path";

const iconvDir = path.join(
  process.cwd(),
  "node_modules",
  "iconv-lite"
);

const packagePath = path.join(iconvDir, "package.json");
const indexPath = path.join(iconvDir, "lib", "index.js");

if (!fs.existsSync(iconvDir)) {
  console.log("iconv-lite não encontrado.");
  process.exit(0);
}

// Remove o campo browser
if (fs.existsSync(packagePath)) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

  if (pkg.browser) {
    delete pkg.browser;
    fs.writeFileSync(
      packagePath,
      JSON.stringify(pkg, null, 2) + "\n"
    );
  }
}

// Impede o iconv-lite de carregar módulos Node incompatíveis
if (fs.existsSync(indexPath)) {
  let source = fs.readFileSync(indexPath, "utf8");

  source = source.replace(
    /^\s*require\(["']\.\/streams["']\)\(iconv\);\s*$/gm,
    "// Cloudflare Workers: streams desativado"
  );

  source = source.replace(
    /^\s*require\(["']\.\/extend-node["']\)\(iconv\);\s*$/gm,
    "// Cloudflare Workers: extend-node desativado"
  );

  fs.writeFileSync(indexPath, source);
}

console.log("Correção do iconv-lite aplicada para Cloudflare Workers.");
