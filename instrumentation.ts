/**
 * Corre una vez al arrancar el servidor. Arranca el reintento automático de los avisos por mail
 * que no salieron: sin esto, un corte del SMTP justo al terminar un cuestionario dejaría a Mateo
 * sin los entregables y nadie se enteraría.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { iniciarReintentosDeAvisos } = await import('./lib/avisos')
  iniciarReintentosDeAvisos()
}
