/**
 * CSS Modules are compiled inside the client bundle and export their hashed
 * class map as the default export.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
