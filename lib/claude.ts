import Anthropic from '@anthropic-ai/sdk'

/**
 * Único punto de salida hacia Claude.
 *
 * Cada paso del motor pide un JSON con esquema: la API lo devuelve validado y el código no
 * tiene que adivinar formatos. Todo lo que puede salir mal (clave faltante, rechazo,
 * respuesta cortada) se convierte en un ErrorIa que dice qué pasó y qué hacer.
 */

export type Esfuerzo = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type VidaCache = '5m' | '1h'

export interface PedidoJson {
  /** Nombre del paso del motor. Va al registro de llamadas. */
  paso: string
  /** Bloques fijos del sistema, de lo más estable a lo menos. */
  sistema: string[]
  /** Lo que cambia en cada llamada: transcripción, respuesta nueva, material. */
  mensaje: string
  esquema: Record<string, unknown>
  /**
   * Vida de la caché del prefijo, o null para no cachear.
   *
   * El esquema forma parte del prefijo: cada paso tiene su propia caché. Escribirla cuesta más
   * que mandar el prefijo sin caché (1,25 veces con 5 minutos, 2 con una hora), así que solo
   * conviene en pasos que se repiten seguido. En la primera simulación, con caché de una hora
   * en todos los pasos, la escritura fue más de la mitad del costo.
   */
  cache: VidaCache | null
  esfuerzo: Esfuerzo
  maxTokens: number
}

export interface RegistroLlamada {
  paso: string
  modelo: string
  stopReason: string | null
  tokensEntrada: number
  tokensSalida: number
  tokensCacheEscritos: number
  tokensCacheLeidos: number
  /** Con qué vida se escribió la caché: cambia el precio de la escritura. */
  cache: VidaCache | null
  duracionMs: number
  error: string | null
}

export interface ClienteIa {
  modelo: string
  pedirJson<T>(pedido: PedidoJson): Promise<T>
}

export class ErrorIa extends Error {
  constructor(
    message: string,
    readonly causa: 'sin_clave' | 'rechazo' | 'cortada' | 'formato' | 'api',
  ) {
    super(message)
    this.name = 'ErrorIa'
  }
}

// Modelos donde la API puede reintentar sola en otro modelo si el pedido es rechazado.
const CON_REINTENTO_EN_OTRO_MODELO = new Set(['claude-opus-5', 'claude-fable-5-1'])

export function clienteClaude(
  registrar: (registro: RegistroLlamada) => Promise<void> | void = () => {},
  modelo = process.env.MODELO_IA || 'claude-opus-5',
): ClienteIa {
  let sdk: Anthropic | null = null

  return {
    modelo,
    async pedirJson<T>(pedido: PedidoJson): Promise<T> {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new ErrorIa(
          'Falta ANTHROPIC_API_KEY: sin la clave de Anthropic no se puede conducir el cuestionario. En local va en .env; en Easypanel, en las variables del servicio.',
          'sin_clave',
        )
      }
      sdk ??= new Anthropic()

      const parametros: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
        model: modelo,
        max_tokens: pedido.maxTokens,
        system: pedido.sistema.map((texto, i) => ({
          type: 'text',
          text: texto,
          ...(pedido.cache && i === pedido.sistema.length - 1 ? { cache_control: { type: 'ephemeral', ttl: pedido.cache } } : {}),
        })),
        messages: [{ role: 'user', content: pedido.mensaje }],
        output_config: { effort: pedido.esfuerzo, format: { type: 'json_schema', schema: pedido.esquema } },
      }
      if (CON_REINTENTO_EN_OTRO_MODELO.has(modelo)) {
        parametros.betas = ['server-side-fallback-2026-07-01']
        parametros.fallbacks = 'default'
      }

      const inicio = Date.now()
      const vacio = {
        paso: pedido.paso,
        modelo,
        tokensEntrada: 0,
        tokensSalida: 0,
        tokensCacheEscritos: 0,
        tokensCacheLeidos: 0,
        cache: pedido.cache,
      }

      let respuesta: Anthropic.Beta.BetaMessage
      try {
        respuesta = await sdk.beta.messages.create(parametros)
      } catch (err) {
        const detalle = err instanceof Error ? err.message : String(err)
        await registrar({ ...vacio, stopReason: null, duracionMs: Date.now() - inicio, error: detalle })
        if (err instanceof Anthropic.AuthenticationError) {
          throw new ErrorIa('Anthropic rechazó la clave: ANTHROPIC_API_KEY es inválida o fue revocada.', 'sin_clave')
        }
        throw new ErrorIa(`Falló la llamada a Claude en el paso ${pedido.paso}: ${detalle}`, 'api')
      }

      const registro: RegistroLlamada = {
        ...vacio,
        modelo: respuesta.model,
        stopReason: respuesta.stop_reason,
        tokensEntrada: respuesta.usage.input_tokens,
        tokensSalida: respuesta.usage.output_tokens,
        tokensCacheEscritos: respuesta.usage.cache_creation_input_tokens ?? 0,
        tokensCacheLeidos: respuesta.usage.cache_read_input_tokens ?? 0,
        duracionMs: Date.now() - inicio,
        error: null,
      }

      // Toda terminación que no sea end_turn se trata como error y queda registrada: un techo
      // de tokens sin detector deja respuestas vacías que parecen válidas.
      if (respuesta.stop_reason === 'refusal') {
        await registrar({ ...registro, error: 'rechazo' })
        throw new ErrorIa(`Claude no quiso responder el paso ${pedido.paso}.`, 'rechazo')
      }
      if (respuesta.stop_reason === 'max_tokens') {
        await registrar({ ...registro, error: 'cortada por max_tokens' })
        throw new ErrorIa(
          `La respuesta del paso ${pedido.paso} se cortó al llegar a ${pedido.maxTokens} tokens. Hay que subir el techo de ese paso.`,
          'cortada',
        )
      }

      const texto = respuesta.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      try {
        const datos = JSON.parse(texto) as T
        await registrar(registro)
        return datos
      } catch {
        await registrar({ ...registro, error: 'JSON inválido' })
        throw new ErrorIa(`El paso ${pedido.paso} no devolvió un JSON válido.`, 'formato')
      }
    },
  }
}
