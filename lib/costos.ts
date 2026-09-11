import type { VidaCache } from './claude'

/*
 * Precios en dólares por millón de tokens, de la tabla de Anthropic de junio de 2026. Es una
 * estimación: escribir en la caché cuesta 1,25 veces la entrada con vida de 5 minutos y 2 veces
 * con vida de una hora; leer de ella, un décimo.
 */
const PRECIOS: Record<string, { entrada: number; salida: number }> = {
  'claude-opus-5': { entrada: 5, salida: 25 },
  'claude-opus-4-8': { entrada: 5, salida: 25 },
  'claude-sonnet-5': { entrada: 2, salida: 10 },
  'claude-haiku-4-5': { entrada: 1, salida: 5 },
}

export interface ConsumoLlamada {
  modelo: string
  cache: VidaCache | null
  tokensEntrada: number
  tokensSalida: number
  tokensCacheEscritos: number
  tokensCacheLeidos: number
}

export function costoEstimado(llamadas: ConsumoLlamada[]): number {
  return llamadas.reduce((total, r) => {
    // Un modelo que no está en la tabla se cuenta al precio de Opus: mejor sobrestimar.
    const precio = PRECIOS[r.modelo] ?? PRECIOS['claude-opus-5']
    const escritura = r.cache === '1h' ? 2 : 1.25
    const entrada = r.tokensEntrada + r.tokensCacheEscritos * escritura + r.tokensCacheLeidos * 0.1
    return total + (entrada * precio.entrada + r.tokensSalida * precio.salida) / 1_000_000
  }, 0)
}
