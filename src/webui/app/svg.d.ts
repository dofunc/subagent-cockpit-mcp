/** webpack inlines SVG files as data URIs */
declare module '*.svg' {
  const src: string
  export default src
}
