import { Fragment, type ReactNode } from 'react'

/**
 * Muestra un texto del servidor respetando **negritas**, saltos de línea y párrafos.
 *
 * Arma elementos de React en lugar de usar dangerouslySetInnerHTML: lo que escribe Claude o lo
 * que pegó el cliente nunca se interpreta como HTML.
 */
export function TextoConNegritas({ texto, enLinea = false }: { texto: string; enLinea?: boolean }) {
  const parrafos = texto.replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n+/)

  if (enLinea) {
    // Dentro de un título o de una etiqueta no puede haber <p>: los párrafos van con saltos.
    return (
      <>
        {parrafos.map((parrafo, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <>
                <br />
                <br />
              </>
            )}
            {lineas(parrafo)}
          </Fragment>
        ))}
      </>
    )
  }

  return (
    <>
      {parrafos.map((parrafo, i) => (
        <p key={i}>{lineas(parrafo)}</p>
      ))}
    </>
  )
}

function lineas(parrafo: string): ReactNode {
  return parrafo.split('\n').map((linea, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {negritas(linea)}
    </Fragment>
  ))
}

function negritas(linea: string): ReactNode {
  // Con un grupo de captura, split deja en los índices impares lo que estaba entre ** y **. Un
  // ** sin cerrar no coincide y queda como texto común.
  return linea
    .split(/\*\*(.+?)\*\*/g)
    .map((parte, i) =>
      i % 2 === 1 ? <strong key={i}>{parte}</strong> : <Fragment key={i}>{parte}</Fragment>,
    )
}
