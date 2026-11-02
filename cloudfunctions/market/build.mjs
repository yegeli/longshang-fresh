import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
for(const [source,target] of [['public/model.js','model.cjs'],['public/storefront-data.js','storefront.cjs']]) {
  await build({entryPoints:[root+source],outfile:root+'cloudfunctions/market/lib/'+target,bundle:true,platform:'node',format:'cjs',target:'node18',minify:true,legalComments:'none',banner:{js:'// Generated from '+source+'; run node cloudfunctions/market/build.mjs.'}});
}
