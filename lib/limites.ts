/**
 * Los límites de lo que se sube. Sin imports: lo usan el navegador (para avisar antes de subir)
 * y el servidor (que es el que manda).
 */

// El proxy de Easypanel (Traefik) corta cualquier pedido cuyo cuerpo tarde más de 60 segundos en
// llegar. Por eso un archivo grande viaja en partes: ninguna tarda eso ni con mala señal.
/** Lo máximo que acepta el servidor por parte. */
export const TAMANO_PARTE = 1024 * 1024
/** Con esto arranca el navegador. Si las partes van rápido crece hasta TAMANO_PARTE; si van lento, baja. */
export const PARTE_INICIAL = 512 * 1024
/** A 100 kbit/s tarda unos 10 segundos: por debajo de esto, achicar más ya no ayuda. */
export const PARTE_MINIMA = 128 * 1024
/** Hasta acá el archivo va en un solo POST multipart. Más grande, por partes. */
export const UMBRAL_MULTIPART = 256 * 1024

/** Por archivo, incluido un .zip entero. */
export const LIMITE_BYTES_ARCHIVO = 200 * 1024 * 1024
/** Por cuestionario, contando lo que sale de los .zip. */
export const LIMITE_BYTES_CUESTIONARIO = 500 * 1024 * 1024
/** Por cuestionario, contados después de abrir los .zip. */
export const LIMITE_ARCHIVOS = 400

/** En puntos de código, no en unidades UTF-16: un emoji cuenta uno. */
export const LIMITE_LARGO_GRUPO = 120
export const LIMITE_LARGO_NOMBRE = 200
