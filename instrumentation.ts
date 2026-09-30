/**
 * Corre una vez al arrancar el servidor.
 *
 * - Arranca el reintento automático de los avisos por mail que no salieron: sin esto, un corte del
 *   SMTP justo al terminar un cuestionario dejaría a Mateo sin los entregables y nadie se enteraría.
 * - Arranca la limpieza de las subidas por partes que quedaron abandonadas.
 * - Prueba que se puedan escuchar audios. Si no, la app sigue andando y cada audio queda con su
 *   nota, pero Mateo se tiene que enterar ahora y no al final de un cuestionario.
 *
 * Todo lo que usa Node se importa adentro de `register`, después de controlar el runtime: Next
 * también compila este archivo para el runtime Edge, donde esos módulos no existen.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { iniciarReintentosDeAvisos } = await import('./lib/avisos')
  iniciarReintentosDeAvisos()
  const { iniciarLimpiezaDeSubidas } = await import('./lib/subidas')
  iniciarLimpiezaDeSubidas()

  const { estadoMultimedia, olvidarEstadoMultimedia, probarTranscriptor } = await import('./lib/multimedia')
  const { enviarCorreo, faltaParaCorreo } = await import('./lib/correo')

  const probarMultimedia = async (): Promise<void> => {
    const antes = await estadoMultimedia()
    const problemas = [antes.ffmpeg, antes.transcriptor, antes.modelo].filter((detalle) => detalle !== 'ok')
    // Si ya se sabe que falta el transcriptor o el modelo, lanzarlo solo repite el mismo error.
    if (antes.transcriptor === 'ok' && antes.modelo === 'ok') {
      const prueba = await probarTranscriptor()
      olvidarEstadoMultimedia()
      if (!prueba.ok) problemas.push(`El transcriptor no pasó la prueba de arranque: ${prueba.detalle}`)
    }
    if (!problemas.length) return

    const detalle = problemas.join(' · ')
    console.warn(`[multimedia] Los audios y videos van a quedar sin escuchar: ${detalle}. Mirá /api/salud.`)
    // En desarrollo es normal no tener el modelo bajado: el mail es para el servidor de verdad.
    const destino = process.env.MAIL_AVISO?.trim()
    if (process.env.NODE_ENV !== 'production' || !destino || faltaParaCorreo()) return
    await enviarCorreo({
      para: destino,
      asunto: 'Cuestionario: los audios y videos no se están pudiendo escuchar',
      cuerpo: `El servidor arrancó y no puede transcribir audios ni videos.

Qué pasa: ${detalle}

La app sigue andando: los cuestionarios se pueden completar, pero cada audio y cada video queda con la nota de que no se pudo escuchar, y eso no se recupera después.

Qué revisar: /api/salud, en «multimedia». Si el servidor tiene poca memoria, probá con MODELO_TRANSCRIPCION=whisper-base.
`,
    })
  }
  // En segundo plano: cargar el modelo tarda y el servidor no tiene que esperar para atender.
  probarMultimedia().catch((err) => console.warn('[multimedia] no se pudo hacer la prueba de arranque:', err))
}
