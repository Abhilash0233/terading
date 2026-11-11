import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const resolveTsExtension = {
  name: "resolve-ts-extension",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      if (!args.path.endsWith(".js")) return null;
      const base = path.resolve(args.resolveDir, args.path.slice(0, -3));
      for (const ext of [".ts", ".tsx"]) {
        const file = `${base}${ext}`;
        if (fs.existsSync(file)) return { path: file };
      }
      return null;
    });
  },
};

await esbuild.build({
  entryPoints: ["netlify/function-entry.ts"],
  outfile: "netlify/functions/api.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["express", "serverless-http"],
  plugins: [resolveTsExtension],
  logLevel: "info",
});
