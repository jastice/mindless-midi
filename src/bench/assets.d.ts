/** esbuild's `file` loader turns these imports into hashed asset URLs. */
declare module "*.wasm" {
  const url: string;
  export default url;
}
